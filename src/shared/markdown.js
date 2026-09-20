// Minimal, dependency-free markdown -> HTML. Written for the old chat UI and
// now what a file tab's "Rendered" view uses for a .md file.
// Covers bold/italic, inline code, fenced code blocks, headings, simple
// lists, paragraphs, links and tables — not full CommonMark (no nested
// lists, reference links, footnotes). Input is always treated as untrusted
// text and HTML-escaped before any tag is introduced, which is what makes it
// safe to point at a file that was cloned a minute ago: a .md holding
// `<script>` renders those characters rather than running them.
//
// Code content is pulled into placeholders before any other formatting
// runs, and restored at the very end, so code is never itself reformatted
// as markdown. Placeholders are built from control characters (via
// String.fromCharCode, not typed literally) that can never occur in normal
// text, so restoring them can't collide with digits or anything else that
// is actually part of the message.
const CODE_MARK = String.fromCharCode(0);
const INLINE_MARK = String.fromCharCode(1);
const TOKEN_MARK = String.fromCharCode(2);
const CODE_TOKEN_RE = new RegExp(CODE_MARK + "(\\d+)" + CODE_MARK, "g");
const INLINE_TOKEN_RE = new RegExp(INLINE_MARK + "(\\d+)" + INLINE_MARK, "g");
const CODE_LINE_RE = new RegExp("^" + CODE_MARK + "(\\d+)" + CODE_MARK + "$");

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// Crude, regex-based approximation of syntax highlighting — not a real
// per-language tokenizer, just enough visual signal (comments, strings,
// numbers, a common cross-language keyword list) to make code blocks read
// as code rather than plain text. Comments/strings are pulled out first so
// keyword/number matching never reaches inside them.
const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "import", "export", "from",
  "default", "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "class", "extends", "implements", "interface", "type", "enum",
  "new", "this", "super", "async", "await", "try", "catch", "finally",
  "throw", "typeof", "instanceof", "public", "private", "protected",
  "static", "readonly", "void", "null", "undefined", "true", "false", "def",
  "elif", "except", "pass", "lambda", "with", "as", "yield", "self", "fn",
  "impl", "struct", "pub", "use", "mod", "match", "in", "of",
]);

// Placeholder for one already-highlighted comment or string, and the same
// pattern as a splitter, so the pass below can step over those rather than
// reach inside them.
const HIGHLIGHT_TOKEN_RE = new RegExp("^" + TOKEN_MARK + "\\d+" + TOKEN_MARK + "$");
const HIGHLIGHT_SPLIT_RE = new RegExp("(" + TOKEN_MARK + "\\d+" + TOKEN_MARK + ")");

function highlightCode(raw) {
  const parts = [];
  let text = raw.replace(
    /(#|\/\/)[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    (match) => {
      const isComment = match.startsWith("#") || match.startsWith("/");
      const cls = isComment ? "tok-comment" : "tok-string";
      const idx = parts.push(`<span class="${cls}">${escapeHtml(match)}</span>`) - 1;
      return TOKEN_MARK + idx + TOKEN_MARK;
    }
  );

  text = escapeHtml(text);

  // Numbers and keywords in one pass over the segments between
  // placeholders, never two passes over everything. Two passes would have
  // the second reading the markup the first just wrote — `class` is itself
  // a keyword, so a highlighted number came back out as broken HTML the
  // page then showed as literal text — and a pass that included the
  // placeholders would highlight *their* digits, losing the comment or
  // string each one stands for.
  text = text
    .split(HIGHLIGHT_SPLIT_RE)
    .map((segment) => {
      if (HIGHLIGHT_TOKEN_RE.test(segment)) return segment;
      return segment.replace(/\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b/g, (match) => {
        if (/^\d/.test(match)) return `<span class="tok-number">${match}</span>`;
        return KEYWORDS.has(match) ? `<span class="tok-keyword">${match}</span>` : match;
      });
    })
    .join("");

  const tokenRe = new RegExp(TOKEN_MARK + "(\\d+)" + TOKEN_MARK, "g");
  return text.replace(tokenRe, (_, i) => parts[Number(i)]);
}

function renderCodeBlock(lang, code) {
  const highlighted = highlightCode(code);
  return `<div class="code-block">
    <div class="code-block-header">
      <span class="code-block-lang">${escapeHtml(lang || "Code")}</span>
      <button class="code-copy-btn" data-code="${escapeAttr(code)}">Copy</button>
    </div>
    <pre><code>${highlighted}</code></pre>
  </div>`;
}

