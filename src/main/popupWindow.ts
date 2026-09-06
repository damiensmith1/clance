import { BrowserWindow, screen } from "electron";
import { join } from "path";

const WIDTH = 560;
const HEIGHT = 360;

let popup: BrowserWindow | null = null;

function createPopup(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
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
  const x = Math.min(
    cursor.x,
    display.workArea.x + display.workArea.width - WIDTH
  );
  const y = Math.min(
    cursor.y,
    display.workArea.y + display.workArea.height - HEIGHT
  );
  win.setPosition(Math.max(x, display.workArea.x), Math.max(y, display.workArea.y));
}

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
