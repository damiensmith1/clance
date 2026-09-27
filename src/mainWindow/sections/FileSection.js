import { html, useEffect, useMemo, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Chunk, Text, goToNextChunk, goToPreviousChunk } from "../../shared/vendor/codemirror.mjs";
import { acquire, subscribe, setMode, setViewId as rememberViewId, keepMine, takeTheirs } from "../editor/buffers.js";
import { CompareView } from "../editor/views.js";
import { pickHandler } from "../handlers/index.js";
import { useTabId, useTabState, readTabState, writeTabState } from "../state/tabState.js";
import { FindBar, DEFAULT_FIND, onFindRequest } from "../editor/findBar.js";

// A file tab: the file, in whichever view its handler offers, editable where
// it can be. The document itself — text, undo history, whether it's saved —
// lives in editor/buffers.js, so this component can come and go (tab
// switches, pane moves) without losing anything. See docs/design.md's
// "Editor".

/** Added and removed lines since the last commit, for the header. */
function countChanges(buffer) {
  const head = buffer.doc?.kind === "text" ? buffer.doc.head : null;
  if (head === null || !buffer.view) return null;
  const a = Text.of(head.split("\n"));
  const b = buffer.view.state.doc;
  const chunks = Chunk.build(a, b, { scanLimit: 2000 });
  let insertions = 0;
  let deletions = 0;
  for (const chunk of chunks) {
    if (chunk.toB > chunk.fromB) insertions += b.lineAt(Math.max(chunk.fromB, chunk.toB - 1)).number - b.lineAt(chunk.fromB).number + 1;
    if (chunk.toA > chunk.fromA) deletions += a.lineAt(Math.max(chunk.fromA, chunk.toA - 1)).number - a.lineAt(chunk.fromA).number + 1;
  }
  return { insertions, deletions, chunks: chunks.length };
}

/** A choice between a handler's views, as a segmented pill. */
function ViewChoice({ views, current, onChoose }) {
  return html`
    <span class="segmented" role="tablist">
      ${views.map(
        (view) => html`
          <button
            key=${view.id}
            class="segmented-item ${view.id === current ? "segmented-item-active" : ""}"
            role="tab"
            aria-selected=${view.id === current}
            onClick=${() => onChoose(view.id)}
          >
            ${view.label}
          </button>
        `
      )}
    </span>
  `;
}

function Banner({ tone = "warning", children }) {
  return html`<div class="file-banner file-banner-${tone}" role="status">${children}</div>`;
}

