import { Tray, Menu, app, nativeImage } from "electron";
import { join } from "path";

export type TrayActions = {
  onTogglePopup: () => void;
  onDictate: () => void;
  onOpenMainWindow: () => void;
};

export type TrayState = {
  // null until the first status check finishes.
  claude: "connected" | "signed out" | "not installed" | null;
  // Accelerators by shortcut action id (see shortcuts.ts).
  shortcuts: Record<string, string>;
};

let actions: TrayActions | null = null;
let state: TrayState = { claude: null, shortcuts: { togglePopup: "Alt+Space", dictate: "Alt+D" } };

export function createTray(trayActions: TrayActions): Tray {
  // The logo as a template image: black on transparent, which macOS recolours
  // for light/dark menu bars and the highlighted state. Loading the 1x file
  // picks up trayTemplate@2x.png automatically on Retina displays. Strokes
  // are heavier than the full-size logo so it stays legible at 18pt.
  const icon = nativeImage.createFromPath(join(__dirname, "../shared/brand/trayTemplate.png"));
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip("Clance");

  actions = trayActions;
  trayRef = tray;
  rebuildMenu();
  return tray;
}

/** Updates what the menu shows (Claude's status, the current shortcuts). */
export function updateTrayState(next: Partial<TrayState>): void {
  state = { ...state, ...next };
  rebuildMenu();
}

// A native macOS menu, so it looks like macOS; only its items are ours. The
// shortcuts are display-only accelerators (registerAccelerator: false) —
// the real global shortcuts are registered separately in hotkey.ts.
function rebuildMenu(): void {
  if (!trayRef || !actions) return;
  const claudeLine =
    state.claude === null ? "Claude: checking…" : `Claude: ${state.claude}`;
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Clance",
      accelerator: state.shortcuts.togglePopup ?? "Alt+Space",
      registerAccelerator: false,
      click: actions.onTogglePopup,
    },
    {
      label: "Dictate",
      accelerator: state.shortcuts.dictate ?? "Alt+D",
      registerAccelerator: false,
      click: actions.onDictate,
    },
    { label: "Open Dashboard", click: actions.onOpenMainWindow },
    { type: "separator" },
    { label: claudeLine, enabled: false },
    { type: "separator" },
    { label: "Quit Clance", accelerator: "Command+Q", registerAccelerator: false, click: () => app.quit() },
  ]);
  trayRef.setContextMenu(menu);
}

let trayRef: Tray | null = null;

// Dictation's only always-visible state. The menu bar is the one place a
// user can see the microphone is live regardless of which display the HUD
// opened on, or whether a full-screen app is covering it.
export function setTrayRecording(recording: boolean): void {
  trayRef?.setTitle(recording ? "●" : "");
}
