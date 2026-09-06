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

  return tray;
}
