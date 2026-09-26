// Markdown -> HTML for a file tab's "Rendered" view and a session peek.
//
// Parsing is markdown-it (CommonMark + GitHub tables, strikethrough and
// autolinks) with its footnote, definition-list, ==mark==, ~sub~ and ^sup^
// plugins, all vendored under shared/vendor/markdown. Front matter, callouts,
// task lists, heading anchors, and Obsidian's [[wikilinks]], #tags and
// %%comments%% are small rules of our own below.
//
// Safety: a document may have been cloned a minute ago, and this output is
// inserted into a window whose preload bridge can type into terminals. So
// every render goes through DOMPurify with the HTML-only profile before it
// reaches the page — scripts, event handlers, javascript: URLs, iframes,
// objects, forms, <style> and media elements are removed. Nothing is fetched
// while rendering either: every image's `src` is moved to `data-md-src`
// (ours and ones in raw HTML alike), and `loadMarkdownImages` later fills in
// only files read through the main process's containment check. A remote
// image stays a link. Class names from raw HTML are kept only in our own
// namespaces, so a document can't borrow the app's overlay styles.
//
// Raw HTML in the source is rendered only when the caller asks (`html`): a
// file tab does, a session peek doesn't — a reply mentioning `<Shell>`
// without backticks should read as text, not vanish.

import markdownit from "./vendor/markdown/markdown-it.mjs";
import footnote from "./vendor/markdown/markdown-it-footnote.mjs";
import deflist from "./vendor/markdown/markdown-it-deflist.mjs";
import mark from "./vendor/markdown/markdown-it-mark.mjs";
import sub from "./vendor/markdown/markdown-it-sub.mjs";
import sup from "./vendor/markdown/markdown-it-sup.mjs";
import DOMPurify from "./vendor/markdown/purify.mjs";
import { highlightLine, isHighlightable } from "./syntax.js";

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- code blocks ----

// Fence names to the extension keys syntax.js knows.
const LANGUAGE_ALIASES = {
  javascript: "js",
  node: "js",
  typescript: "ts",
  python: "py",
  shell: "sh",
  shellscript: "sh",
  console: "sh",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
  markdown: "md",
  htm: "html",
  xml: "html",
  svg: "html",
  vue: "html",
  scss: "css",
  less: "css",
  text: "txt",
  plaintext: "txt",
};

function highlightBlock(code, lang) {
  // A diff reads by its first column, not by keywords.
  if (lang === "diff" || lang === "patch") {
    return code
      .split("\n")
      .map((line) => {
        const kind = line.startsWith("+") ? "ins" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx";
        return `<span class="md-diff-${kind}">${escapeHtml(line) || " "}</span>`;
      })
      .join("");
  }
  const language = LANGUAGE_ALIASES[lang] ?? lang;
  if (!isHighlightable(language)) return escapeHtml(code);
  let state = { block: false };
  return code
    .split("\n")
    .map((line) => {
      const result = highlightLine(line, language, state);
      state = result.state;
      return result.html;
    })
    .join("\n");
}

function renderCodeBlock(lang, code) {
  return (
    `<div class="code-block">` +
    `<div class="code-block-header">` +
    `<span class="code-block-lang">${escapeHtml(lang || "text")}</span>` +
    `<button class="code-copy-btn" type="button" data-code="${escapeHtml(code)}">Copy</button>` +
    `</div>` +
    `<pre><code>${highlightBlock(code, lang.toLowerCase())}</code></pre>` +
    `</div>`
  );
}

// ---- front matter ----

