import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { highlightLine } from "../../shared/syntax.js";

// A file tab: the whole file, with its changes in place, and a button that
// turns the change marks off. Read-only — Clance never edits a file; the
// session in the next pane does. This is the surface for understanding what it
// did, which needs the code around a change as much as the change itself.
//
// Both views come from one payload (src/main/git.ts's getFileView): the file
// as a full-context diff. Hiding the deleted lines leaves exactly the
// working-tree file, so "clean" and "diff" can never disagree about what the
// file says.

/** Row height in px. Fixed, because the windowing below computes offsets from it. */
const ROW_HEIGHT = 20;
/** Rows rendered above and below the viewport, so a fast scroll doesn't show gaps. */
const OVERSCAN = 40;

// Clean means clean: with the marks off, an added line is just a line of the
// file. Leaving the tint on would make a new file one solid block of colour,
// which is the thing the toggle exists to escape.
function lineClass(kind, showDiff) {
  if (!showDiff) return "fileline";
  if (kind === "add") return "fileline fileline-add";
  if (kind === "del") return "fileline fileline-del";
  if (kind === "hunk") return "fileline fileline-hunk";
  return "fileline";
}

export function FileSection({ repoRoot, path }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [showDiff, setShowDiff] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const bodyRef = useRef(null);

  async function load() {
    const next = await window.clanceApp.gitFileView(repoRoot, path);
    if (!next) {
      setError("That file isn't in this repository any more.");
      setView(null);
      return;
    }
    setError(null);
    setView(next);
  }

  useEffect(() => {
    setView(null);
    setScrollTop(0);
    load();
  }, [repoRoot, path]);

  // The file is being written by someone else while it's open, so the tab
  // follows it rather than showing what it said when it was opened.
  useEffect(() => {
    return window.clanceApp.onGitChanged((root) => {
      if (root === repoRoot) load();
    });
  }, [repoRoot, path]);

  // Windowing needs the viewport's real height, and it changes with the pane.
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [view === null]);

  // In clean mode the deleted lines and the hunk header come out, which
  // leaves the file exactly as it is on disk.
  const lines = useMemo(() => {
    const all = view?.lines ?? [];
    return showDiff ? all : all.filter((line) => line.kind !== "del" && line.kind !== "hunk");
  }, [view, showDiff]);

  // Where the changes are, for the jump buttons — a change can be a thousand
  // lines down a file, and hunting for it by scrolling is the thing that makes
  // a whole-file view useless without them.
  const changeRows = useMemo(() => {
    // The first row of each run, not every changed row, so "next change"
    // doesn't step through a 50-line block one line at a time.
    const starts = [];
    lines.forEach((line, index) => {
      const changed = line.kind === "add" || line.kind === "del";
      const previous = lines[index - 1];
      const previousChanged = previous && (previous.kind === "add" || previous.kind === "del");
      if (changed && !previousChanged) starts.push(index);
    });
    return starts;
  }, [lines]);

  const counts = useMemo(() => {
    const all = view?.lines ?? [];
    return {
      insertions: all.filter((l) => l.kind === "add").length,
      deletions: all.filter((l) => l.kind === "del").length,
    };
  }, [view]);

  // Highlighting threads a block-comment flag down the file, so a multi-line
  // comment stays one colour. Done for the whole file once rather than per
  // visible row: a row's colour depends on the rows above it, so a window that
  // starts mid-comment would otherwise highlight it as code.
  const highlighted = useMemo(() => {
    if (!view) return [];
    let state = { block: false };
    return view.lines.map((line) => {
      if (line.kind === "hunk") return "";
      const result = highlightLine(line.text, view.language, state);
      // A deleted line is not part of the file the next line belongs to, so it
      // must not carry its comment state forward.
      if (line.kind !== "del") state = result.state;
      return result.html;
    });
  }, [view]);

  // Clean mode filters lines out, so the highlighted array (indexed over every
  // line) is re-indexed here rather than recomputed.
  const indexOfLine = useMemo(() => {
    const all = view?.lines ?? [];
    const map = new Map();
    all.forEach((line, index) => map.set(line, index));
    return map;
  }, [view]);

  function jump(direction) {
    if (changeRows.length === 0) return;
    const current = Math.round(scrollTop / ROW_HEIGHT);
    const next =
      direction > 0
        ? changeRows.find((row) => row > current + 1)
        : [...changeRows].reverse().find((row) => row < current - 1);
    const target = next ?? (direction > 0 ? changeRows[0] : changeRows[changeRows.length - 1]);
    // A third of the way down rather than at the very top, so the change lands
    // with the code that leads up to it already visible.
    bodyRef.current?.scrollTo({ top: Math.max(0, target * ROW_HEIGHT - height / 3) });
  }

  if (error) {
    return html`<div class="file-section"><div class="file-empty"><p>${error}</p></div></div>`;
  }
  if (!view) {
    return html`<div class="file-section"><div class="file-empty"><p>Reading ${path}…</p></div></div>`;
  }
  if (view.omitted) {
    return html`
      <div class="file-section">
        <${FileHeader}
          path=${path}
          view=${view}
          counts=${counts}
          showDiff=${showDiff}
          setShowDiff=${setShowDiff}
          changeCount=${0}
          jump=${jump}
        />
        <div class="file-empty"><p>${view.omitted}</p></div>
      </div>
    `;
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = lines.slice(first, last);
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  return html`
    <div class="file-section">
      <${FileHeader}
        path=${path}
        view=${view}
        counts=${counts}
        showDiff=${showDiff}
        setShowDiff=${setShowDiff}
        changeCount=${changeRows.length}
        jump=${jump}
      />
      <div class="file-body" ref=${bodyRef} onScroll=${(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div class="file-lines" style=${`height:${lines.length * ROW_HEIGHT}px`}>
          <div style=${`transform:translateY(${first * ROW_HEIGHT}px)`}>
            ${visible.map((line, offset) => {
              // The inner HTML below is syntax.js's output, which escapes
              // every chunk of the line before adding a tag of its own and
              // emits nothing but its own fixed set of <span class="tok-*">.
              // A file's text can't carry markup out of it.
              const key = first + offset;
              const mark = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
              return html`
                <div class=${lineClass(line.kind, showDiff)} key=${key} style=${`height:${ROW_HEIGHT}px`}>
                  <span class="fileline-no" style=${`width:${gutterWidth}`}
                    >${line.kind === "hunk" ? "" : (line.newLine ?? line.oldLine ?? "")}</span
                  >
                  ${showDiff && html`<span class="fileline-mark">${mark}</span>`}
                  <span
                    class="fileline-text"
                    dangerouslySetInnerHTML=${{
                      __html: line.kind === "hunk" ? "" : highlighted[indexOfLine.get(line)] ?? "",
                    }}
                  ></span>
                </div>
              `;
            })}
          </div>
        </div>
        ${view.truncated &&
        html`<p class="file-truncated">This file is too long to show in full — the rest is hidden.</p>`}
      </div>
    </div>
  `;
}

