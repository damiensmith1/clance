import { findHere, searchWeb, typeText } from "../../capabilities";
import { candidateSpans } from "../spans";
import type { Candidate, Context, Resolver } from "../types";

// The intents whose argument is a piece of what the user just said.
//
// Each one's candidates are spans of the utterance rather than things that
// exist on the Mac. That falls out of the existing shape with no new
// machinery: the decider picks a candidate by id, as it always has, and the
// id here is the span itself. What it picked gets copied verbatim into the
// action — Jev never writes a character (see spans.ts).

async function spanCandidates(ctx: Context): Promise<Candidate[]> {
  return candidateSpans(ctx.utterance).map((span) => ({ id: span, label: span }));
}

export const searchResolver: Resolver = {
  id: "search",
  // Typing into an address bar and pressing return is visible, undoable by
  // going back, and doesn't destroy anything.
  risk: "safe",
  candidates: spanCandidates,
  async resolve(candidate, ctx) {
    return {
      intent: "search",
      label: `Search for "${candidate.label}"`,
      risk: "safe",
      perform: () => searchWeb(candidate.label),
      undo: () => Promise.resolve({ ok: false as const, text: "Use “go back” to undo a search." }),
    };
  },
};

export const findResolver: Resolver = {
  id: "find",
  risk: "safe",
  candidates: spanCandidates,
  async resolve(candidate, ctx) {
    return {
      intent: "find",
      label: `Find "${candidate.label}" in ${ctx.app.name}`,
      risk: "safe",
      perform: () => findHere(candidate.label),
    };
  },
};

export const typeResolver: Resolver = {
  id: "type",
  // Puts words into whatever is focused. Not destructive, but it does land
  // in the user's document, so it sits above the floor rather than at it.
  risk: "safe",
  candidates: spanCandidates,
  async resolve(candidate, ctx) {
    return {
      intent: "type",
      label: `Type "${candidate.label}"`,
      risk: "safe",
      perform: () => typeText(candidate.label),
    };
  },
};
