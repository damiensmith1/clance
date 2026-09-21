import { navigate, NAVIGATE_INVERSE, type NavigateVerb } from "../../capabilities";
import type { Candidate, Resolver } from "../types";

// A fixed verb set, and the only resolver whose candidates don't depend on
// what's in front. Every one of these is `safe` by construction: bounded,
// and undone by doing the opposite.
const VERBS: { verb: NavigateVerb; label: string }[] = [
  { verb: "scrollDown", label: "Scroll down" },
  { verb: "scrollUp", label: "Scroll up" },
  { verb: "pageDown", label: "Page down" },
  { verb: "pageUp", label: "Page up" },
  { verb: "top", label: "Go to the top" },
  { verb: "bottom", label: "Go to the bottom" },
  { verb: "back", label: "Go back" },
  { verb: "forward", label: "Go forward" },
  { verb: "nextTab", label: "Next tab" },
  { verb: "previousTab", label: "Previous tab" },
];

export const navigateResolver: Resolver = {
  id: "navigate",
  risk: "safe",
  async candidates(): Promise<Candidate[]> {
    return VERBS.map((v) => ({ id: v.verb, label: v.label }));
  },
  async resolve(candidate) {
    const verb = candidate.id as NavigateVerb;
    const inverse = NAVIGATE_INVERSE[verb];
    return {
      intent: "navigate",
      label: candidate.label,
      risk: "safe",
      perform: () => navigate(verb),
      ...(inverse ? { undo: () => navigate(inverse) } : {}),
    };
  },
};
