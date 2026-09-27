// Open documents, one per file, kept outside Preact so a tab switch, a move
// between panes or a split never loses unsaved edits or undo history — the
// same trick TerminalSection.js's registry plays for a live terminal. A
// buffer lives from the first time its file tab renders until the tab is
// closed (Shell.js calls `release`).
//
// This is also where the disk and the editor meet: a buffer remembers the
// hash it was loaded (or last saved) at, so a save that would overwrite a
// version nobody has seen becomes a conflict instead, and a change on disk
// under unsaved edits asks rather than reloading. See docs/design.md's
// "Disk changes".

import {
  EditorView,
  EditorState,
  Text,
  Transaction,
  unifiedMergeView,
  presentableDiff,
} from "../../shared/vendor/codemirror.mjs";
import {
  baseExtensions,
  compartments,
  languageFor,
  changeGutter,
  readOnlyExtension,
  wrapExtension,
  indentExtension,
  detectIndent,
} from "./setup.js";

const buffers = new Map();
const dirtyListeners = new Set();

// Filled from the main process (config.ts owns the defaults).
let config = { tabSize: 2, wrap: false };

function keyOf(root, path) {
  return `${root}\0${path}`;
}

function textOf(string) {
  return Text.of(string.split("\n"));
}

function notify(buffer) {
  buffer.version += 1;
  for (const listener of buffer.listeners) listener(buffer);
}

function notifyDirty() {
  for (const listener of dirtyListeners) listener();
}

// ---- editor settings ----

function applyFontSize() {
  if (config.fontSize) document.documentElement.style.setProperty("--editor-font-size", `${config.fontSize}px`);
}

export async function loadEditorConfig() {
  try {
    config = { ...config, ...(await window.clanceApp.editorGetConfig()) };
  } catch {
    // Defaults.
  }
  applyFontSize();
  return config;
}

export function getEditorConfig() {
  return config;
}

export async function updateEditorConfig(patch) {
  config = { ...config, ...(await window.clanceApp.editorSetConfig(patch)) };
  applyFontSize();
  for (const buffer of buffers.values()) {
    buffer.view?.dispatch({ effects: compartments.wrap.reconfigure(wrapExtension(config.wrap)) });
  }
  return config;
}

// ---- the view ----

function isEditable(buffer) {
  return buffer.doc?.kind === "text" && !buffer.doc.readOnly && buffer.mode === "clean";
}

function modeExtension(buffer) {
  const head = buffer.doc?.kind === "text" ? buffer.doc.head : null;
  if (buffer.mode === "diff" && head !== null) {
    return unifiedMergeView({ original: head, mergeControls: false, gutter: true, syntaxHighlightDeletions: true });
  }
  return changeGutter(head);
}

function createView(buffer, text) {
  const indent = detectIndent(text) ?? " ".repeat(config.tabSize);
  const state = EditorState.create({
    doc: text,
    extensions: [
      baseExtensions({ onToggleWrap: () => updateEditorConfig({ wrap: !config.wrap }) }),
      compartments.language.of(languageFor(buffer.path)),
      compartments.mode.of(modeExtension(buffer)),
      compartments.readOnly.of(readOnlyExtension(!isEditable(buffer))),
      compartments.wrap.of(wrapExtension(config.wrap)),
      compartments.indent.of(indentExtension(indent)),
      compartments.handler.of([]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        for (const listener of buffer.contentListeners) listener(buffer);
        const dirty = !update.state.doc.eq(buffer.savedText);
        if (dirty !== buffer.dirty) {
          buffer.dirty = dirty;
          notify(buffer);
          notifyDirty();
        }
      }),
    ],
  });
  buffer.view = new EditorView({ state });
}

function reconfigure(buffer) {
  buffer.view?.dispatch({
    effects: [
      compartments.mode.reconfigure(modeExtension(buffer)),
      compartments.readOnly.reconfigure(readOnlyExtension(!isEditable(buffer))),
    ],
  });
}

/**
 * Replaces the editor's text with `next` as the smallest set of changes,
 * rather than a whole new document, so the cursor, selection and scroll
 * position map through it. Kept out of undo history: undoing shouldn't put
 * back a version someone else wrote over.
 */
function applyExternal(buffer, next) {
  const view = buffer.view;
  if (!view) return;
  const current = view.state.doc.toString();
  if (current === next) return;
  const changes = presentableDiff(current, next).map((change) => ({
    from: change.fromA,
    to: change.toA,
    insert: next.slice(change.fromB, change.toB),
  }));
  view.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
}

// ---- loading ----

