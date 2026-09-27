import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { renderMarkdown, attachCopyHandler, loadMarkdownImages, resolveDocumentPath } from "../../shared/markdown.js";
import { MergeView, EditorView, EditorState } from "../../shared/vendor/codemirror.mjs";
import { baseExtensions, languageFor } from "./setup.js";
import {
  onContent,
  textOfBuffer,
  openAsText,
  resolveCompare,
  parkEditor,
  restoreEditor,
  reportView,
  rememberScroll,
} from "./buffers.js";

// The views a file-type handler can offer (handlers/). Each takes the tab's
// buffer rather than a file, so a preview follows unsaved edits.

/** Bytes as something a person reads. */
export function formatBytes(bytes) {
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

/**
 * The buffer's editor. The EditorView belongs to the buffer, not to this
 * component: mounting moves its DOM in, unmounting moves it out again, so
 * nothing about the document is lost when the tab is hidden or moved.
 */
export function EditorPane({ buffer }) {
  const ref = useRef(null);
  const view = buffer.view;
  useLayoutEffect(() => {
    const host = ref.current;
    if (!view || !host) return;
    host.appendChild(view.dom);
    view.requestMeasure();
    // Back where it was: the scroll and cursor it had when the tab was last
    // on screen (or saved with the layout), not the top of the file.
    restoreEditor(buffer);
    // Take focus when nothing else has it (a tab just opened), never away
    // from a terminal the person is typing in.
    if (document.activeElement === document.body || !document.activeElement) view.focus();
    const onScroll = () => reportView(buffer);
    view.scrollDOM.addEventListener("scroll", onScroll);
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      parkEditor(buffer);
      reportView(buffer, true);
      if (view.dom.parentNode === host) host.removeChild(view.dom);
    };
  }, [view]);
  if (!view) return html`<div class="file-empty"><p>Reading ${buffer.name}…</p></div>`;
  return html`<div class="editor-host" ref=${ref}></div>`;
}

/**
 * A scrolling view (a preview, an image) that comes back where it was left.
 * The offset is reapplied as content settles — a document's images load
 * after it renders, and restoring before they do lands short.
 */
function useRememberedScroll(buffer, viewId) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const saved = buffer.ui.scroll[viewId] ?? 0;
    // Only the person's own scrolling counts. A restore that's clamped short
    // (the content hasn't reached its full height yet) fires a scroll event
    // too; taking that for the person's would stop restoring and record the
    // wrong place. So a scroll that lands exactly where the last restore put
    // it is ours, and anything else — wheel, scrollbar, keys — is theirs.
    let touched = false;
    let applied = null;
    const apply = () => {
      if (touched) return;
      element.scrollTop = saved;
      applied = element.scrollTop;
    };
    apply();
    const settle = new ResizeObserver(apply);
    for (const child of element.children) settle.observe(child);
    const stopSettling = setTimeout(() => settle.disconnect(), 2000);
    const onScroll = () => {
      if (!touched && element.scrollTop === applied) return;
      touched = true;
      rememberScroll(buffer, viewId, element.scrollTop);
    };
    element.addEventListener("scroll", onScroll);
    return () => {
      settle.disconnect();
      clearTimeout(stopSettling);
      element.removeEventListener("scroll", onScroll);
    };
  }, [buffer, viewId]);
  return ref;
}

