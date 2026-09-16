import { Tray, Menu, app, nativeImage } from "electron";
import { join } from "path";

export function createTray(onTogglePopup: () => void, onOpenMainWindow: () => void): Tray {
  // The logo as a template image: black on transparent, which macOS recolours
  // for light/dark menu bars and the highlighted state. Loading the 1x file
  // picks up trayTemplate@2x.png automatically on Retina displays. Strokes
  // are heavier than the full-size logo so it stays legible at 18pt.
  const icon = nativeImage.createFromPath(join(__dirname, "../shared/brand/trayTemplate.png"));
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
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
  trayRef?.setTitle(recording ? "●" : "");
}
