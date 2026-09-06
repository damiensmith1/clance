import { globalShortcut } from "electron";

const DEFAULT_ACCELERATOR = "Alt+Space";

export function registerHotkey(onTrigger: () => void, accelerator = DEFAULT_ACCELERATOR): void {
  const ok = globalShortcut.register(accelerator, onTrigger);
  if (!ok) {
    console.error(`Failed to register global hotkey: ${accelerator}`);
  }
}

export function unregisterAllHotkeys(): void {
  globalShortcut.unregisterAll();
}