/** Follows the buffer's text, a beat behind typing. */
function useBufferText(buffer, delay = 150) {
  const [text, setText] = useState(() => textOfBuffer(buffer));
  useEffect(() => {
    setText(textOfBuffer(buffer));
    let timer = null;
    const stop = onContent(buffer, () => {
      clearTimeout(timer);
      timer = setTimeout(() => setText(textOfBuffer(buffer)), delay);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [buffer, buffer.view]);
  return text;
}

/**
 * A rendered .md. `renderMarkdown` sanitizes everything it returns (see
 * shared/markdown.js), so raw HTML in the file renders without anything in it
 * being able to run. Images are read here, relative to this file, through the
 * same containment check any file tab gets; nothing remote is fetched.
 */
export function MarkdownPreview({ buffer, onOpenFile }) {
  const bodyRef = useRef(null);
  const scrollRef = useRememberedScroll(buffer, "rendered");
  const source = useBufferText(buffer);
  const { root, path } = buffer;
  const rendering = useMemo(() => renderMarkdown(source, { html: true, frontMatter: true }), [source]);

  useEffect(() => {
    const element = bodyRef.current;
    if (element) attachCopyHandler(element);
  }, []);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    loadMarkdownImages(element, async (src) => {
      const target = resolveDocumentPath(path, src);
      if (!target) return null;
      const opened = await window.clanceApp.docRead(root, target);
      return opened?.kind === "image" ? opened.dataUrl : opened?.preview ?? null;
    });
  }, [rendering, root, path]);

  // A link never navigates this window. `#section` scrolls to that heading
  // (ids carry an `md-` prefix, footnotes don't); a relative path opens that
  // file in a tab; anything else goes to the browser, and the main process
  // decides whether its scheme is one worth opening at all.
  function onClick(event) {
    const link = event.target.closest("a[href]");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href");
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target =
        bodyRef.current?.querySelector(`#${CSS.escape(`md-${id}`)}`) ?? bodyRef.current?.querySelector(`#${CSS.escape(id)}`);
      target?.scrollIntoView({ block: "start" });
      return;
    }
    const relative = resolveDocumentPath(path, href);
    if (relative !== null && onOpenFile) {
      onOpenFile(root, relative);
      return;
    }
    window.clanceApp.openExternalUrl(href);
  }

  return html`
    <div class="file-body" ref=${scrollRef}>
      <div class="file-markdown" ref=${bodyRef} onClick=${onClick} dangerouslySetInnerHTML=${{ __html: rendering }}></div>
    </div>
  `;
}

/**
 * An SVG, drawn from the buffer's text as an image — so it follows unsaved
 * edits, and an `<img>` can't run the script SVG is allowed to carry.
 */
export function SvgPreview({ buffer }) {
  const text = useBufferText(buffer, 250);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  const scrollRef = useRememberedScroll(buffer, "image");
  return html`<div class="file-image-body" ref=${scrollRef}><img class="file-image" src=${src} alt=${buffer.path} /></div>`;
}

/** A bitmap image, at its size, fit to the pane. */
export function ImageView({ buffer }) {
  const scrollRef = useRememberedScroll(buffer, "image");
  return html`<div class="file-image-body" ref=${scrollRef}><img class="file-image" src=${buffer.doc.dataUrl} alt=${buffer.path} /></div>`;
}

/** A file no handler claims says what it can about itself, and offers a way out. */
export function FallbackView({ buffer }) {
  const doc = buffer.doc;
  const size = formatBytes(doc.bytes);
  const full = `${buffer.root}/${buffer.path}`;
  return html`
    <div class="file-empty file-fallback">
      <p>${doc.reason}</p>
      ${size && html`<p class="file-empty-detail">${buffer.name} · ${size}</p>`}
      <div class="file-fallback-actions">
        <button class="btn-secondary btn-small" onClick=${() => window.clanceApp.docOpenDefaultApp(buffer.root, buffer.path)}>
          Open in Default App
        </button>
        <button class="btn-quiet btn-small" onClick=${() => window.clanceApp.revealFile(full)}>Reveal in Finder</button>
        <button class="btn-quiet btn-small" onClick=${() => openAsText(buffer)}>Open as Text</button>
      </div>
    </div>
  `;
}

/**
 * Compare, from the conflict banner: what's on disk on the left (read-only),
 * the unsaved edits on the right, with an arrow per changed chunk to take
 * the disk's version of it. Done keeps the right-hand side.
 */
export function CompareView({ buffer, onClose }) {
  const ref = useRef(null);
  const mergeRef = useRef(null);
  useLayoutEffect(() => {
    if (!ref.current || !buffer.conflict) return;
    const language = languageFor(buffer.path);
    const merge = new MergeView({
      a: {
        doc: buffer.conflict.diskText,
        extensions: [baseExtensions(), language, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      },
      b: { doc: textOfBuffer(buffer), extensions: [baseExtensions(), language] },
      parent: ref.current,
      revertControls: "a-to-b",
      highlightChanges: false,
      gutter: true,
    });
    mergeRef.current = merge;
    return () => merge.destroy();
  }, [buffer]);

  function done() {
    const merged = mergeRef.current?.b.state.doc.toString();
    if (merged !== undefined) resolveCompare(buffer, merged);
    onClose();
  }

  return html`
    <div class="file-compare">
      <div class="file-compare-head">
        <span class="file-compare-side">On disk</span>
        <span class="file-compare-side">Yours — edit here, or take a chunk from disk with its arrow</span>
        <span class="file-head-spacer"></span>
        <button class="btn-quiet btn-small" onClick=${onClose}>Cancel</button>
        <button class="btn-primary btn-small" onClick=${done}>Use This Version</button>
      </div>
      <div class="file-compare-body" ref=${ref}></div>
    </div>
  `;
}
