import type { Window } from "@nut-tree-fork/nut-js";
import { clipboard, screen } from "electron";
import { sanitizeWindowTitle } from "./windowTitle";
import { frontmostApp, type AxApp } from "./ax";

// Captured right before the popup window steals focus, so a proposed
// text edit can be typed back into whatever the user was actually working
// in. `@nut-tree-fork/nut-js` (and its zod-adjacent-style native "libnut"
// binding) is CJS but ships a native binary, so it's dynamic-imported here
// the same way the ESM-only Agent SDK is elsewhere in this codebase — it
// also sidesteps loading (and rebuilding) it at all until this feature is
// actually used.
let capturedWindow: Window | null = null;

// The app that was in front at that same moment, kept separately because
// nut-js's window handle carries no pid and the accessibility tools need
// one: once the widget has focus, "the frontmost app" is Clance, and the
// app worth reading is this one (see ax.ts and the read_* tools).
let capturedApp: AxApp | null = null;

// Returns the captured window's title (e.g. "Design.md — Obsidian"), used
// to tell the popup's Claude CLI session which app it was invoked over.
export async function captureFrontmostWindow(): Promise<string | undefined> {
  // Recorded before the window read below, so the pid is captured even if
  // nut-js fails — and never recorded as Clance, which would point every
  // later read at our own windows.
  const app = await frontmostApp();
  if (app && !app.ours) capturedApp = app;

  try {
    const { getActiveWindow } = await import("@nut-tree-fork/nut-js");
    capturedWindow = await getActiveWindow();
    return await capturedWindow.title;
  } catch {
    capturedWindow = null;
    return undefined;
  }
}

/** The app the user was in when Clance took focus, if it's still running. */
export function capturedAppInfo(): AxApp | null {
  return capturedApp;
}

// The one normalization used everywhere a window title is compared or
// displayed — trim + lowercase. Shared by listOpenWindows (what the model
// sees) and findWindowByTitleHint (what actually gets matched) specifically
// so those two can never drift apart: if the model can only ever read a
// *trimmed* title back from list_open_windows, matching against an
// untrimmed title elsewhere means the model's own verbatim copy of what it
// was shown would fail an exact-match check for no reason a human or the
// model could predict, silently falling back to the weaker substring path.
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
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

// Finds the open window whose title matches `hint` — window titles are
// things like "Slack | #general", so requiring an exact match would be
// brittle, but window titles are also attacker-influenceable (any app can
// set its own title to whatever it wants), so a *loose* substring match
// picking the first hit is a spoofing surface: a malicious or compromised
// app could title itself to intercept a hint aimed at something else (e.g.
// a fake window titled to match "Slack"), redirecting
// insert_text/click_at/clear_focused_field/replace_focused_field to it
// instead. Fails closed rather than guessing: an exact (normalized) title
// match wins only if it's the *unique* one, and short of that, a substring
// match only counts if it's unique too — two or more windows matching the
// same hint at either tier returns no match at all instead of silently
// picking whichever happened to be enumerated first, forcing the caller
// (the model) to be more specific rather than this function guessing on
// their behalf. (The exact-match tier used to skip this uniqueness check —
// `Array.find` just returns the first hit — which meant two windows
// colliding on their normalized title, whether by coincidence or a
// malicious app deliberately titling itself to match, silently resolved to
// enumeration order instead of failing closed the way the substring tier
// already did.) Uses the same normalizeTitle() listOpenWindows does, so a
// hint copied verbatim from that tool's output actually hits the
// exact-match path instead of silently falling through to the weaker one
// over incidental whitespace.
async function findWindowByTitleHint(hint: string): Promise<Window | null> {
  try {
    const { getWindows } = await import("@nut-tree-fork/nut-js");
    const windows = await getWindows();
    const needle = normalizeTitle(hint);
    const titled = await Promise.all(
      windows.map(async (w) => ({ w, title: normalizeTitle(await w.title.catch(() => "")) }))
    );
    const exactMatches = titled.filter((t) => t.title === needle);
    if (exactMatches.length > 0) return exactMatches.length === 1 ? exactMatches[0].w : null;
    const substringMatches = titled.filter((t) => t.title.includes(needle));
    return substringMatches.length === 1 ? substringMatches[0].w : null;
  } catch {
    return null;
  }
}

// Shared by every tool below that can retarget at a different app than the
// one captured at hotkey-press (`appHint`, matched via findWindowByTitleHint)
// — falls back to the captured window if no hint is given or no match is
// found. Best-effort: a focus failure just means the action lands wherever
// focus actually is instead, same trade-off `typeIntoCapturedWindow` always
// accepted. Exported for popupWindow.ts's hide button — refocusing the
// captured window (no appHint) is exactly "give the user back whatever they
// were doing before this popup took focus," a plain OS-level window
// activation targeted at one specific external window, not anything
// Electron/app-lifecycle-level.
export async function focusTarget(appHint?: string): Promise<void> {
  const target = (appHint && (await findWindowByTitleHint(appHint))) || capturedWindow;
  if (!target) return;
  try {
    await target.focus();
    // OS-level focus changes aren't always instantaneous; give the target
    // app a moment to actually receive the focus before acting on it.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } catch {
    // Best effort — fall through.
  }
}

