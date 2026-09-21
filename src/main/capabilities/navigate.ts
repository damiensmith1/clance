import { type Outcome, ok, fail } from "./types";

// Moving around inside whatever is in front: scrolling, paging, jumping to
// the top or bottom, going back. Driven by keystrokes and the scroll wheel
// rather than the accessibility API, because scrolling is one of the few
// things almost no app exposes as an action — every app answers ⌘↑ and Page
// Down, and none of them publish "scroll down a bit" as a control.
//
// Deliberately a fixed verb set rather than anything open-ended: these are
// all `safe` (docs/design.md, "Risk and confirmation") precisely because
// each one is bounded and reversible by doing the opposite.
export type NavigateVerb =
  | "scrollDown"
  | "scrollUp"
  | "pageDown"
  | "pageUp"
  | "top"
  | "bottom"
  | "back"
  | "forward"
  | "nextTab"
  | "previousTab";

const LABELS: Record<NavigateVerb, string> = {
  scrollDown: "Scrolled down.",
  scrollUp: "Scrolled up.",
  pageDown: "Paged down.",
  pageUp: "Paged up.",
  top: "Jumped to the top.",
  bottom: "Jumped to the bottom.",
  back: "Went back.",
  forward: "Went forward.",
  nextTab: "Next tab.",
  previousTab: "Previous tab.",
};

// How far one "scroll down" goes. Three wheel notches is about a third of a
// screen in most apps — enough to be worth saying out loud, small enough
// that saying it twice isn't a surprise.
const SCROLL_STEPS = 3;

export async function navigate(verb: NavigateVerb): Promise<Outcome> {
  const { keyboard, mouse, Key } = await import("@nut-tree-fork/nut-js");

  const chord = async (...keys: number[]) => {
    await keyboard.pressKey(...keys);
    await keyboard.releaseKey(...keys);
  };

  try {
    switch (verb) {
      case "scrollDown":
        await mouse.scrollDown(SCROLL_STEPS);
        break;
      case "scrollUp":
        await mouse.scrollUp(SCROLL_STEPS);
        break;
      case "pageDown":
        await chord(Key.PageDown);
        break;
      case "pageUp":
        await chord(Key.PageUp);
        break;
      // ⌘↑/⌘↓ rather than Home/End: on a Mac, Home and End scroll the view
      // in some apps and move the cursor in others, while the command
      // chords mean "beginning of document" consistently.
      case "top":
        await chord(Key.LeftCmd, Key.Up);
        break;
      case "bottom":
        await chord(Key.LeftCmd, Key.Down);
        break;
      case "back":
        await chord(Key.LeftCmd, Key.Left);
        break;
      case "forward":
        await chord(Key.LeftCmd, Key.Right);
        break;
      case "nextTab":
        await chord(Key.LeftControl, Key.Tab);
        break;
      case "previousTab":
        await chord(Key.LeftControl, Key.LeftShift, Key.Tab);
        break;
    }
    return ok(LABELS[verb]);
  } catch (error) {
    return fail(`Couldn't ${verb}: ${(error as Error).message}`);
  }
}

// The opposite of each verb, where there is one — the assistant's first tier
// of undo (docs/design.md, "Acting").
export const NAVIGATE_INVERSE: Partial<Record<NavigateVerb, NavigateVerb>> = {
  scrollDown: "scrollUp",
  scrollUp: "scrollDown",
  pageDown: "pageUp",
  pageUp: "pageDown",
  back: "forward",
  forward: "back",
  nextTab: "previousTab",
  previousTab: "nextTab",
};
