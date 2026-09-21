import { arrangeWindow, restoreWindow, ARRANGEMENT_LABELS, type Arrangement, type WindowMove } from "../../capabilities";
import type { Candidate, Resolver } from "../types";

// Moving the window in front around its display. Safe: the frame it had is
// captured on the way in, so "put it back" is a real inverse rather than a
// guess at what the user had before.
export const windowResolver: Resolver = {
  id: "window",
  risk: "safe",
  async candidates(): Promise<Candidate[]> {
    return (Object.keys(ARRANGEMENT_LABELS) as Arrangement[]).map((arrangement) => ({
      id: arrangement,
      label: `Move the window to ${ARRANGEMENT_LABELS[arrangement]}`,
    }));
  },
  async resolve(candidate, ctx) {
    const arrangement = candidate.id as Arrangement;
    let move: WindowMove | undefined;
    return {
      intent: "window",
      label: `${ctx.app.name} → ${ARRANGEMENT_LABELS[arrangement]}`,
      risk: "safe",
      perform: async () => {
        const result = await arrangeWindow(arrangement);
        move = result.move;
        return result;
      },
      undo: async () =>
        move
          ? restoreWindow(move)
          : { ok: false as const, text: "That window was never moved, so there's nothing to put back." },
    };
  },
};
