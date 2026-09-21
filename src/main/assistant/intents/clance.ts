import { viaBridge } from "../bridge";
import type { Candidate, Resolver } from "../types";

// Clance's own verbs — the small set of things the assistant can do to the
// app it lives in. A fixed list, because unlike every other resolver these
// aren't read from anywhere: they're what Clance is.
//
// Dictation isn't here even though it is Clance's. It belongs to the `text`
// intent, which is where "put words somewhere" lives — listing it in both
// would hand the decider two near-identical options under two intents and
// make a coin toss out of something unambiguous.
export const clanceResolver: Resolver = {
  id: "clance",
  risk: "safe",
  async candidates(): Promise<Candidate[]> {
    return [
      { id: "session", label: "Start a Claude Code session" },
      { id: "chats", label: "Show my sessions" },
      { id: "dictation", label: "Show my dictation history" },
      { id: "settings", label: "Open Clance settings" },
    ];
  },
  async resolve(candidate) {
    switch (candidate.id) {
      case "session":
        return {
          intent: "clance",
          label: "New Claude Code session",
          risk: "safe",
          perform: () => viaBridge("open a session", (bridge) => bridge.openWidgetSession("")),
        };
      case "chats":
      case "dictation":
      case "settings":
        return {
          intent: "clance",
          label: candidate.label,
          risk: "safe",
          perform: () =>
            viaBridge(candidate.label.toLowerCase(), (bridge) =>
              bridge.openSection(candidate.id as "chats" | "dictation" | "settings")
            ),
        };
      default:
        return null;
    }
  },
};
