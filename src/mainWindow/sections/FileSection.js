import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { highlightLine } from "../../shared/syntax.js";
import { renderMarkdown, attachCopyHandler } from "../../shared/markdown.js";

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

/** Bytes as something a person reads, for a file no reader claimed. */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function FileSection({ repoRoot, path }) {
  const [view, setView] = useState(null);
  // Set when no reader claimed the file. Not an error — the fallback says
  // what it can about it instead of apologising.
  const [fallback, setFallback] = useState(null);
  const [image, setImage] = useState(null);
  const [error, setError] = useState(null);
  const [showDiff, setShowDiff] = useState(true);
  // Which of the reader's views is on screen. A file that has only one — most
  // source files — never shows the choice.
  const [rendered, setRendered] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const bodyRef = useRef(null);

  // One read, through whichever reader the main process picked for this file
  // (git.ts's `openFileView`). The tab draws the payload it was handed rather
  // than assuming every file is text with a diff.
  async function load() {
    const next = await window.clanceApp.openFileView(repoRoot, path);
    if (!next) {
      setError("That file isn't there any more.");
      setView(null);
      setFallback(null);
      setImage(null);
      return;
    }
    setError(null);
    if (next.reader === "text") {
      setFallback(null);
      setImage(null);
      setView(next.view);
      return;
    }
    if (next.reader === "image") {
      setFallback(null);
      setView(null);
      setImage(next);
      return;
    }
    setView(null);
    setImage(null);
    setFallback(next);
  }

  useEffect(() => {
    setView(null);
    setFallback(null);
    setImage(null);
    setScrollTop(0);
    // A new file gets its reader's own default view rather than whatever the
    // last file was left on.
    setRendered(true);
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
  if (image) {
    return html`<${ImageView} path=${path} image=${image} rendered=${rendered} setRendered=${setRendered} />`;
  }
  if (view && view.renders === "markdown" && rendered && !view.omitted) {
    return html`<${MarkdownView} path=${path} view=${view} rendered=${rendered} setRendered=${setRendered} />`;
  }
  if (fallback) {
    const size = formatBytes(fallback.bytes);
    return html`
      <div class="file-section">
        <div class="file-empty">
          <p>${fallback.reason}</p>
          ${size && html`<p class="file-empty-detail">${size}</p>`}
        </div>
      </div>
    `;
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
        rendered=${rendered}
        setRendered=${setRendered}
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

/**
 * The choice between a reader's two views. A value choice, not an action, so
 * it's a segmented pill like Diff / Clean rather than a button. It appears
 * only when there is something to choose between: a .md has a rendered form
 * and a source, an SVG has a picture and a source, a .ts has only itself.
 */
function ViewToggle({ rendered, setRendered, renderedLabel = "Rendered" }) {
  return html`
    <span class="segmented" role="tablist">
      <button
        class="segmented-item ${rendered ? "segmented-item-active" : ""}"
        role="tab"
        aria-selected=${rendered}
        onClick=${() => setRendered(true)}
      >
        ${renderedLabel}
      </button>
      <button
        class="segmented-item ${!rendered ? "segmented-item-active" : ""}"
        role="tab"
        aria-selected=${!rendered}
        onClick=${() => setRendered(false)}
      >
        Raw
      </button>
    </span>
  `;
}

/**
 * An image. Drawn through an `<img>` with a data URL rather than by putting
 * the file's own markup on the page: an SVG loaded as an image can't run the
 * script SVG is allowed to carry, and Files browses any folder on the machine.
 * Only a format with a text source worth reading offers Raw.
 */
function ImageView({ path, image, rendered, setRendered }) {
  const hasSource = image.source !== null;
  return html`
    <div class="file-section">
      <header class="file-head">
        <span class="file-path" title=${path}>${path}</span>
        <span class="file-image-size">${formatBytes(image.bytes)}</span>
        <span class="file-head-spacer"></span>
        ${hasSource && html`<${ViewToggle} rendered=${rendered} setRendered=${setRendered} renderedLabel="Image" />`}
      </header>
      ${rendered || !hasSource
        ? html`<div class="file-image-body"><img class="file-image" src=${image.dataUrl} alt=${path} /></div>`
        : html`<div class="file-body"><pre class="file-source">${image.source}</pre></div>`}
    </div>
  `;
}

/**
 * A rendered .md. `renderMarkdown` escapes every character of the file before
 * it introduces a tag of its own, so a document holding `<script>` renders
 * those characters instead of running them, and only http/https/mailto links
 * become links at all. The main process re-parses the URL before opening it.
 */
function MarkdownView({ path, view, rendered, setRendered }) {
  const bodyRef = useRef(null);
  const source = useMemo(
    () =>
      (view.lines ?? [])
        .filter((line) => line.kind !== "del" && line.kind !== "hunk")
        .map((line) => line.text)
        .join("\n"),
    [view]
  );
  const rendering = useMemo(() => renderMarkdown(source), [source]);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    attachCopyHandler(element);
  }, []);

  // A link in a file is a link to somewhere else, not a way to navigate this
  // window. It goes to the browser, and the main process decides whether the
  // scheme is one worth opening at all.
  function onClick(event) {
    const link = event.target.closest("a[href]");
    if (!link) return;
    event.preventDefault();
    window.clanceApp.openExternalUrl(link.getAttribute("href"));
  }

  return html`
    <div class="file-section">
      <header class="file-head">
        <span class="file-path" title=${path}>${path}</span>
        ${view.changed
          ? html`<span class="file-counts"><span class="change-ins">changed</span></span>`
          : html`<span class="file-unchanged">unchanged</span>`}
        <span class="file-head-spacer"></span>
        <${ViewToggle} rendered=${rendered} setRendered=${setRendered} />
      </header>
      <div class="file-body">
        <div
          class="file-markdown"
          ref=${bodyRef}
          onClick=${onClick}
          dangerouslySetInnerHTML=${{ __html: rendering }}
        ></div>
      </div>
    </div>
  `;
}

function FileHeader({ path, view, counts, showDiff, setShowDiff, changeCount, jump, rendered, setRendered }) {
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
      ${view.renders && html`<${ViewToggle} rendered=${rendered} setRendered=${setRendered} />`}
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
