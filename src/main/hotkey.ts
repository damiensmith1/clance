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