// A YAML block at the very top, shown as the source it is — fenced, in
// monospace, one line per line — with keys picked out, rather than run
// together into a paragraph. It's never evaluated: this is display, not a
// YAML parser.
function renderFrontMatter(yaml) {
  const lines = yaml.split(/\r?\n/).map((line) => {
    const pair = line.match(/^(\s*)([^\s#:][^:]*)(:)(.*)$/);
    if (pair) {
      const [, indent, key, colon, rest] = pair;
      return `${indent}<span class="md-fm-key">${escapeHtml(key)}${colon}</span>${escapeHtml(rest)}`;
    }
    const item = line.match(/^(\s*)(-)(\s.*)$/);
    if (item) return `${item[1]}<span class="md-fm-key">${item[2]}</span>${escapeHtml(item[3])}`;
    return escapeHtml(line);
  });
  const fence = `<span class="md-fm-fence">---</span>`;
  return `<pre class="md-frontmatter">${[fence, ...lines, fence].join("\n")}</pre>`;
}

// ---- rules of our own ----

// GitHub's alert types, and Obsidian's, sorted into five tones.
const CALLOUT_TONES = {
  note: "note",
  info: "note",
  abstract: "note",
  summary: "note",
  todo: "note",
  quote: "note",
  tip: "tip",
  hint: "tip",
  success: "tip",
  check: "tip",
  done: "tip",
  important: "important",
  question: "important",
  example: "important",
  warning: "warning",
  attention: "warning",
  caution: "caution",
  danger: "caution",
  error: "caution",
  failure: "caution",
  bug: "caution",
};

// `> [!NOTE] Optional title` on a blockquote's first line. Runs before inline
// parsing, while the paragraph is still its raw text.
function callouts(state) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== "blockquote_open") continue;
    const inline = tokens[i + 2];
    if (tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const match = inline.content.match(/^\[!([A-Za-z-]+)\][+-]?[ \t]*([^\n]*)(?:\n|$)/);
    if (!match) continue;
    const kind = match[1].toLowerCase();
    tokens[i].attrJoin("class", `md-callout md-callout-${CALLOUT_TONES[kind] ?? "note"}`);
    const title = new state.Token("html_block", "", 0);
    title.content = `<div class="md-callout-title">${escapeHtml(match[2] || kind[0].toUpperCase() + kind.slice(1))}</div>`;
    inline.content = inline.content.slice(match[0].length);
    tokens.splice(i + 1, 0, title);
    // A callout whose body starts on a later paragraph leaves this one empty.
    if (!inline.content.trim()) tokens.splice(i + 2, 3);
  }
}

// `- [ ]` / `- [x]` list items get a (read-only) checkbox.
function taskLists(state) {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i += 1) {
    if (tokens[i].type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const first = tokens[i].children?.[0];
    const match = first?.type === "text" && first.content.match(/^\[([ xX])\][ \t]+/);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input class="md-task" type="checkbox" disabled${match[1] === " " ? "" : " checked"}>`;
    tokens[i].children.unshift(box);
    tokens[i - 2].attrJoin("class", "md-task-item");
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

// GitHub-style ids, so `[x](#tables)` has somewhere to go. Prefixed, so a
// heading can't take an id the app itself uses; the click handler adds the
// prefix back when following a link.
function headingIds(state) {
  const seen = new Map();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== "heading_open") continue;
    const text = (tokens[i + 1].children ?? [])
      .filter((child) => child.type === "text" || child.type === "code_inline")
      .map((child) => child.content)
      .join("");
    const base = slugify(text) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    tokens[i].attrSet("id", `md-${count ? `${base}-${count}` : base}`);
  }
}

// Obsidian's `[[target|alias]]` and `![[embed]]`. Shown, not followed: a
// wikilink names a note somewhere in a vault, not a path.
function wikilinks(state, silent) {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos += 1;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end === -1) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || inner.includes("\n") || inner.includes("[")) return false;
  if (!silent) {
    const token = state.push("md_wikilink", "", 0);
    const [target, alias] = inner.split("|");
    token.meta = { label: (alias ?? target).trim(), embed };
  }
  state.pos = end + 2;
  return true;
}

// `#tag` at the start of a word. `#` alone, or after a letter (C#), isn't one.
function tags(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x23) return false;
  if (state.pos > 0 && !/\s/.test(state.src[state.pos - 1])) return false;
  const match = state.src.slice(state.pos).match(/^#([\p{L}_][\p{L}\p{N}_/-]*)/u);
  if (!match) return false;
  if (!silent) state.push("md_tag", "", 0).content = match[1];
  state.pos += match[0].length;
  return true;
}

// `%%hidden%%` — an Obsidian comment, which isn't shown.
function comments(state, silent) {
  const src = state.src;
  if (src.charCodeAt(state.pos) !== 0x25 || src.charCodeAt(state.pos + 1) !== 0x25) return false;
  const end = src.indexOf("%%", state.pos + 2);
  if (end === -1) return false;
  if (!silent) state.push("md_comment", "", 0);
  state.pos = end + 2;
  return true;
}

function createParser(html) {
  const md = markdownit({ html, linkify: true, typographer: false, breaks: false })
    .use(footnote)
    .use(deflist)
    .use(mark)
    .use(sub)
    .use(sup);

  md.core.ruler.after("block", "md_callouts", callouts);
  md.core.ruler.after("inline", "md_task_lists", taskLists);
  md.core.ruler.after("inline", "md_heading_ids", headingIds);
  md.inline.ruler.before("image", "md_wikilink", wikilinks);
  md.inline.ruler.before("link", "md_tag", tags);
  md.inline.ruler.before("link", "md_comment", comments);

  md.renderer.rules.md_wikilink = (tokens, idx) => {
    const { label, embed } = tokens[idx].meta;
    return `<span class="md-wikilink${embed ? " md-wikilink-embed" : ""}">${escapeHtml(label)}</span>`;
  };
  md.renderer.rules.md_tag = (tokens, idx) => `<span class="md-tag">#${escapeHtml(tokens[idx].content)}</span>`;
  md.renderer.rules.md_comment = () => "";

  md.renderer.rules.fence = (tokens, idx) => {
    const lang = tokens[idx].info.trim().split(/\s+/)[0] ?? "";
    return renderCodeBlock(lang, tokens[idx].content.replace(/\n$/, ""));
  };
  md.renderer.rules.code_block = (tokens, idx) => renderCodeBlock("", tokens[idx].content.replace(/\n$/, ""));

  // No `src`: see loadMarkdownImages.
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    const title = token.attrGet("title");
    return `<img data-md-src="${escapeHtml(token.attrGet("src") ?? "")}" alt="${escapeHtml(alt)}"${
      title ? ` title="${escapeHtml(title)}"` : ""
    }>`;
  };

  // Tables scroll sideways inside their own box instead of widening the page.
  md.renderer.rules.table_open = () => `<div class="md-table-wrap"><table>`;
  md.renderer.rules.table_close = () => `</table></div>`;

  return md;
}

