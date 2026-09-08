import type { Window } from "@nut-tree-fork/nut-js";
import { clipboard } from "electron";

// Captured right before the popup window steals focus, so a proposed
// text edit can be typed back into whatever the user was actually working
// in. `@nut-tree-fork/nut-js` (and its zod-adjacent-style native "libnut"
// binding) is CJS but ships a native binary, so it's dynamic-imported here
// the same way the ESM-only Agent SDK is elsewhere in this codebase — it
// also sidesteps loading (and rebuilding) it at all until this feature is
// actually used.
let capturedWindow: Window | null = null;

// Returns the captured window's title (e.g. "Design.md — Obsidian"), used
// to tell the popup's Claude CLI session which app it was invoked over.
export async function captureFrontmostWindow(): Promise<string | undefined> {
  try {
    const { getActiveWindow } = await import("@nut-tree-fork/nut-js");
    capturedWindow = await getActiveWindow();
    return await capturedWindow.title;
  } catch {
    capturedWindow = null;
    return undefined;
  }
}

// Pastes rather than simulates individual keystrokes — `keyboard.type()`
// sends one synthetic keypress per character with a fixed inter-key delay,
// which is noticeably slow for anything longer than a sentence and gets
// worse linearly with text length. A clipboard paste (Cmd+V) delivers the
// whole string in one OS-level event regardless of length, at the cost of
// briefly overwriting the user's clipboard — restored a moment later, once
// the paste has had time to land.
export async function typeIntoCapturedWindow(text: string): Promise<void> {
  const { keyboard, Key } = await import("@nut-tree-fork/nut-js");

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

  // Text-only restore — if the clipboard held something else (an image,
  // files), that's lost. Acceptable for v1; revisit if it turns out to matter.
  const previousClipboardText = await clipboard.readText();
  await clipboard.writeText(text);
  try {
    await keyboard.pressKey(Key.LeftCmd, Key.V);
    await keyboard.releaseKey(Key.LeftCmd, Key.V);
  } finally {
    // Give the target app time to actually read the clipboard before
    // putting the user's previous content back.
    setTimeout(() => void clipboard.writeText(previousClipboardText), 500);
  }
}
