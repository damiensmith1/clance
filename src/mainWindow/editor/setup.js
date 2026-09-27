// CodeMirror configuration for file tabs: languages, the theme, keys, and the
// change gutter. Everything CodeMirror comes from the one vendored bundle
// (scripts/build-codemirror.mjs); see docs/design.md's "Editor".

import {
  EditorView,
  EditorState,
  Compartment,
  Text,
  RangeSet,
  StateField,
  StateEffect,
  ViewPlugin,
  GutterMarker,
  gutter,
  Decoration,
  WidgetType,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  keymap,
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  search,
  searchKeymap,
  highlightSelectionMatches,
  gotoLine,
  getSearchQuery,
  findNext,
  findPrevious,
  closeBrackets,
  closeBracketsKeymap,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
  tags,
  Chunk,
  javascript,
  json,
  css,
  html,
  markdown,
  python,
  yaml,
  sql,
  rust,
  go,
  shell,
  toml,
  swift,
  dockerFile,
  properties,
  ruby,
  lua,
  diff,
  c,
  cpp,
  java,
  kotlin,
  csharp,
  scala,
  nginx,
  xml,
} from "../../shared/vendor/codemirror.mjs";
import { requestFind, closeFindFor } from "./findBar.js";

// ---- languages ----

const stream = (mode) => () => StreamLanguage.define(mode);

// A file's language, from its extension (git.ts's `languageOf`: lowercased,
// no dot, or the whole name for Dockerfile / Makefile).
const LANGUAGES = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  jsonc: () => json(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  html: () => html(),
  htm: () => html(),
  vue: () => html(),
  svelte: () => html(),
  md: () => markdown(),
  markdown: () => markdown(),
  mdx: () => markdown(),
  py: () => python(),
  yml: () => yaml(),
  yaml: () => yaml(),
  sql: () => sql(),
  rs: () => rust(),
  go: () => go(),
  sh: stream(shell),
  bash: stream(shell),
  zsh: stream(shell),
  fish: stream(shell),
  toml: stream(toml),
  swift: stream(swift),
  dockerfile: stream(dockerFile),
  env: stream(properties),
  properties: stream(properties),
  ini: stream(properties),
  conf: stream(properties),
  rb: stream(ruby),
  lua: stream(lua),
  diff: stream(diff),
  patch: stream(diff),
  c: stream(c),
  h: stream(c),
  cpp: stream(cpp),
  cc: stream(cpp),
  hpp: stream(cpp),
  java: stream(java),
  kt: stream(kotlin),
  kts: stream(kotlin),
  cs: stream(csharp),
  scala: stream(scala),
  xml: stream(xml),
  svg: stream(xml),
  plist: stream(xml),
};

/** The language support for a file, by its name. Plain text when unknown. */
export function languageFor(path) {
  const name = path.split("/").pop() ?? "";
  // `.env`, `.env.local`, `production.env` all read as env files.
  if (/^\.env(\..*)?$/.test(name) || name.endsWith(".env")) return LANGUAGES.env();
  if (/^dockerfile/i.test(name)) return LANGUAGES.dockerfile();
  if (/^nginx.*\.conf$/.test(name)) return StreamLanguage.define(nginx);
  if (/^\.(zshrc|bashrc|bash_profile|profile|zprofile)$/.test(name)) return LANGUAGES.sh();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return LANGUAGES[ext]?.() ?? [];
}

// ---- theme ----

