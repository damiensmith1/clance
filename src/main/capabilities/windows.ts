import { screen } from "electron";
import * as ax from "../ax";
import { type Outcome, ok, fail } from "./types";
import { resolveReadTarget } from "./target";

// Where a window should end up. A named arrangement rather than coordinates:
// nobody says "put it at 0,25 by 1280 by 775", and a fraction of the display
// is the only form that means the same thing on every screen.
export type Arrangement =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight"
  | "centre"
  | "maximise";

const FRACTIONS: Record<Arrangement, { x: number; y: number; width: number; height: number }> = {
  left: { x: 0, y: 0, width: 0.5, height: 1 },
  right: { x: 0.5, y: 0, width: 0.5, height: 1 },
  top: { x: 0, y: 0, width: 1, height: 0.5 },
  bottom: { x: 0, y: 0.5, width: 1, height: 0.5 },
  topLeft: { x: 0, y: 0, width: 0.5, height: 0.5 },
  topRight: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
  bottomLeft: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
  bottomRight: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  centre: { x: 0.15, y: 0.1, width: 0.7, height: 0.8 },
  maximise: { x: 0, y: 0, width: 1, height: 1 },
};

export const ARRANGEMENT_LABELS: Record<Arrangement, string> = {
  left: "the left half",
  right: "the right half",
  top: "the top half",
  bottom: "the bottom half",
  topLeft: "the top-left quarter",
  topRight: "the top-right quarter",
  bottomLeft: "the bottom-left quarter",
  bottomRight: "the bottom-right quarter",
  centre: "the centre",
  maximise: "the whole screen",
};

// `workArea`, not `bounds` — it excludes the menu bar and the Dock, so a
// maximised window doesn't slide underneath either of them. Chosen by where
// the window already is, so arranging a window on a second display keeps it
// on that display.
function workAreaFor(frame: ax.AxFrame | undefined) {
  const point = frame
    ? { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) }
    : screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point).workArea;
}

export type WindowMove = { previous?: ax.AxFrame; handle: number; pid?: number };

/**
 * Applies a frame, position then size then position again.
 *
 * Not ceremony: macOS clamps a window's size to what fits on screen *from
 * its current origin*, so growing a window that is sitting low down
 * silently comes back short — measured against a real window, a request
 * for 1470×923 landed as 1470×671 because the origin was still at y=285.
 * Moving first, sizing, then moving again gets both. The last read is
 * deliberately through `focusedWindow` rather than the handle: while an app
 * is animating its own layout, a describe() of the handle returns frames
 * that are neither the old one nor the new one.
 */
async function applyFrame(
  handle: number,
  frame: { x: number; y: number; width: number; height: number },
  pid?: number
): Promise<boolean> {
  await ax.setFrame(handle, { x: frame.x, y: frame.y });
  const sized = await ax.setFrame(handle, { width: frame.width, height: frame.height });
  const positioned = await ax.setFrame(handle, { x: frame.x, y: frame.y });
  if (!sized && !positioned) return false;
  // A window with a minimum size, or one an app insists on, ends up close
  // rather than exact — which is a success, not a failure to report.
  await new Promise((settled) => setTimeout(settled, 120));
  const after = await ax.focusedWindow(pid);
  if (!after?.frame) return true;
  return Math.abs(after.frame.x - frame.x) <= 12 || Math.abs(after.frame.width - frame.width) <= 12;
}

/**
 * Puts the frontmost window of an app somewhere on its display. Returns the
 * frame it had first, so the assistant's undo can put it back — which is
 * what makes arranging a window `safe` rather than something to confirm.
 */
export async function arrangeWindow(
  arrangement: Arrangement,
  app?: string
): Promise<Outcome & { move?: WindowMove }> {
  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  const window = await ax.focusedWindow(target.pid);
  if (!window) return fail(`${target.label} has no window in front to move.`);

  const area = workAreaFor(window.frame);
  const fraction = FRACTIONS[arrangement];
  const moved = await applyFrame(
    window.handle,
    {
      x: Math.round(area.x + fraction.x * area.width),
      y: Math.round(area.y + fraction.y * area.height),
      width: Math.round(fraction.width * area.width),
      height: Math.round(fraction.height * area.height),
    },
    target.pid
  );

  if (!moved) {
    // Plenty of windows refuse: anything already full-screen, and any
    // window an app has pinned to a fixed size.
    return fail(`${target.label} wouldn't let its window be moved.`);
  }
  return {
    ...ok(`Moved ${target.label} to ${ARRANGEMENT_LABELS[arrangement]}.`),
    move: { handle: window.handle, previous: window.frame, pid: target.pid },
  };
}

/** Puts a window back where arrangeWindow found it. */
export async function restoreWindow(move: WindowMove): Promise<Outcome> {
  if (!move.previous) return fail("There's no earlier position to put that window back to.");
  const restored = await applyFrame(move.handle, move.previous, move.pid);
  return restored ? ok("Put the window back.") : fail("The window wouldn't move back.");
}
