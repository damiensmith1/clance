import { Tray, Menu, app, nativeImage } from "electron";

export function createTray(onTogglePopup: () => void, onOpenMainWindow: () => void): Tray {
  // No app icon asset yet — empty image + a text title renders as a plain
  // menu-bar label until real artwork lands.
  const tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("Clance");
  tray.setToolTip("Clance");

  const menu = Menu.buildFromTemplate([
    { label: "Open Clance", click: onTogglePopup },
    { label: "Open Dashboard", click: onOpenMainWindow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);

  trayRef = tray;
  return tray;
}

let trayRef: Tray | null = null;

// Dictation's only always-visible state. The menu bar is the one place a
// user can see the microphone is live regardless of which display the HUD
// opened on, or whether a full-screen app is covering it.
export function setTrayRecording(recording: boolean): void {
  trayRef?.setTitle(recording ? "● Clance" : "Clance");
}
