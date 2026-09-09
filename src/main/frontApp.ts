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

// Grabs whatever text was highlighted in the frontmost app at invocation
// time, so the popup can hand it to the CLI as focused context — must run
// before the popup steals focus, same as captureFrontmostWindow. There's no
// OS API to just ask "what's selected" generically across apps (that's the
// accessibility-tree read docs/design.md still defers), so this simulates
// Cmd+C and reads back the clipboard instead — the same trick
// typeIntoCapturedWindow uses in reverse, and the same trade-off (briefly
// overwrites the user's real clipboard, restored right after). The
// clipboard is cleared to an empty sentinel *before* the copy, rather than
// diffed against its previous contents, so "nothing selected" (copy is a
// no-op) is distinguishable from "selection happens to match whatever was
// already on the clipboard."
export async function captureSelectedText(): Promise<string | undefined> {
  try {
    const { keyboard, Key } = await import("@nut-tree-fork/nut-js");

    const previousClipboardText = await clipboard.readText();
    await clipboard.writeText("");
    await keyboard.pressKey(Key.LeftCmd, Key.C);
    await keyboard.releaseKey(Key.LeftCmd, Key.C);
    // Give the frontmost app a moment to actually write the selection to
    // the pasteboard before reading it back.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const copied = await clipboard.readText();
    await clipboard.writeText(previousClipboardText);

    return copied.trim().length > 0 ? copied : undefined;
  } catch {
    return undefined;
  }
}

// Lists every currently open window's title, so the CLI can see what's
// running and ask to redirect insert_text there by name (e.g. "put this in
// Slack" while the captured/frontmost window is something else entirely) —
// otherwise insert_text can only ever type into whatever was frontmost the
// moment the hotkey was pressed. Best-effort/no permission check of its own:
// it's read-only (no keystroke injection), but in practice only ever called
// alongside insert_text, which is already gated on Accessibility.
export async function listOpenWindows(): Promise<string[]> {
  try {
    const { getWindows } = await import("@nut-tree-fork/nut-js");
    const windows = await getWindows();
    const titles = await Promise.all(windows.map((w) => w.title.catch(() => "")));
    return titles.map((t) => t.trim()).filter((t) => t.length > 0);
  } catch {
    return [];
  }
}

// Finds the first open window whose title contains `hint` (case-insensitive
// substring — window titles are things like "Slack | #general", so an exact
// match would be brittle), for insert_text's optional app-redirect.
async function findWindowByTitleHint(hint: string): Promise<Window | null> {
  try {
    const { getWindows } = await import("@nut-tree-fork/nut-js");
    const windows = await getWindows();
    const needle = hint.toLowerCase();
    for (const w of windows) {
      const title = await w.title.catch(() => "");
      if (title.toLowerCase().includes(needle)) return w;
    }
    return null;
  } catch {
    return null;
  }
}

// Pastes rather than simulates individual keystrokes — `keyboard.type()`
// sends one synthetic keypress per character with a fixed inter-key delay,
// which is noticeably slow for anything longer than a sentence and gets
// worse linearly with text length. A clipboard paste (Cmd+V) delivers the
// whole string in one OS-level event regardless of length, at the cost of
// briefly overwriting the user's clipboard — restored a moment later, once
// the paste has had time to land.
//
// `appHint`, when given, retargets the paste at the first open window whose
// title matches it instead of the window captured at hotkey-press — how a
// session redirects output to an app other than the one it was invoked
// over (see listOpenWindows above). Falls back to the captured window if no
// match is found, same as if no hint were given at all.
export async function typeIntoCapturedWindow(text: string, appHint?: string): Promise<void> {
  const { keyboard, Key } = await import("@nut-tree-fork/nut-js");

  const target = (appHint && (await findWindowByTitleHint(appHint))) || capturedWindow;
  if (target) {
    try {
      await target.focus();
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
