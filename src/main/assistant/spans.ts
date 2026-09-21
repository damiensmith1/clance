// Candidate spans: the pieces of what the user said that could be an
// argument.
//
// This is the whole answer to "who fills the query". Jev cannot write text,
// and that is a feature — so instead of asking it to produce "Jon Stewart",
// code over-generates every plausible slice of the utterance and Jev picks
// one. The value that comes back is a substring of the transcript, copied
// unchanged. It cannot invent a name, drop a word or misspell one.
//
// TypeSafe calls this find-and-pick and is explicit about the guarantee:
// "because TypeSafe only ever chooses among the spans the regex found, the
// value you get back is one of those spans, copied unchanged".

/** Beyond this, a span stops being an argument and starts being a sentence. */
const MAX_SPAN_WORDS = 10;

/** The cap on how many go in a question, chosen well inside `choice`'s 255. */
const MAX_SPANS = 40;

/**
 * Words that never start or end the thing being asked for.
 *
 * Deliberately only function words and the command verbs themselves —
 * trimming "search for" off the front of "search for Jon Stewart" is safe,
 * and trimming anything more opinionated would start discarding real
 * arguments. A span dropped here is unrecoverable, so the list stays short.
 */
const EDGE_WORDS = new Set([
  "search", "find", "look", "google", "web", "type", "write", "insert", "paste", "enter",
  "dictate", "open", "go", "please", "for", "up", "the", "a", "an", "to", "in", "on",
  "of", "and", "it", "that", "this", "about", "with", "into", "then",
]);
// "me" and "my" are deliberately absent: "near me" and "my email address"
// are argument content, not scaffolding, and a span trimmed here can never
// be recovered.

function isEdge(word: string): boolean {
  return EDGE_WORDS.has(word.toLowerCase());
}

// Trailing punctuation is whisper's, not the user's: "Jon Stewart." would
// otherwise be searched for with the full stop attached.
function tidy(span: string): string {
  return span.replace(/^[\s"'([]+/, "").replace(/[\s"')\].,!?;:]+$/, "").trim();
}

/**
 * Where the words are meant to go, which is not part of the words.
 *
 * "Type hello world **into the search box**" carries its own destination,
 * and without this the longest — therefore highest-ranked — span was
 * `"hello world into the search box"`, so the assistant would have typed
 * the instruction along with the text. Same for a trailing site: "search
 * for cats **on wikipedia**".
 *
 * Only ever *trailing*, and only before a word that names a destination,
 * so an argument that happens to contain "in" or "on" in the middle is
 * untouched.
 */
const TRAILING_DESTINATION =
  /\s+(?:in|into|on|onto|inside|to)\s+(?:the\s+)?(?:[\w-]+\s+){0,3}?(?:box|field|input|bar|form|textarea|search|address|omnibox|page|document|google|wikipedia|youtube|github|reddit|amazon|web)\b.*$/i;

function withoutDestination(utterance: string): string {
  const trimmed = utterance.replace(TRAILING_DESTINATION, "").trim();
  return trimmed.length >= 2 ? trimmed : utterance;
}

/**
 * Every plausible argument in an utterance, longest first.
 *
 * Longest first matters: it's the order `choice` shows the model, and a
 * complete phrase is nearly always the intended argument where a fragment
 * of it is not. Ties go to the span that starts later, since a command's
 * argument follows its verb.
 */
export function candidateSpans(utterance: string, max = MAX_SPANS): string[] {
  // Spans from the payload alone rank above spans from the whole sentence,
  // so "hello world" beats "hello world into the search box" without
  // either being unavailable — the destination phrase might, after all,
  // be part of what someone wanted typed.
  const payload = withoutDestination(utterance);
  if (payload !== utterance) {
    const first = spansOf(payload, max);
    const rest = spansOf(utterance, max).filter(
      (span) => !first.some((kept) => kept.toLowerCase() === span.toLowerCase())
    );
    return [...first, ...rest].slice(0, max);
  }
  return spansOf(utterance, max);
}

function spansOf(utterance: string, max: number): string[] {
  const words = utterance.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const found = new Map<string, { span: string; length: number; start: number }>();
  for (let start = 0; start < words.length; start++) {
    if (isEdge(words[start])) continue;
    for (let length = 1; length <= MAX_SPAN_WORDS && start + length <= words.length; length++) {
      const end = start + length - 1;
      if (isEdge(words[end])) continue;
      const span = tidy(words.slice(start, start + length).join(" "));
      if (!span) continue;
      const key = span.toLowerCase();
      // First writer wins, and spans are generated left to right, so the
      // earliest occurrence of a repeated phrase is the one kept.
      if (!found.has(key)) found.set(key, { span, length, start });
    }
  }

  return [...found.values()]
    .sort((a, b) => b.length - a.length || b.start - a.start)
    .slice(0, max)
    .map((entry) => entry.span);
}
