import { readSelection, type Outcome } from "../../capabilities";
import { viaBridge } from "../bridge";
import type { Candidate, Context, Resolver } from "../types";

// The way out.
//
// Anything that needs reasoning, reading, writing or judgement isn't the
// assistant's job — it's a session's. This resolver is also the fallback
// for anything no other resolver claimed, which is what stops the assistant
// ever dead-ending on "nothing happened" (docs/assistant.md, "Handing off").
export const claudeResolver: Resolver = {
  id: "claude",
  risk: "safe",
  async candidates(): Promise<Candidate[]> {
    // Always available and never a list: the decider escalates by saying
    // so, not by picking one of these.
    return [{ id: "ask", label: "Ask Claude" }];
  },
  async resolve(candidate, ctx) {
    return {
      intent: "claude",
      label: "Hand to Claude",
      risk: "safe",
      perform: () => handOff(candidate.label, ctx),
    };
  },
};

/**
 * Starts a session on what the user said, with what it needs to begin:
 * their words, the app and window they were in, and the selection if there
 * was one. They shouldn't have to say it twice.
 *
 * Matching an *existing* session to the work in front of the user is the
 * same unsolved problem the Changes pane has, so this always mints a new
 * one for now.
 */
export async function handOff(utterance: string, ctx: Context): Promise<Outcome> {
  const selection = await readSelection();
  const lines = [
    utterance,
    "",
    `(Asked by voice from ${ctx.app.name}${ctx.app.windowTitle ? ` — ${ctx.app.windowTitle}` : ""}.)`,
  ];
  if (selection.ok && "text" in selection && selection.text.trim() && !/^Nothing is selected/.test(selection.text)) {
    lines.push("", "The selection at the time was:", "", selection.text);
  }
  const result = await viaBridge("hand this to Claude", (bridge) =>
    bridge.openWidgetSession(lines.join("\n"))
  );
  return result.ok ? { ok: true, text: "Handed to a Claude Code session." } : result;
}
