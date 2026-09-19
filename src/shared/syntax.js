// A small, dependency-free syntax highlighter for the file viewer.
//
// Hand-rolled for the same reason the icon set and the layout store are: the
// job is narrow (colour code that is only ever read, never edited), and the
// alternatives are a vendored parser per language. It is deliberately
// conservative — it recognises comments, strings, numbers, keywords and a few
// punctuation-led shapes, and leaves everything else as plain text. Being
// wrong here should mean a word that isn't coloured, never a word that isn't
// shown.
//
// Everything is escaped before any tag of this file's own is introduced, the
// same order `markdown.js` uses, so a file containing markup can't inject it.

const KEYWORDS = {
  js: "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public return set static super switch this throw true try typeof var void while with yield",
  ts: "abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of override private protected public readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while yield",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
  sh: "case do done elif else esac export fi for function if in local read return set shift then until while",
  css: "and any-hover important media supports keyframes from to not only screen print",
  json: "true false null",
  yaml: "true false null yes no on off",
  html: "",
  md: "",
  txt: "",
};

// Which keyword set and comment style a file extension gets.
const LANGUAGES = {
  ts: { words: "ts", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  tsx: { words: "ts", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  mts: { words: "ts", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  cts: { words: "ts", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  js: { words: "js", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  jsx: { words: "js", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  mjs: { words: "js", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  cjs: { words: "js", line: "//", block: ["/*", "*/"], strings: `"'\`` },
  json: { words: "json", line: null, block: null, strings: `"` },
  css: { words: "css", line: null, block: ["/*", "*/"], strings: `"'` },
  html: { words: "html", line: null, block: ["<!--", "-->"], strings: `"'` },
  md: { words: "md", line: null, block: null, strings: "" },
  py: { words: "py", line: "#", block: null, strings: `"'` },
  sh: { words: "sh", line: "#", block: null, strings: `"'` },
  zsh: { words: "sh", line: "#", block: null, strings: `"'` },
  bash: { words: "sh", line: "#", block: null, strings: `"'` },
  yml: { words: "yaml", line: "#", block: null, strings: `"'` },
  yaml: { words: "yaml", line: "#", block: null, strings: `"'` },
  toml: { words: "yaml", line: "#", block: null, strings: `"'` },
  txt: { words: "txt", line: null, block: null, strings: "" },
};

const keywordSets = new Map();
function keywordsFor(name) {
  if (!keywordSets.has(name)) keywordSets.set(name, new Set((KEYWORDS[name] ?? "").split(" ").filter(Boolean)));
  return keywordSets.get(name);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function span(kind, text) {
  return `<span class="tok-${kind}">${escapeHtml(text)}</span>`;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * Highlights one line. `state` carries whether the previous line left an
 * unterminated block comment open, so a multi-line comment stays one colour
 * all the way down; the caller threads it through the file and it is the only
 * thing a line needs from the lines above it.
 *
 * Returns escaped HTML — never raw input.
 */
export function highlightLine(line, language, state = { block: false }) {
  const spec = LANGUAGES[language] ?? LANGUAGES.txt;
  const words = keywordsFor(spec.words);
  let out = "";
  let i = 0;

  // A block comment still open from an earlier line.
  if (state.block && spec.block) {
    const end = line.indexOf(spec.block[1]);
    if (end === -1) return { html: span("comment", line), state };
    out += span("comment", line.slice(0, end + spec.block[1].length));
    i = end + spec.block[1].length;
    state = { block: false };
  }

  // Markdown is prose with punctuation, not code — headings and fences are
  // the only things worth marking, and keyword colouring would be noise.
  if (language === "md") {
    const rest = line.slice(i);
    if (/^\s*#{1,6}\s/.test(rest)) return { html: span("keyword", rest), state };
    if (/^\s*```/.test(rest)) return { html: span("comment", rest), state };
    return { html: escapeHtml(rest), state };
  }

  let plain = "";
  const flush = () => {
    if (plain) {
      out += escapeHtml(plain);
      plain = "";
    }
  };

  while (i < line.length) {
    const rest = line.slice(i);

    if (spec.block && rest.startsWith(spec.block[0])) {
      flush();
      const end = line.indexOf(spec.block[1], i + spec.block[0].length);
      if (end === -1) {
        out += span("comment", rest);
        return { html: out, state: { block: true } };
      }
      out += span("comment", line.slice(i, end + spec.block[1].length));
      i = end + spec.block[1].length;
      continue;
    }

    if (spec.line && rest.startsWith(spec.line)) {
      flush();
      out += span("comment", rest);
      return { html: out, state };
    }

    const quote = line[i];
    if (spec.strings.includes(quote)) {
      flush();
      let j = i + 1;
      // A backslash escapes the next character, including the quote itself.
      while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
      out += span("string", line.slice(i, Math.min(j + 1, line.length)));
      i = j + 1;
      continue;
    }

    if (DIGIT.test(quote) && !IDENT.test(line[i - 1] ?? "")) {
      flush();
      let j = i;
      while (j < line.length && /[0-9a-fA-FxXoObB._]/.test(line[j])) j += 1;
      out += span("number", line.slice(i, j));
      i = j;
      continue;
    }

    if (IDENT_START.test(quote)) {
      let j = i;
      while (j < line.length && IDENT.test(line[j])) j += 1;
      const word = line.slice(i, j);
      if (words.has(word)) {
        flush();
        out += span("keyword", word);
      } else if (line[j] === "(") {
        flush();
        out += span("call", word);
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += quote;
    i += 1;
  }

  flush();
  return { html: out, state };
}

/** Whether a file extension gets anything more than plain text. */
export function isHighlightable(language) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, language);
}