export function FileSection({ repoRoot, path, onOpenFile }) {
  // Where this tab was left — scroll, cursor, view, Edit or Diff — is the
  // tab's persisted `view` state (state/tabState.js): it seeds a new buffer
  // (after a relaunch, or ⇧⌘T), and the buffer reports every change back.
  const tabId = useTabId();
  const buffer = acquire(repoRoot, path, tabId ? readTabState(tabId, "view", null) : null);
  buffer.ui.report = tabId ? (view) => writeTabState(tabId, "view", view, { persist: true }) : null;
  const [, rerender] = useState(0);
  // Which view the tab is on lives with the buffer, so switching away and
  // back (which remounts this component) keeps it.
  const [viewId, setViewIdState] = useState(buffer.ui.viewId);
  const setViewId = (id) => {
    setViewIdState(id);
    rememberViewId(buffer, id);
  };
  const [comparing, setComparing] = useState(false);
  // The find bar (editor/findBar.js): open or not, and what it's looking
  // for, kept while the tab moves or is switched away from.
  const [findOpen, setFindOpen] = useTabState("find.open", false);
  const [find, setFind] = useTabState("find", DEFAULT_FIND);
  const [findFocus, setFindFocus] = useState(0);

  useEffect(() => {
    const stop = subscribe(buffer, () => rerender((n) => n + 1));
    // The buffer may have finished loading between render and subscribing.
    rerender((n) => n + 1);
    return stop;
  }, [buffer]);
  // A different file comes back on the view it was left on, or its handler's
  // default.
  useEffect(() => {
    setViewIdState(buffer.ui.viewId);
    setComparing(false);
  }, [repoRoot, path]);
  useEffect(() => {
    if (!buffer.conflict) setComparing(false);
  }, [buffer.conflict]);

  // ⌘F / ⌥⌘F / Esc in this tab's editor.
  useEffect(() => {
    if (!buffer.view) return;
    return onFindRequest(buffer.view, ({ replace, close }) => {
      if (close) {
        closeFind();
        return;
      }
      // A selection on one line is what to look for, as in VS Code.
      const { state } = buffer.view;
      const selected = state.sliceDoc(state.selection.main.from, state.selection.main.to);
      const seed = selected && !selected.includes("\n") ? { query: selected } : {};
      setFind((current) => ({ ...current, ...seed, ...(replace ? { showReplace: true } : {}) }));
      setFindOpen(true);
      setFindFocus((n) => n + 1);
    });
  }, [buffer, buffer.view]);

  function closeFind() {
    setFindOpen(false);
    buffer.view?.focus();
  }

  const handler = pickHandler(buffer);
  // A search result or reference asked for a line: that's in the source.
  useEffect(() => {
    if (buffer.wantsSource && handler.views.some((view) => view.id === "source")) {
      buffer.wantsSource = false;
      setViewId("source");
    }
  });
  const current =
    handler.views.find((view) => view.id === viewId) ??
    handler.views.find((view) => view.id === handler.defaultView) ??
    handler.views[0];
  const counts = useMemo(() => countChanges(buffer), [buffer, buffer.version, buffer.view, buffer.mode]);

  if (buffer.loading) {
    return html`<div class="file-section"><div class="file-empty"><p>Reading ${path}…</p></div></div>`;
  }
  if (buffer.error) {
    return html`<div class="file-section"><div class="file-empty"><p>${buffer.error}</p></div></div>`;
  }
  if (comparing && buffer.conflict) {
    return html`<div class="file-section"><${CompareView} buffer=${buffer} onClose=${() => setComparing(false)} /></div>`;
  }

  const doc = buffer.doc;
  const isSource = current.id === "source";
  const hasHead = doc?.kind === "text" && doc.head !== null;
  const changed = counts && (counts.insertions > 0 || counts.deletions > 0);
  const diffing = buffer.mode === "diff";
  const Actions = handler.Actions;
  const Body = current.render;

  function jump(direction) {
    if (!buffer.view) return;
    (direction > 0 ? goToNextChunk : goToPreviousChunk)(buffer.view);
    buffer.view.focus();
  }

  return html`
    <div class="file-section">
      <header class="file-head">
        <span class="file-path" title=${path}>${path}</span>
        ${buffer.dirty && html`<span class="file-dirty" title="Unsaved changes">edited</span>`}
        ${doc?.kind === "missing"
          ? html`<span class="file-unchanged">${doc.reason}</span>`
          : doc?.readOnly
            ? html`<span class="file-unchanged">${doc.readOnly}</span>`
            : hasHead && doc.head === "" && !diffing
              ? html`<span class="file-counts"><span class="change-ins">new file</span></span>`
              : changed
                ? html`
                    <span class="file-counts">
                      ${counts.insertions > 0 && html`<span class="change-ins">+${counts.insertions}</span>`}
                      ${counts.deletions > 0 && html`<span class="change-del">−${counts.deletions}</span>`}
                    </span>
                  `
                : hasHead && html`<span class="file-unchanged">unchanged</span>`}
        <span class="file-head-spacer"></span>
        ${Actions && html`<${Actions} buffer=${buffer} />`}
        ${handler.views.length > 1 &&
        html`<${ViewChoice} views=${handler.views} current=${current.id} onChoose=${setViewId} />`}
        ${isSource &&
        diffing &&
        counts?.chunks > 0 &&
        html`
          <span class="file-jump">
            <button class="btn-quiet btn-small" title="Previous change" onClick=${() => jump(-1)}>↑</button>
            <span class="file-jump-count">${counts.chunks}</span>
            <button class="btn-quiet btn-small" title="Next change" onClick=${() => jump(1)}>↓</button>
          </span>
        `}
        ${isSource &&
        hasHead &&
        (changed || diffing) &&
        html`
          <div class="segmented" role="tablist" aria-label="File view">
            <button
              class="segmented-item ${!diffing ? "segmented-item-active" : ""}"
              role="tab"
              aria-selected=${!diffing}
              title="Edit the file, with changed lines marked in the gutter"
              onClick=${() => setMode(buffer, "clean")}
            >
              Edit
            </button>
            <button
              class="segmented-item ${diffing ? "segmented-item-active" : ""}"
              role="tab"
              aria-selected=${diffing}
              title="Show what changed since the last commit, deleted lines included (read-only)"
              onClick=${() => setMode(buffer, "diff")}
            >
              Diff
            </button>
          </div>
        `}
      </header>
      ${buffer.conflict &&
      html`
        <${Banner}>
          <span>This file changed on disk while you had unsaved edits.</span>
          <span class="file-head-spacer"></span>
          <button class="btn-quiet btn-small" title="Keep your edits; the next save overwrites the disk version" onClick=${() => keepMine(buffer)}>
            Keep Mine
          </button>
          <button class="btn-quiet btn-small" title="Discard your edits and load the disk version" onClick=${() => takeTheirs(buffer)}>
            Take Theirs
          </button>
          <button class="btn-secondary btn-small" onClick=${() => setComparing(true)}>Compare</button>
        </${Banner}>
      `}
      ${buffer.deleted &&
      html`<${Banner}><span>This file was deleted on disk. Saving will create it again.</span></${Banner}>`}
      ${buffer.saveError &&
      html`<${Banner} tone="danger"><span>Couldn't save: ${buffer.saveError}</span></${Banner}>`}
      <div class="file-view">
        <${Body} key=${current.id} buffer=${buffer} onOpenFile=${onOpenFile} />
        ${findOpen &&
        isSource &&
        buffer.view &&
        html`<${FindBar}
          buffer=${buffer}
          find=${find}
          setFind=${setFind}
          focusSignal=${findFocus}
          editable=${doc?.kind === "text" && !doc.readOnly && !diffing}
          onClose=${closeFind}
        />`}
      </div>
    </div>
  `;
}

