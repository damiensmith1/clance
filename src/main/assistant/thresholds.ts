import type { IntentId } from "./types";

// One reviewable place for every number the assistant gates on.
//
// These were previously scattered across the decider, the actuator and
// config, and — worse — derived by reasoning from TypeSafe's *generic*
// guidance, which is written around decisions like approving a bank
// transfer. A floor of 0.9 is right for moving money and wrong for clicking
// a link, and the result was an assistant that asked permission constantly
// while being perfectly certain.
//
// They are still not measured. They are now at least in the range that
// working implementations of this exact task use, and in one file, so that
// tuning them is a diff a person can read.

/** The model, pinned. */
// Aliases move on release and every number below is only meaningful against
// a particular version. `jev-latest` meant these were tuned — badly — against
// a moving target.
export const MODEL = "jev-1.13.0";

export const T = {
  /**
   * Is the user addressing Clance at all, rather than talking nearby?
   *
   * Measured across a live session, the separation is wide and the old
   * floor of 0.5 sat inside the noise rather than above it:
   *
   *     "Great job."                     0.15   ← not for us
   *     "(keyboard clicking)"            0.30   ← not even speech
   *     "Uh, repo link."                 0.63   ← filler; searched for it
   *     "Create a new tab."              0.94
   *     "Open Chrome."                   0.96
   *
   * Acting on a half-finished mutter is worse than missing it: the user
   * says it again, and an assistant that only ever misses is merely
   * useless where one that acts on stray words is unusable.
   */
  isCommand: 0.75,

  /** `intent` confidence needed to act on anything. */
  intent: 0.55,

  /**
   * `target` confidence below which the assistant asks which one rather
   * than pressing its best guess.
   *
   * This is the number that changes the feel of the whole thing. Low
   * confidence here is not a failure — it means several candidates look
   * alike, which is a question worth asking, and asking it is cheap.
   */
  target: 0.45,

  /** ...and the winning candidate must hold at least this much probability. */
  targetTopProb: 0.35,

  /** A span pick below this falls back to the longest heuristic span. */
  span: 0.35,

  /** `destructive` above this needs confirmation whatever the intent says. */
  destructive: 0.5,

  /** How many candidates to offer when asking "which one?". */
  candidateCount: 3,
} as const;

/**
 * Extra confidence required by intent, over `T.intent`.
 *
 * Only for the ones where being wrong costs something the user can't
 * shrug off. Everything absent from this list gates on `T.intent` alone —
 * which is most of them, deliberately.
 */
export const INTENT_FLOOR: Partial<Record<IntentId, number>> = {
  // Ends an app, possibly with unsaved work.
  quit: 0.8,
  // Writes into the user's document.
  type: 0.65,
  text: 0.65,
  // Opens a tab, but at an address — worth being a little surer than a
  // scroll before navigating somewhere.
  site: 0.6,
};

export function floorFor(intent: IntentId): number {
  return Math.max(T.intent, INTENT_FLOOR[intent] ?? 0);
}
