import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";

const WIDTH = 560;
const MIN_HEIGHT = 90; // just enough for the empty input row
const MAX_HEIGHT = 480;

let popup: BrowserWindow | null = null;

function createPopup(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    vibrancy: "hud",
    visualEffectState: "active",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(__dirname, "../renderer/popup.html"));
  win.on("blur", () => win.hide());

  return win;
}

function positionNearCursor(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  // Reserve room for the popup's full grown height so it never has to
  // reposition itself later as it grows.
  const x = Math.min(
    cursor.x,
    display.workArea.x + display.workArea.width - WIDTH
  );
  const y = Math.min(
    cursor.y,
    display.workArea.y + display.workArea.height - MAX_HEIGHT
  );
  win.setPosition(Math.max(x, display.workArea.x), Math.max(y, display.workArea.y));
}

ipcMain.on("resize-request", (event, height: number) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const clamped = Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT);
  const [currentWidth, currentHeight] = win.getContentSize();
  if (currentHeight === clamped) return;

  win.setContentSize(currentWidth, clamped, true);
});

export function toggleClancePopup(): void {
  if (!popup || popup.isDestroyed()) {
    popup = createPopup();
  }

  if (popup.isVisible()) {
    popup.hide();
    return;
  }

  positionNearCursor(popup);
  popup.show();
  popup.focus();
  popup.webContents.send("popup-shown");
}