// Written against theme.css's custom properties, so the editor reads like the
// rest of the window. Font size is the one per-editor value, set as a CSS
// variable on the tab's container from the editor settings.
export const clanceTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text-primary)",
    backgroundColor: "var(--app-bg)",
    fontSize: "var(--editor-font-size, var(--text-md))",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.6",
  },
  ".cm-content": { caretColor: "var(--text-primary)", padding: "var(--space-2) 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--surface-active)",
  },
  ".cm-activeLine": { backgroundColor: "var(--surface-hover)" },
  ".cm-gutters": {
    backgroundColor: "var(--app-bg)",
    color: "var(--text-tertiary)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-secondary)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--space-2) 0 var(--space-3)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--text-tertiary)", cursor: "pointer" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "1px solid var(--divider-strong)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--warning-bg)" },
  ".cm-searchMatch": { backgroundColor: "var(--warning-bg)", outline: "1px solid var(--warning)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--signal-soft)" },
  ".cm-clance-find-stand-in": { display: "none" },
  ".cm-panels-top:has(> .cm-clance-find-stand-in:only-child)": { display: "none" },
  ".cm-panels": { backgroundColor: "var(--surface-bg)", color: "var(--text-primary)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--surface-border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--surface-border)" },
  ".cm-panel.cm-search": { fontFamily: "var(--font-sans)", padding: "var(--space-2) var(--space-3)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-gotoLine input": {
    fontFamily: "var(--font-sans)",
  },
  ".cm-textfield": {
    border: "1px solid var(--surface-border)",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--surface-card)",
    padding: "2px 6px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--surface-card)",
    border: "1px solid var(--surface-border)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-card)",
    border: "none",
    boxShadow: "var(--shadow-menu)",
    borderRadius: "var(--radius-md)",
  },
  // Diff view (the unified merge view): the same tints the Changes pane uses.
  ".cm-changedLine": { backgroundColor: "var(--diff-add-bg)" },
  ".cm-changedText": { background: "none", backgroundColor: "var(--diff-add-bg)" },
  ".cm-deletedChunk": { backgroundColor: "var(--diff-del-bg)" },
  ".cm-deletedChunk del": { textDecoration: "none" },
  ".cm-insertedLine": { backgroundColor: "var(--diff-add-bg)" },
  ".cm-deletedLine": { backgroundColor: "var(--diff-del-bg)" },
  ".cm-changeGutter": { width: "3px", marginRight: "var(--space-1)" },
  ".cm-changedLineGutter": { backgroundColor: "var(--diff-add-mark)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--diff-del-mark)" },
  // The Clean view's change gutter (below).
  ".cm-clance-masked": { color: "var(--text-tertiary)", letterSpacing: "1px" },
  ".cm-clance-changes": { width: "3px", marginRight: "var(--space-1)" },
  ".cm-clance-change-add": { backgroundColor: "var(--diff-add-mark)", height: "100%" },
  ".cm-clance-change-mod": { backgroundColor: "var(--tok-number)", height: "100%" },
  ".cm-clance-change-del": {
    height: "100%",
    background: "linear-gradient(to bottom, var(--diff-del-mark) 0 3px, transparent 3px)",
  },
});

// Lezer's tags onto the same --tok-* colours syntax.js uses, so code looks the
// same in an editor, a Diff, and a markdown code block.
export const clanceHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword], color: "var(--tok-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.attributeValue], color: "var(--tok-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--tok-number)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.className, tags.typeName, tags.tagName], color: "var(--tok-call)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation], color: "var(--tok-comment)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--text-primary)" },
  { tag: tags.heading, color: "var(--tok-keyword)", fontWeight: "var(--weight-semibold)" },
  { tag: tags.strong, fontWeight: "var(--weight-semibold)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--tok-number)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--tok-number)" },
  { tag: tags.inserted, color: "var(--diff-add-mark)" },
  { tag: tags.deleted, color: "var(--diff-del-mark)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

// ---- indentation ----

/**
 * The file's own indentation: a tab if lines start with tabs, otherwise the
 * smallest common step of leading spaces. Null if the file doesn't say.
 */
export function detectIndent(text) {
  let tabs = 0;
  const widths = new Map();
  let previous = 0;
  const lines = text.split("\n", 2000);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("\t")) {
      tabs += 1;
      continue;
    }
    const spaces = line.match(/^ */)[0].length;
    const step = Math.abs(spaces - previous);
    if (step >= 2 && step <= 8) widths.set(step, (widths.get(step) ?? 0) + 1);
    previous = spaces;
  }
  const spaced = [...widths.values()].reduce((a, b) => a + b, 0);
  if (tabs > spaced && tabs > 0) return "\t";
  if (spaced === 0) return null;
  const [best] = [...widths.entries()].sort((a, b) => b[1] - a[1])[0];
  return " ".repeat(best);
}

// ---- the Clean view's change gutter ----
//
// Lines changed since the last commit, marked in the gutter while editing:
// added lines, modified lines, and a notch where lines were deleted. The Diff
// view shows the same comparison in full; this is its glanceable form.

const setOriginal = StateEffect.define();
const setMarks = StateEffect.define();

class ChangeMarker extends GutterMarker {
  constructor(kind) {
    super();
    this.kind = kind;
  }
  eq(other) {
    return other.kind === this.kind;
  }
  toDOM() {
    const element = document.createElement("div");
    element.className = `cm-clance-change-${this.kind}`;
    return element;
  }
}
const MARKERS = { add: new ChangeMarker("add"), mod: new ChangeMarker("mod"), del: new ChangeMarker("del") };

function computeMarks(original, doc) {
  const chunks = Chunk.build(original, doc, { scanLimit: 2000 });
  const ranges = [];
  for (const chunk of chunks) {
    if (chunk.fromB === chunk.toB) {
      // A pure deletion: notch the line the deleted text sat before.
      const pos = Math.min(chunk.fromB, doc.length);
      ranges.push(MARKERS.del.range(doc.lineAt(pos).from));
      continue;
    }
    const kind = chunk.fromA === chunk.toA ? "add" : "mod";
    const end = Math.max(chunk.fromB, Math.min(chunk.toB, doc.length) - 1);
    for (let pos = chunk.fromB; pos <= end; ) {
      const line = doc.lineAt(pos);
      ranges.push(MARKERS[kind].range(line.from));
      pos = line.to + 1;
    }
  }
  return RangeSet.of(ranges, true);
}

