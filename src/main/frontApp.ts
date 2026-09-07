import type { Window } from "@nut-tree-fork/nut-js";

// Captured right before the popup window steals focus, so a proposed
// text edit can be typed back into whatever the user was actually working
// in. `@nut-tree-fork/nut-js` (and its zod-adjacent-style native "libnut"
// binding) is CJS but ships a native binary, so it's dynamic-imported here
// the same way the ESM-only Agent SDK is elsewhere in this codebase — it
// also sidesteps loading (and rebuilding) it at all until this feature is
// actually used.
let capturedWindow: Window | null = null;

export async function captureFrontmostWindow(): Promise<void> {
  try {
    const { getActiveWindow } = await import("@nut-tree-fork/nut-js");
    capturedWindow = await getActiveWindow();
  } catch {
    capturedWindow = null;
  }
}

export async function typeIntoCapturedWindow(text: string): Promise<void> {
  const { keyboard } = await import("@nut-tree-fork/nut-js");

  if (capturedWindow) {
    try {
      await capturedWindow.focus();
      // OS-level focus changes aren't always instantaneous; give the
      // target app a moment to actually receive the focus before typing.
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch {
      // Best effort — fall through and type wherever focus actually is.
    }
  }

  await keyboard.type(text);
}