// Pastes rather than simulates individual keystrokes — `keyboard.type()`
// sends one synthetic keypress per character with a fixed inter-key delay,
// which is noticeably slow for anything longer than a sentence and gets
// worse linearly with text length. A clipboard paste (Cmd+V) delivers the
// whole string in one OS-level event regardless of length, at the cost of
// briefly overwriting the user's clipboard — restored a moment later, once
// the paste has had time to land. Shared by typeIntoCapturedWindow (paste at
// cursor) and replaceFocusedField (paste over a just-selected field) below.
async function pasteViaClipboard(text: string): Promise<void> {
  const { keyboard, Key } = await import("@nut-tree-fork/nut-js");
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

// `appHint`, when given, retargets the paste at the first open window whose
// title matches it instead of the window captured at hotkey-press — how a
// session redirects output to an app other than the one it was invoked
// over (see listOpenWindows above). Falls back to the captured window if no
// match is found, same as if no hint were given at all.
export async function typeIntoCapturedWindow(text: string, appHint?: string): Promise<void> {
  await focusTarget(appHint);
  await pasteViaClipboard(text);
}

// Loads the nut-js native addon without querying anything, so the first
// real call doesn't pay for it. The import itself is the expensive part
// (~300ms for the native binary); deliberately reads no window title, so
// this warms a module and captures nothing.
export async function warmFrontAppModule(): Promise<void> {
  try {
    await import("@nut-tree-fork/nut-js");
  } catch {
    // Warming is best-effort; a failure just means the first real call
    // pays the cost it always used to.
  }
}

// Reads the frontmost window's title *without* touching `capturedWindow`.
//
// Dictation needs this and must not use captureFrontmostWindow(): that one
// stores into the module-level `capturedWindow` slot the popup owns, so a
// dictation triggered while a widget is open would silently redirect that
// widget's insert_text/click_at at whatever app the user happened to be
// dictating into. Two features, one global — so dictation reads the title
// and keeps nothing.
export async function readFrontmostTitle(): Promise<string | undefined> {
  try {
    const { getActiveWindow } = await import("@nut-tree-fork/nut-js");
    // Sanitised because other apps put transient UI state in their window
    // titles — Chrome's audio indicator makes a tab title "New Tab 🔊",
    // which would otherwise be recorded verbatim in dictation history.
    return sanitizeWindowTitle(await (await getActiveWindow()).title);
  } catch {
    return undefined;
  }
}

// Pastes at the cursor in whatever is frontmost *right now*, with no focus
// change of any kind.
//
// Dictation's HUD is deliberately non-focusable (see dictationWindow.ts), so
// focus never left the user's app and there is nothing to restore — calling
// focusTarget() here would actively cause the bug it exists to prevent, by
// pulling focus to whatever the popup last captured instead of leaving it
// where the user is typing.
export async function pasteAtCursor(text: string): Promise<void> {
  await pasteViaClipboard(text);
}

// Selects everything in whatever's focused and deletes it — a blunt "clear
// this field" primitive (Cmd+A, then Delete) rather than anything that tries
// to target a specific range of text, since there's no generic cross-app way
// to know a field's current content/cursor position short of the
// accessibility tree, which ax.ts now reads directly.
export async function clearFocusedField(appHint?: string): Promise<void> {
  await focusTarget(appHint);
  const { keyboard, Key } = await import("@nut-tree-fork/nut-js");
  await keyboard.pressKey(Key.LeftCmd, Key.A);
  await keyboard.releaseKey(Key.LeftCmd, Key.A);
  await keyboard.pressKey(Key.Backspace);
  await keyboard.releaseKey(Key.Backspace);
}

// Select-all-and-paste in one atomic action, rather than requiring two
// separate tool calls (clearFocusedField then typeIntoCapturedWindow) that
// could be interrupted or reordered — replaces a whole field's contents
// rather than inserting at wherever the cursor happens to be.
export async function replaceFocusedField(text: string, appHint?: string): Promise<void> {
  await focusTarget(appHint);
  const { keyboard, Key } = await import("@nut-tree-fork/nut-js");
  await keyboard.pressKey(Key.LeftCmd, Key.A);
  await keyboard.releaseKey(Key.LeftCmd, Key.A);
  await pasteViaClipboard(text);
}

// Brings a different app to the front without typing or clicking anything —
// lets the model "switch to Notes" before acting on it, composing with
// click_at below (which always acts on whatever's now frontmost) rather than
// click_at needing its own app-redirect param.
export async function activateApp(hint: string): Promise<boolean> {
  const target = await findWindowByTitleHint(hint);
  if (!target) return false;
  try {
    await target.focus();
    return true;
  } catch {
    return false;
  }
}

// Clicks at a position on the display nearest the cursor, expressed as a
// *fraction* of that display's width/height (0-1 each way) rather than raw
// pixels — scale-invariant regardless of the screenshot resolution the model
// actually reasoned over (screenCapture.ts resizes for token cost), and
// avoids needing to communicate a scale factor back and forth. The model is
// expected to eyeball fractional position directly off whatever screenshot
// it just looked at (look_at_screen, or the original invocation capture).
/**
 * Where a 0–1 point lands on the display under the cursor. Shared with
 * clickAtNormalized so "what is under this point" and "click this point"
 * can never disagree about where the point is.
 */
export function screenPointForNormalized(x: number, y: number): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return {
    x: Math.round(display.bounds.x + x * display.bounds.width),
    y: Math.round(display.bounds.y + y * display.bounds.height),
  };
}

/**
 * Clicks an absolute screen point, for a target whose position came from the
 * accessibility tree rather than from eyeballing a screenshot — AX frames
 * are already in screen coordinates, so there is nothing to scale.
 */
export async function clickAtScreenPoint(x: number, y: number): Promise<void> {
  const { mouse, Point } = await import("@nut-tree-fork/nut-js");
  await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
  await mouse.leftClick();
}

export async function clickAtNormalized(x: number, y: number): Promise<void> {
  const { mouse, Point } = await import("@nut-tree-fork/nut-js");
  const point = screenPointForNormalized(x, y);
  await mouse.setPosition(new Point(point.x, point.y));
  await mouse.leftClick();
}