const changeState = StateField.define({
  create: () => ({ original: null, marks: RangeSet.empty }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setOriginal)) next = { ...next, original: effect.value };
      if (effect.is(setMarks)) next = { ...next, marks: effect.value };
    }
    if (transaction.docChanged && next === value) next = { ...next, marks: next.marks.map(transaction.changes) };
    return next;
  },
});

// Recomputing the diff on every keystroke is wasted work while someone is
// typing, so it waits for a pause.
const recompute = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.schedule(0);
    }
    update(update) {
      if (update.docChanged || update.transactions.some((t) => t.effects.some((e) => e.is(setOriginal)))) this.schedule(250);
    }
    schedule(delay) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const { original } = this.view.state.field(changeState);
        const marks = original ? computeMarks(original, this.view.state.doc) : RangeSet.empty;
        this.view.dispatch({ effects: setMarks.of(marks) });
      }, delay);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  }
);

/** Gutter marks against `original` (a string), or nothing when null. */
export function changeGutter(original) {
  if (original === null) return [];
  return [
    changeState.init(() => ({ original: Text.of(original.split("\n")), marks: RangeSet.empty })),
    recompute,
    gutter({ class: "cm-clance-changes", markers: (view) => view.state.field(changeState).marks }),
  ];
}

// ---- the base set ----

export const compartments = {
  language: new Compartment(),
  mode: new Compartment(),
  readOnly: new Compartment(),
  wrap: new Compartment(),
  indent: new Compartment(),
  // A handler's own extensions (the .env handler's masking).
  handler: new Compartment(),
};

// ---- .env masking ----
//
// Draws every value in a KEY=value file as dots, for screen sharing. A
// decoration only: the text underneath — what's copied and what's saved — is
// untouched.

class MaskWidget extends WidgetType {
  constructor(length) {
    super();
    this.length = length;
  }
  eq(other) {
    return other.length === this.length;
  }
  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-clance-masked";
    element.textContent = "•".repeat(Math.min(this.length, 24));
    return element;
  }
}

const ENV_LINE = /^(\s*(?:export\s+)?[\w.-]+\s*[=:]\s*)(\S.*)$/;

function maskDecorations(view) {
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const match = line.text.match(ENV_LINE);
      if (match && !line.text.trim().startsWith("#")) {
        const start = line.from + match[1].length;
        ranges.push(Decoration.replace({ widget: new MaskWidget(match[2].length) }).range(start, line.to));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges);
}

export const maskValues = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = maskDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) this.decorations = maskDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

export function readOnlyExtension(readOnly) {
  return [EditorState.readOnly.of(readOnly)];
}

export function wrapExtension(wrap) {
  return wrap ? EditorView.lineWrapping : [];
}

export function indentExtension(unit) {
  return [indentUnit.of(unit), EditorState.tabSize.of(unit === "\t" ? 4 : unit.length)];
}

/**
 * Everything an editor has regardless of file: the keys (VS Code's, where
 * CodeMirror's differ), history, search, brackets, folding. `commands`
 * carries the ones the tab supplies (toggle wrap).
 */
function findPanelStandIn() {
  const dom = document.createElement("div");
  dom.className = "cm-clance-find-stand-in";
  return { dom, top: true };
}

/** ⌘G: the next match of the find bar's query, or open the bar if it has none. */
function findOr(command) {
  return (view) => (getSearchQuery(view.state).valid ? command(view) : requestFind(view));
}

export function baseExtensions({ onToggleWrap } = {}) {
  return [
    lineNumbers(),
    foldGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // The search state and its match highlights. The find bar itself is
    // Clance's (editor/findBar.js); CodeMirror only highlights matches while
    // its panel is open, so the bar opens this empty, hidden one alongside.
    search({ top: true, createPanel: findPanelStandIn }),
    syntaxHighlighting(clanceHighlight),
    clanceTheme,
    keymap.of([
      { key: "Ctrl-g", run: gotoLine },
      { key: "Mod-f", run: (view) => requestFind(view), preventDefault: true },
      { key: "Mod-Alt-f", run: (view) => requestFind(view, true), preventDefault: true },
      { key: "Mod-g", run: findOr(findNext), shift: findOr(findPrevious), preventDefault: true },
      { key: "F3", run: findOr(findNext), shift: findOr(findPrevious), preventDefault: true },
      { key: "Escape", run: closeFindFor },
      { key: "Alt-z", run: () => (onToggleWrap?.(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      // CodeMirror's search keys, less the ones that open its own panel
      // (taken above).
      ...searchKeymap.filter((binding) => !["Mod-f", "Mod-g", "F3", "Escape"].includes(binding.key)),
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
  ];
}

export { EditorView, EditorState };
