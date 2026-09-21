import type { Outcome } from "../../capabilities";
import { readConfig, writeConfig } from "../../config";
import { floorFor } from "../thresholds";
import type { Resolution } from "../types";

// Performing, one at a time.
//
// Commands are queued in the order they were committed and run serially: a
// command spoken while the previous one is still running waits rather than
// racing it. Two AX actions interleaving is how an assistant clicks Send on
// the wrong window (docs/assistant.md, "Listening and acting").

export type Performed = {
  resolution: Resolution;
  outcome: Outcome;
};

type Queued = {
  resolution: Resolution;
  resolve(performed: Performed): void;
};

const queue: Queued[] = [];
let running = false;

// The single most recent action, which is all "undo that" reaches. A
// history the user can walk back through is deliberately not built yet —
// see docs/assistant.md, "Open".
let lastPerformed: Performed | null = null;

export function lastAction(): Performed | null {
  return lastPerformed;
}

export function forgetLastAction(): void {
  lastPerformed = null;
}

export function perform(resolution: Resolution): Promise<Performed> {
  return new Promise((resolve) => {
    queue.push({ resolution, resolve });
    void drain();
  });
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      let outcome: Outcome;
      try {
        outcome = await next.resolution.perform();
      } catch (error) {
        outcome = { ok: false, text: `${next.resolution.label} failed: ${(error as Error).message}` };
      }
      const performed = { resolution: next.resolution, outcome };
      // Only a success is worth being able to undo. An action that didn't
      // happen has nothing to take back, and offering to undo it would
      // imply it did.
      if (outcome.ok) lastPerformed = performed;
      next.resolve(performed);
    }
  } finally {
    running = false;
  }
}

/** Drops anything queued but not yet started. What's running finishes. */
export function clearQueue(): void {
  while (queue.length > 0) {
    const dropped = queue.shift();
    dropped?.resolve({
      resolution: dropped.resolution,
      outcome: { ok: false, text: `Cancelled before "${dropped.resolution.label}" ran.` },
    });
  }
}

export function queueDepth(): number {
  return queue.length;
}

/**
 * Undo, in three tiers, tried in order: the resolution's own inverse where
 * it has one, the app's own undo where the app accepts it, and otherwise
 * saying plainly that it can't — which is precisely the set of things that
 * were confirmed on the way in.
 */
export async function undoLast(): Promise<Outcome> {
  const last = lastPerformed;
  if (!last) return { ok: false, text: "There's nothing to undo." };
  if (!last.resolution.undo) {
    return { ok: false, text: `"${last.resolution.label}" can't be undone.` };
  }
  try {
    const outcome = await last.resolution.undo();
    if (outcome.ok) lastPerformed = null;
    return outcome;
  } catch (error) {
    return { ok: false, text: `Couldn't undo "${last.resolution.label}": ${(error as Error).message}` };
  }
}

/**
 * Whether an action gets performed straight away or asked about first.
 *
 * Three independent reasons to ask, in the order they're cheapest to
 * check. The confidence floors live in ../thresholds.ts, in one place,
 * because they are the numbers this feature lives or dies by and they were
 * previously scattered and set far too high — an assistant that is certain
 * and asks anyway is worse than useless.
 */
export function needsConfirmation(
  resolution: Resolution,
  confidence: number,
  risky = false
): boolean {
  // 1. Not sure enough for this kind of action.
  if (confidence < floorFor(resolution.intent)) return true;
  // 2. The decider flagged it as destructive. This can only ever *raise*
  //    risk — an action already classified safe by its resolver becomes
  //    something to ask about, never the other way round.
  if (risky && !isAllowed(resolution)) return true;
  // 3. The intent is structurally risky, whatever the confidence.
  if (resolution.risk !== "confirm") return false;
  return !isAllowed(resolution);
}

export { floorFor as confirmThreshold };

// The noise a `confirm`-by-default makes is meant to be answered by the
// user allowing specific things, not by loosening the default. "Always
// allow this" adds one label; nothing here ever widens on its own.
function keyFor(resolution: Resolution): string {
  return `${resolution.intent}:${resolution.label}`;
}

export function isAllowed(resolution: Resolution): boolean {
  return readConfig().assistant.alwaysAllow.includes(keyFor(resolution));
}

export function alwaysAllow(resolution: Resolution): void {
  const config = readConfig();
  const key = keyFor(resolution);
  if (config.assistant.alwaysAllow.includes(key)) return;
  config.assistant.alwaysAllow = [...config.assistant.alwaysAllow, key];
  writeConfig(config);
}