async function load(buffer) {
  const doc = await window.clanceApp.docRead(buffer.root, buffer.path, buffer.asText);
  buffer.loading = false;
  if (!doc) {
    buffer.doc = null;
    buffer.error = "That file isn't there any more.";
    notify(buffer);
    return;
  }
  buffer.error = null;
  if (doc.kind === "text") {
    buffer.doc = doc;
    buffer.baseHash = doc.hash;
    buffer.savedText = textOf(doc.text);
    createView(buffer, doc.text);
  } else if (doc.kind === "missing" && doc.head !== null) {
    // Shown read-only: what git last had.
    buffer.doc = doc;
    buffer.savedText = textOf(doc.head);
    buffer.mode = "clean";
    createView(buffer, doc.head);
  } else {
    buffer.doc = doc;
  }
  notify(buffer);
}

/** Re-reads after a change on disk, deciding what that means for the buffer. */
async function refresh(buffer) {
  if (buffer.loading || buffer.saving) return;
  const doc = await window.clanceApp.docRead(buffer.root, buffer.path, buffer.asText);
  if (!buffers.has(buffer.key)) return;

  if (!doc || doc.kind === "missing") {
    // Deleted under the tab. Keep what's in the editor; saving puts it back.
    if (buffer.doc?.kind === "text" && !buffer.deleted) {
      buffer.deleted = true;
      buffer.baseHash = null;
      notify(buffer);
    }
    return;
  }
  if (doc.kind !== "text" || buffer.doc?.kind !== "text") {
    if (!buffer.view) {
      buffer.doc = doc;
      notify(buffer);
    }
    return;
  }

  const headChanged = doc.head !== buffer.doc.head;
  const wasDeleted = buffer.deleted;
  buffer.deleted = false;
  buffer.doc = { ...doc, text: undefined };

  if (doc.hash === buffer.baseHash) {
    if (headChanged) reconfigure(buffer);
    if (headChanged || wasDeleted) notify(buffer);
    return;
  }
  if (!buffer.dirty) {
    buffer.baseHash = doc.hash;
    buffer.savedText = textOf(doc.text);
    applyExternal(buffer, doc.text);
    if (headChanged) reconfigure(buffer);
    notify(buffer);
    return;
  }
  // Unsaved edits and a different file on disk: nothing is reloaded or
  // overwritten until the person chooses.
  buffer.conflict = { diskText: doc.text, diskHash: doc.hash };
  if (headChanged) reconfigure(buffer);
  notify(buffer);
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.clanceApp.onDocChanged(({ root, path }) => {
    const buffer = buffers.get(keyOf(root, path));
    if (buffer) refresh(buffer);
  });
  window.clanceApp.onDocHeadChanged(({ root }) => {
    for (const buffer of buffers.values()) if (buffer.root === root) refresh(buffer);
  });
}

// ---- public API ----

/** The buffer for a file, loading it the first time it's asked for. */
export function acquire(root, path) {
  listen();
  const key = keyOf(root, path);
  let buffer = buffers.get(key);
  if (buffer) return buffer;
  buffer = {
    key,
    root,
    path,
    name: path.split("/").pop(),
    doc: null,
    error: null,
    loading: true,
    saving: false,
    view: null,
    baseHash: null,
    savedText: Text.empty,
    dirty: false,
    deleted: false,
    conflict: null,
    saveError: null,
    mode: "clean",
    version: 0,
    listeners: new Set(),
    contentListeners: new Set(),
    asText: false,
  };
  buffers.set(key, buffer);
  window.clanceApp.docWatch(root, path);
  load(buffer);
  return buffer;
}

/** Reopens a file the fallback couldn't show as read-only text. */
export function openAsText(buffer) {
  buffer.asText = true;
  buffer.loading = true;
  buffer.view?.destroy();
  buffer.view = null;
  notify(buffer);
  load(buffer);
}

/**
 * Puts the cursor on `line` and scrolls it into view — a search result, a
 * reference. Kept until the editor is on screen (EditorPane applies it), since
 * an editor that isn't in the page can't scroll.
 */
export function revealLine(buffer, line) {
  buffer.pendingLine = line;
  buffer.wantsSource = true;
  notify(buffer);
  if (buffer.view?.dom.isConnected) applyPendingLine(buffer);
}

export function applyPendingLine(buffer) {
  const view = buffer.view;
  if (!view || !buffer.pendingLine) return;
  const number = Math.min(Math.max(1, buffer.pendingLine), view.state.doc.lines);
  buffer.pendingLine = null;
  const line = view.state.doc.line(number);
  view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  view.focus();
}

export function peek(root, path) {
  return buffers.get(keyOf(root, path)) ?? null;
}

/** Closes a buffer for good: its tab has been closed. */
export function release(root, path) {
  const key = keyOf(root, path);
  const buffer = buffers.get(key);
  if (!buffer) return;
  buffer.view?.destroy();
  buffers.delete(key);
  window.clanceApp.docUnwatch(root, path);
  if (buffer.dirty) notifyDirty();
}

