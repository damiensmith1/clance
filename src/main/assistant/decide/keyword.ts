import type { Candidate, Decider, Decision, IntentId, Situation } from "../types";
import { log } from "../log";

// String matching over the same candidate lists Jev is given.
//
// Not a toy: it is the test double, it is what runs with the decision
// service switched off in Settings, and it is the fallback when Jev is
// unreachable. The assistant degrades to "the commands it can recognise
// locally" rather than to nothing (docs/assistant.md, "When things fail").

// The verb that opens a command tells you the intent most of the time, and
// this is exactly the sort of brittle lexicon a model exists to replace —
// which is the point. It gets the common phrasings and admits it doesn't
// know the rest, rather than guessing.
// `claims` marks a cue whose verb settles the intent on its own. "quit" can
// only be a quit; "open" can be an app *or* an app's own command ("Open
// Location", "Open a new tab"), so it is deliberately not allowed to lock
// out the menu fallback when it finds no app by that name.
const INTENT_CUES: { intent: IntentId; pattern: RegExp; claims?: boolean }[] = [
  // Before `launch`, because "open YouTube" is a website and "open Notes"
  // is an app, and neither cue claims the utterance outright.
  { intent: "site", pattern: /^(open|go to|visit|take me to|pull up)\s+/i },
  { intent: "launch", pattern: /^(open|launch|start|run)\s+/i },
  { intent: "switch", pattern: /^(switch to|go to|show me|bring up)\s+/i },
  { intent: "quit", pattern: /^(quit|close)\s+(?:the\s+)?app\b|^quit\s+/i, claims: true },
  { intent: "navigate", pattern: /^(scrolling|scroll|paging|page|go (?:to the )?(?:top|bottom|back|forward)|next tab|previous tab|back|forward|top|bottom|up|down)\b/i },
  { intent: "window", pattern: /\b(left half|right half|top half|bottom half|maximi[sz]e|full ?screen|centre|center|corner|quarter)\b/i },
  // "start dictating", "now dictate", "type into" — a spoken command rarely
  // arrives as a bare imperative.
  // The content-carrying verbs come first: "type John Stewart" is a `type`,
  // not a request to start dictating, and the two were indistinguishable
  // while `text` owned both.
  { intent: "search", pattern: /^(?:please )?(search|google|look up)\b/i, claims: true },
  { intent: "find", pattern: /^(?:please )?(find|locate)\b/i, claims: true },
  // Just "type". "write" and "enter" were tried and are traps: "write me a
  // limerick" is a request to Claude, not four words to paste, and "enter
  // full screen" is a menu command. Jev can tell those apart from the
  // `not_for` on the intent; a regex cannot, and a wrong guess here types
  // the user's own sentence into their document.
  { intent: "type", pattern: /^(?:please )?type\b/i, claims: true },
  { intent: "text", pattern: /^(?:start |begin |now )?(dictate|dictating|dictation|insert|paste)\b/i },
  { intent: "clance", pattern: /\b(clance|settings|my sessions|dictation history)\b/i },
  { intent: "target", pattern: /^(click|press|tap|focus|select)\s+/i },
];

// Stripped before matching a candidate, so "open the Notes app" finds
// "Notes".
const FILLER = /\b(the|a|an|please|app|application|window|button|field|now|just)\b/gi;

function normalise(text: string): string {
  return text.toLowerCase().replace(FILLER, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Two words match if they're the same, or share a long enough stem.
 *
 * This is what a speaker does to a verb and a transcriber does to a
 * speaker — "dictating"/"dictate", "scrolling"/"scroll",
 * "settings"/"setting" — without a stemmer. Note it's the *common prefix*
 * that has to be long, not one word being a prefix of the other:
 * "dictating" and "dictate" diverge at the seventh character, so neither
 * contains the other and only the shared "dictat" relates them.
 *
 * Five characters keeps "to"/"top" and "tab"/"table" apart; the length
 * limit keeps "convert"/"conversation" apart, which five characters alone
 * would not.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 3) return false;
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared++;
  return shared >= 5;
}