/** A `| a | b |` row followed by a `|---|---|` rule. */
function isTableStart(lines, i) {
  if (!/\|/.test(lines[i] ?? "")) return false;
  const rule = lines[i + 1] ?? "";
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(rule) && /\|/.test(rule);
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(lines, start) {
  const head = splitRow(lines[start]);
  let end = start + 1;
  const body = [];
  while (end + 1 < lines.length && /\|/.test(lines[end + 1] ?? "") && lines[end + 1].trim() !== "") {
    end += 1;
    body.push(splitRow(lines[end]));
  }
  const th = head.map((cell) => `<th>${cell}</th>`).join("");
  const rows = body
    .map((row) => `<tr>${head.map((_, c) => `<td>${row[c] ?? ""}</td>`).join("")}</tr>`)
    .join("");
  return { html: `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`, end };
}

function renderBlocks(text) {
  const lines = text.split("\n");
  let html = "";
  let listType = null;
  let paragraphLines = [];

  // A hard-wrapped paragraph flows back together: in markdown a single
  // newline is a space, not a break. Two trailing spaces is the one way to
  // ask for a real one. (The old chat caller wanted every newline to break,
  // which is wrong for a document that was wrapped at 80 columns.)
  function flushParagraph() {
    if (paragraphLines.length) {
      const joined = paragraphLines
        .map((line, i) => (i === paragraphLines.length - 1 ? line.text : line.text + (line.hardBreak ? "<br>" : " ")))
        .join("");
      html += `<p>${joined}</p>`;
      paragraphLines = [];
    }
  }
  function closeList() {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  }

  // Indexed rather than for-of: a table is recognised by the row *after* the
  // header, so this needs to look ahead and then skip what it consumed.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);

    if (isTableStart(lines, i)) {
      flushParagraph();
      closeList();
      const table = renderTable(lines, i);
      html += table.html;
      i = table.end;
    } else if (CODE_LINE_RE.test(line)) {
      flushParagraph();
      closeList();
      html += line;
    } else if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html += `<h${level}>${heading[2]}</h${level}>`;
    } else if (ul) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${ul[1]}</li>`;
    } else if (ol) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${ol[1]}</li>`;
    } else if (line.trim() === "") {
      flushParagraph();
      closeList();
    } else if (listType && /^\s+\S/.test(line)) {
      // An indented line under a list item continues it rather than starting
      // a paragraph of its own. Without this every wrapped bullet breaks into
      // an item plus a stray paragraph.
      html = html.replace(/<\/li>$/, ` ${line.trim()}</li>`);
    } else {
      closeList();
      paragraphLines.push({ text: line.replace(/\s+$/, ""), hardBreak: /\s{2,}$/.test(line) });
    }
  }
  flushParagraph();
  closeList();
  return html;
}

export function renderMarkdown(raw) {
  const codeBlocks = [];
  let text = raw.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.push(renderCodeBlock(lang.trim(), code.replace(/\n$/, ""))) - 1;
    return CODE_MARK + idx + CODE_MARK;
  });

  text = escapeHtml(text);

  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.push(`<code>${code}</code>`) - 1;
    return INLINE_MARK + idx + INLINE_MARK;
  });

  text = text.replace(/\*\*([^\n*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^\n*]+)\*/g, "<em>$1</em>");

  // Images, before links — `![a](b)` contains `[a](b)`. Nothing is loaded:
  // a rendered document shows the alt text where a picture would be. Opening
  // a file should not read other files, or fetch anything from whoever wrote
  // it. An image is looked at by opening it, which is its own file tab.
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_whole, alt) =>
    alt ? `<span class="md-image-alt">${alt}</span>` : ""
  );

  // Links, on already-escaped text. Only schemes that are safe to hand to
  // the OS become one: `javascript:` and `data:` stay the literal text they
  // were, as does a relative path, which has nothing to open.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) =>
    /^(https?:\/\/|mailto:)/i.test(url) ? `<a href="${escapeAttr(url)}">${label}</a>` : whole
  );

  text = renderBlocks(text);

  text = text.replace(INLINE_TOKEN_RE, (_, i) => inlineCodes[Number(i)]);
  text = text.replace(CODE_TOKEN_RE, (_, i) => codeBlocks[Number(i)]);

  return text;
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
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = original;
      }, 1200);
    });
  });
}
