// Minimal, dependency-free markdown -> HTML for rendering Claude's replies.
// Covers what the model actually produces day-to-day (bold/italic, inline
// code, fenced code blocks, headings, simple lists, paragraphs) — not full
// CommonMark (no tables, nested lists, links). Input is always treated as
// untrusted text and HTML-escaped before any tag is introduced.
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
  text = text.replace(/\b\d+(\.\d+)?\b/g, '<span class="tok-number">$&</span>');
  text = text.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g, (word) =>
    KEYWORDS.has(word) ? `<span class="tok-keyword">${word}</span>` : word
  );

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

function renderBlocks(text) {
  const lines = text.split("\n");
  let html = "";
  let listType = null;
  let paragraphLines = [];

  function flushParagraph() {
    if (paragraphLines.length) {
      html += `<p>${paragraphLines.join("<br>")}</p>`;
      paragraphLines = [];
    }
  }
  function closeList() {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  }

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);

    if (CODE_LINE_RE.test(line)) {
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
    } else {
      closeList();
      paragraphLines.push(line);
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