function bestMatch(phrase: string, candidates: Candidate[]): { candidate: Candidate; score: number } | null {
  const needle = normalise(phrase);
  if (!needle) return null;
  const needleWords = needle.split(" ").filter(Boolean);
  let best: { candidate: Candidate; score: number } | null = null;
  for (const candidate of candidates) {
    const label = normalise(candidate.label);
    if (!label) continue;
    // Exact, then contained, then how much of what the *user said* the
    // label accounts for. Scoring against the user's words rather than the
    // label's is what makes a long label reachable: "the address bar" is
    // all three of the user's words and only three of the omnibox's eight,
    // and the first of those is the question worth asking. The scores
    // double as the confidence the risk gate reads, so they're spread
    // rather than bunched at the top.
    let score = 0;
    if (label === needle) score = 1;
    else if (needle.includes(label) || label.includes(needle)) score = 0.8;
    else {
      const labelWords = label.split(" ").filter(Boolean);
      const shared = needleWords.filter((word) => labelWords.some((other) => sameWord(word, other))).length;
      if (shared > 0) {
        score = (shared / needleWords.length) * 0.7;
        // Break ties towards the tighter label, so a phrase that fits
        // several options picks the one carrying least else.
        score -= Math.min(0.1, (labelWords.length - shared) * 0.01);
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { candidate, score };
  }
  return best && best.score >= 0.4 ? best : null;
}

export class KeywordDecider implements Decider {
  readonly name = "local matching";

  async decide(situation: Situation): Promise<Decision> {
    const utterance = situation.utterance.trim();
    if (!utterance) return { kind: "wait" };

    // One step, and then it stops — see the missing `finished` on this
    // class. Judging whether a goal has been reached means comparing a
    // screen against an intention, which is exactly what string matching
    // cannot do, so the session ends the loop after its single step and
    // the assistant degrades to the voice command line it was before.
    if (situation.done.length > 0) return { kind: "done" };

    // The intent cue tells us which candidate list to search, and what's
    // left after the cue is the target.
    //
    // Several cues can legitimately fire on one phrase — "go to the top" is
    // both a `switch` ("go to …") and a `navigate` — so a cue that matches
    // and finds nothing hands on to the next one.
    let cued = false;
    for (const { intent, pattern, claims } of INTENT_CUES) {
      const match = utterance.match(pattern);
      if (!match) continue;
      if (claims) cued = true;
      // What follows the cue is the target. When nothing does — "start
      // dictating", "scroll" — fall back to the cue's own verb rather than
      // the whole utterance, so the words that only said *which kind of
      // command this is* don't then dilute the match for *which one*.
      const remainder = utterance.slice(match[0].length).trim() || match[1] || utterance;
      const candidates = situation.candidates[intent] ?? [];
      // A span intent's candidates *are* slices of this utterance, so
      // matching words against them would be circular. What follows the
      // verb is the argument, so take the longest span that is a prefix of
      // it — which is the whole remainder when one was generated for it.
      if (intent === "search" || intent === "find" || intent === "type") {
        // Whisper punctuates: "Type John Stewart." leaves a full stop on the
        // remainder that no generated span carries.
        const wanted = remainder.trim().toLowerCase().replace(/[\s.,!?;:]+$/, "");
        const span =
          candidates.find((candidate) => candidate.label.toLowerCase() === wanted) ??
          candidates.find((candidate) => wanted.endsWith(candidate.label.toLowerCase()));
        if (span) {
          log(`local: "${match[0].trim()}" → ${intent}, "${span.label}"`);
          // 0.8 rather than 1: the verb is certain, the span boundary is
          // a guess, and this is exactly where a model does better.
          return { kind: "resolved", intent, candidateId: span.id, confidence: 0.8 };
        }
        continue;
      }

      const best = bestMatch(remainder, candidates);
      if (best) {
        log(`local: "${match[0].trim()}" → ${intent}, "${best.candidate.label}" (${best.score.toFixed(2)})`);
        return {
          kind: "resolved",
          intent,
          candidateId: best.candidate.id,
          confidence: best.score,
        };
      }
      // A window arrangement is named by the whole phrase rather than by
      // what follows a verb, so it gets one more go at the full utterance.
      const whole = bestMatch(utterance, candidates);
      if (whole) {
        log(`local: whole phrase → ${intent}, "${whole.candidate.label}" (${whole.score.toFixed(2)})`);
        return { kind: "resolved", intent, candidateId: whole.candidate.id, confidence: whole.score };
      }
      // The cue fired but nothing in that intent matched. Worth saying —
      // it's the difference between "I didn't understand the verb" and "I
      // understood it and the thing you named isn't here".
      log(`local: "${match[0].trim()}" looked like ${intent}, but nothing matched "${remainder}"`);
    }

    // No cue: the frontmost app's own menu commands are the likeliest thing
    // an uncued phrase means ("save", "new note", "close tab").
    //
    // Strictly *no* cue. A phrase that named an intent and then failed to
    // find its target must not be re-read as a menu command — "quit
    // Discord" with Discord not running once landed on a Recent Items entry
    // called "Discord" and pressed it, safe-risk and unconfirmed, which is
    // the precise shape of the surprise this assistant must never produce.
    // Having understood the verb, the honest answers are "that isn't here"
    // or "ask Claude", never "here's something with a similar name".
    if (cued) {
      log(`local: understood the verb in "${utterance}" but not the target — escalating`);
      return { kind: "escalate", prompt: utterance };
    }

    const menu = bestMatch(utterance, situation.candidates.menu ?? []);
    if (menu && menu.score >= 0.8) {
      const ties = (situation.candidates.menu ?? []).filter(
        (candidate) => normalise(candidate.label) === normalise(menu.candidate.label)
      );
      if (ties.length > 1) {
        log(`local: "${utterance}" matches ${ties.length} menu commands — asking`);
        return { kind: "ambiguous", intent: "menu", among: ties };
      }
      log(`local: uncued → menu, "${menu.candidate.label}" (${menu.score.toFixed(2)})`);
      return { kind: "resolved", intent: "menu", candidateId: menu.candidate.id, confidence: menu.score };
    }

    // Everything else is a session's problem, which is the honest answer
    // rather than pressing something approximate.
    log(`local: no cue matched "${utterance}" and no menu command came close`);
    return { kind: "escalate", prompt: utterance };
  }
}
