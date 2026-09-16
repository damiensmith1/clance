import { globalShortcut } from "electron";

const DEFAULT_ACCELERATOR = "Alt+Space";

export function registerHotkey(onTrigger: () => void, accelerator = DEFAULT_ACCELERATOR): void {
  try {
    const ok = globalShortcut.register(accelerator, onTrigger);
    if (!ok) {
      console.error(`Failed to register global hotkey: ${accelerator}`);
    }
  } catch (error) {
    console.error(`Invalid global hotkey accelerator "${accelerator}":`, error);
  }
}

export function unregisterAllHotkeys(): void {
  globalShortcut.unregisterAll();
}

// Registers a single accelerator that can be taken back down on its own,
// without disturbing the app's standing hotkeys. Dictation uses this for
// Escape-to-cancel: its HUD is non-focusable by design (see
// dictationWindow.ts), so the window can't receive a keydown, and a
// global registration held only for the duration of a recording is the
// way to offer a cancel key at all.
export function registerTemporaryHotkey(accelerator: string, onTrigger: () => void): () => void {
  try {
    // Never clobber an existing registration — if the user has bound this
    // key to something of their own, releasing it later would silently
    // steal it from them.
    if (globalShortcut.isRegistered(accelerator)) return () => {};
    if (!globalShortcut.register(accelerator, onTrigger)) return () => {};
  } catch {
    return () => {};
  }
  return () => {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Already gone (e.g. unregisterAllHotkeys ran) — nothing to undo.
    }
  };
}

// Validates an accelerator string without disturbing an already-registered
// one — if it's already registered (e.g. it's the current active hotkey
// being re-saved unchanged), it's already known-valid, so we skip the
// register/unregister probe entirely rather than risk dropping the live
// registration.
export function isValidAccelerator(accelerator: string): boolean {
  try {
    if (globalShortcut.isRegistered(accelerator)) {
      return true;
    }
    const ok = globalShortcut.register(accelerator, () => {});
    if (ok) {
      globalShortcut.unregister(accelerator);
    }
    return ok;
  } catch {
    return false;
  }
}
