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
const CODE_TOKEN_RE = new RegExp(CODE_MARK + "(\\d+)" + CODE_MARK, "g");
const INLINE_TOKEN_RE = new RegExp(INLINE_MARK + "(\\d+)" + INLINE_MARK, "g");
const CODE_LINE_RE = new RegExp("^" + CODE_MARK + "(\\d+)" + CODE_MARK + "$");

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function renderMarkdown(raw) {
  const codeBlocks = [];
  let text = raw.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    const idx =
      codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`) - 1;
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