function FileHeader({ path, view, counts, showDiff, setShowDiff, changeCount, jump }) {
  return html`
    <header class="file-head">
      <span class="file-path" title=${path}>${path}</span>
      ${view.changed
        ? html`
            <span class="file-counts">
              ${counts.insertions > 0 && html`<span class="change-ins">+${counts.insertions}</span>`}
              ${counts.deletions > 0 && html`<span class="change-del">−${counts.deletions}</span>`}
            </span>
          `
        : html`<span class="file-unchanged">unchanged</span>`}
      <span class="file-head-spacer"></span>
      ${view.changed &&
      changeCount > 0 &&
      showDiff &&
      html`
        <span class="file-jump">
          <button class="btn-quiet btn-small" title="Previous change" onClick=${() => jump(-1)}>↑</button>
          <span class="file-jump-count">${changeCount}</span>
          <button class="btn-quiet btn-small" title="Next change" onClick=${() => jump(1)}>↓</button>
        </span>
      `}
      ${view.changed &&
      html`
        <div class="segmented" role="tablist" aria-label="File view">
          <button
            class="segmented-item ${showDiff ? "segmented-item-active" : ""}"
            role="tab"
            aria-selected=${showDiff}
            title="Show what changed"
            onClick=${() => setShowDiff(true)}
          >
            Diff
          </button>
          <button
            class="segmented-item ${!showDiff ? "segmented-item-active" : ""}"
            role="tab"
            aria-selected=${!showDiff}
            title="Read the file as it stands, with no change marks"
            onClick=${() => setShowDiff(false)}
          >
            Clean
          </button>
        </div>
      `}
    </header>
  `;
}
