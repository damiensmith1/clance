import { html, useEffect, useLayoutEffect, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { unifiedMergeView, getChunks, goToNextChunk, goToPreviousChunk } from "../../shared/vendor/codemirror.mjs";
import { baseExtensions, languageFor, EditorView, EditorState } from "../editor/setup.js";
import { useRepoChanged } from "../state/workStore.js";

// A diff tab: one file across a range — a commit, a branch against its base,
// or what's uncommitted — read-only, the way a file tab's Diff view draws a
// file against its last commit. Opened from the Changes pane; editing is the
// file tab's job (Open file). See docs/design.md's "Work".
//
// The tab carries everything it shows: { root, path, from, to, rangeLabel },
// with `to` null for the files as they are now, which it re-reads when the
// repository changes on disk.

function useVersions(tab) {
  const [versions, setVersions] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    window.clanceApp.workFileVersions(tab.root, { from: tab.from, to: tab.to }, tab.path).then((next) => {
      if (!cancelled) setVersions(next ?? { omitted: "Nothing changed in this file here" });
    });
    return () => {
      cancelled = true;
    };
  }, [tab.root, tab.path, tab.from, tab.to, tick]);
  // Files as they are now follow the disk.
  useRepoChanged(
    (root) => {
      if (tab.to === null && (tab.root === root || tab.root.startsWith(`${root}/`))) setTick((n) => n + 1);
    },
    [tab.root, tab.to]
  );
  return versions;
}

export function DiffSection({ tab, onOpenFile, onKeep }) {
  const versions = useVersions(tab);
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const [chunks, setChunks] = useState(0);

  // A new view whenever the text changes: a diff tab's two sides are fixed
  // for a commit, and re-read wholesale for the working tree. Where the
  // reader was is kept across a re-read.
  const shownRef = useRef(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !versions || versions.omitted) return;
    // A re-read that found the same text changes nothing on screen.
    const texts = `${versions.before}\0${versions.after}`;
    if (viewRef.current && shownRef.current === texts && viewRef.current.dom.parentNode === host) return;
    shownRef.current = texts;
    const scrollTop = viewRef.current?.scrollDOM.scrollTop ?? 0;
    viewRef.current?.destroy();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: versions.after,
        extensions: [
          baseExtensions(),
          languageFor(tab.path),
          EditorState.readOnly.of(true),
          unifiedMergeView({ original: versions.before, mergeControls: false, gutter: true, syntaxHighlightDeletions: true }),
        ],
      }),
    });
    viewRef.current = view;
    view.scrollDOM.scrollTop = scrollTop;
    setChunks(getChunks(view.state)?.chunks.length ?? 0);
  }, [versions]);

  useEffect(
    () => () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    },
    []
  );

  function jump(direction) {
    const view = viewRef.current;
    if (!view) return;
    (direction > 0 ? goToNextChunk : goToPreviousChunk)(view);
    view.focus();
  }

  const editable = tab.to === null && versions && versions.status !== "deleted";
  return html`
    <div class="file-section">
      <header class="file-head">
        <span class="file-path" title=${tab.path}>${tab.path}</span>
        <span class="file-unchanged diff-range" title=${tab.rangeLabel}>${tab.rangeLabel}</span>
        ${versions && !versions.omitted && versions.status === "added"
          ? html`<span class="file-counts"><span class="change-ins">new file</span></span>`
          : versions?.status === "deleted"
            ? html`<span class="file-counts"><span class="change-del">deleted</span></span>`
            : versions &&
              !versions.omitted &&
              html`<span class="file-counts">
                ${versions.insertions > 0 && html`<span class="change-ins">+${versions.insertions}</span>`}
                ${versions.deletions > 0 && html`<span class="change-del">−${versions.deletions}</span>`}
              </span>`}
        <span class="file-head-spacer"></span>
        ${chunks > 1 &&
        html`
          <span class="file-jump">
            <button class="btn-quiet btn-small" title="Previous change" onClick=${() => jump(-1)}>↑</button>
            <span class="file-jump-count">${chunks}</span>
            <button class="btn-quiet btn-small" title="Next change" onClick=${() => jump(1)}>↓</button>
          </span>
        `}
        ${tab.preview &&
        html`<button class="btn-quiet btn-small" title="Keep this tab when another file is opened (or double-click the file)" onClick=${onKeep}>Keep open</button>`}
        ${editable && html`<button class="btn-quiet btn-small" title="Open the file to edit it" onClick=${() => onOpenFile(tab.root, tab.path)}>Open file</button>`}
      </header>
      <div class="file-view">
        ${!versions
          ? html`<div class="file-empty"><p>Reading ${tab.path}…</p></div>`
          : versions.omitted
            ? html`<div class="file-empty"><p>${versions.omitted}</p></div>`
            : html`<div class="editor-host" ref=${hostRef}></div>`}
      </div>
    </div>
  `;
}
