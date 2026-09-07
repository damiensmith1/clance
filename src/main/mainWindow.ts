import { BrowserWindow } from "electron";
import { join } from "path";

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f4efe4",
    webPreferences: {
      preload: join(__dirname, "../preload/mainWindow.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(__dirname, "../mainWindow/index.html"));
  win.on("closed", () => {
    mainWindow = null;
  });

  return win;
}

export function openMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}