// ---- sanitizing ----

const purifier = DOMPurify(window);

const OWN_CLASS = /^(md-|tok-|code-|footnote)/;

purifier.addHook("afterSanitizeAttributes", (node) => {
  if (!node.getAttribute) return;
  // Nothing loads while a document is being shown; images are read later,
  // through the main process, or not at all.
  if (node.hasAttribute("src")) {
    if (node.tagName === "IMG") node.setAttribute("data-md-src", node.getAttribute("src"));
    node.removeAttribute("src");
  }
  const style = node.getAttribute("style");
  if (style && /url\s*\(|image-set|@import|position\s*:/i.test(style)) node.removeAttribute("style");
  const classes = node.getAttribute("class");
  if (classes) {
    const kept = classes.split(/\s+/).filter((name) => OWN_CLASS.test(name));
    if (kept.length) node.setAttribute("class", kept.join(" "));
    else node.removeAttribute("class");
  }
  if (node.tagName === "INPUT") node.setAttribute("disabled", "");
});

const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "style", "link", "meta", "base", "iframe", "frame", "frameset", "object", "embed", "form", "select",
    "textarea", "video", "audio", "source", "track", "picture", "canvas", "dialog", "template",
  ],
  FORBID_ATTR: ["srcset", "autofocus", "formaction", "action", "ping", "background", "poster"],
};

// ---- public API ----

const parsers = new Map();
function parserFor(html) {
  if (!parsers.has(html)) parsers.set(html, createParser(html));
  return parsers.get(html);
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * `html`: render raw HTML in the source (sanitized) rather than escape it.
 * `frontMatter`: show a leading YAML block as a metadata sheet.
 */
export function renderMarkdown(raw, { html = false, frontMatter = false } = {}) {
  let source = raw;
  let head = "";
  const front = frontMatter ? source.match(FRONT_MATTER) : null;
  if (front) {
    head = renderFrontMatter(front[1]);
    source = source.slice(front[0].length);
  }
  return purifier.sanitize(head + parserFor(html).render(source), SANITIZE);
}

/**
 * Where a relative link or image in the document at `fromPath` points,
 * relative to the same root, or null if it's absolute or climbs out.
 */
export function resolveDocumentPath(fromPath, target) {
  let clean;
  try {
    clean = decodeURIComponent(target.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  if (!clean || clean.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  const parts = fromPath.split("/").slice(0, -1);
  for (const segment of clean.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Fills in the images `renderMarkdown` left without a `src`. `readImage(src)`
 * resolves a document-relative path to a data URL through the main process,
 * or null; without it (a peek), every image shows as its alt text. A remote
 * image is never fetched: it becomes a link to itself.
 */
export async function loadMarkdownImages(container, readImage) {
  const images = [...container.querySelectorAll("img[data-md-src]")];
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("data-md-src") ?? "";
      img.removeAttribute("data-md-src");
      if (/^data:image\//i.test(src)) {
        img.src = src;
        return;
      }
      const remote = /^https?:\/\//i.test(src);
      const local = !remote && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//");
      const dataUrl = local && readImage ? await readImage(src).catch(() => null) : null;
      if (dataUrl) {
        img.src = dataUrl;
        return;
      }
      const asLink = remote && !img.closest("a");
      const standIn = document.createElement(asLink ? "a" : "span");
      standIn.className = "md-image-missing";
      standIn.textContent = img.alt || src;
      standIn.title = remote ? `Remote image, not loaded: ${src}` : `Image not found: ${src}`;
      if (asLink) standIn.setAttribute("href", src);
      img.replaceWith(standIn);
    })
  );
}

// Wires the delegated click handler for code-block Copy buttons onto a
// container that has already had renderMarkdown's output inserted into it
// (innerHTML/dangerouslySetInnerHTML) — call once per container, not once
// per render, since it's just a click listener, not tied to specific DOM
// nodes that get replaced.
export function attachCopyHandler(container) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest(".code-copy-btn");
    if (!button) return;
    const code = button.getAttribute("data-code") ?? "";
    navigator.clipboard.writeText(code).then(() => {
      button.textContent = "Copied";
      button.classList.add("code-copy-done");
      setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("code-copy-done");
      }, 1200);
    });
  });
}