/** Moves a buffer to a new path after a rename or move, keeping its edits. */
export function rekey(root, fromPath, toRoot, toPath) {
  const buffer = buffers.get(keyOf(root, fromPath));
  if (!buffer) return;
  window.clanceApp.docUnwatch(root, fromPath);
  buffers.delete(buffer.key);
  buffer.root = toRoot;
  buffer.path = toPath;
  buffer.name = toPath.split("/").pop();
  buffer.key = keyOf(toRoot, toPath);
  buffers.set(buffer.key, buffer);
  window.clanceApp.docWatch(toRoot, toPath);
  buffer.view?.dispatch({ effects: compartments.language.reconfigure(languageFor(toPath)) });
  notify(buffer);
}

export function subscribe(buffer, listener) {
  buffer.listeners.add(listener);
  return () => buffer.listeners.delete(listener);
}

export function onContent(buffer, listener) {
  buffer.contentListeners.add(listener);
  return () => buffer.contentListeners.delete(listener);
}

export function onDirtyChange(listener) {
  dirtyListeners.add(listener);
  return () => dirtyListeners.delete(listener);
}

export function isDirty(root, path) {
  return buffers.get(keyOf(root, path))?.dirty ?? false;
}

export function dirtyBuffers() {
  return [...buffers.values()].filter((buffer) => buffer.dirty);
}

export function textOfBuffer(buffer) {
  return buffer.view ? buffer.view.state.doc.toString() : buffer.doc?.kind === "text" ? buffer.doc.text : "";
}

/** A handler's own extensions, swapped in and out as its options change. */
export function setHandlerExtensions(buffer, extensions) {
  buffer.view?.dispatch({ effects: compartments.handler.reconfigure(extensions) });
}

export function setMode(buffer, mode) {
  if (buffer.mode === mode) return;
  buffer.mode = mode;
  reconfigure(buffer);
  notify(buffer);
}

/**
 * Saves a buffer. Resolves "saved", "conflict" (the file changed on disk
 * since it was read — the banner takes over), or "failed".
 */
export async function save(buffer, { force = false } = {}) {
  if (!buffer.view || buffer.doc?.kind !== "text" || buffer.doc.readOnly) return "failed";
  const text = buffer.view.state.doc.toString();
  const savedDoc = buffer.view.state.doc;
  buffer.saving = true;
  const result = await window.clanceApp.docSave(buffer.root, buffer.path, text, {
    eol: buffer.doc.eol,
    bom: buffer.doc.bom,
    baseHash: buffer.deleted ? null : buffer.baseHash,
    force,
  });
  buffer.saving = false;
  if (result.ok) {
    buffer.baseHash = result.hash;
    buffer.savedText = savedDoc;
    buffer.dirty = !buffer.view.state.doc.eq(savedDoc);
    buffer.conflict = null;
    buffer.deleted = false;
    buffer.saveError = null;
    notify(buffer);
    notifyDirty();
    return "saved";
  }
  if (result.conflict) {
    buffer.conflict = { diskText: result.diskText, diskHash: result.diskHash };
    notify(buffer);
    return "conflict";
  }
  buffer.saveError = result.error;
  notify(buffer);
  return "failed";
}

export async function saveAll() {
  const results = await Promise.all(dirtyBuffers().map((buffer) => save(buffer)));
  return results.every((result) => result === "saved");
}

/** Keep mine: the next save overwrites the disk version, deliberately. */
export function keepMine(buffer) {
  if (!buffer.conflict) return;
  buffer.baseHash = buffer.conflict.diskHash;
  buffer.savedText = textOf(buffer.conflict.diskText);
  buffer.conflict = null;
  notify(buffer);
}

/** Take theirs: the buffer becomes what's on disk, edits discarded. */
export function takeTheirs(buffer) {
  if (!buffer.conflict) return;
  const { diskText, diskHash } = buffer.conflict;
  buffer.conflict = null;
  buffer.baseHash = diskHash;
  buffer.savedText = textOf(diskText);
  applyExternal(buffer, diskText);
  buffer.dirty = false;
  notify(buffer);
  notifyDirty();
}

/** Compare, finished: `merged` becomes the buffer, measured against disk. */
export function resolveCompare(buffer, merged) {
  if (!buffer.conflict) return;
  const { diskText, diskHash } = buffer.conflict;
  buffer.conflict = null;
  buffer.baseHash = diskHash;
  buffer.savedText = textOf(diskText);
  const view = buffer.view;
  view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: merged } });
  buffer.dirty = view ? !view.state.doc.eq(buffer.savedText) : false;
  notify(buffer);
  notifyDirty();
}

/** Discards unsaved edits, back to the last saved text. */
export function revert(buffer) {
  if (!buffer.view) return;
  applyExternal(buffer, buffer.savedText.toString());
  buffer.dirty = false;
  notify(buffer);
  notifyDirty();
}
