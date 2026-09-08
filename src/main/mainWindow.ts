import { BrowserWindow } from "electron";
import { join } from "path";

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    // Vertically centers the traffic lights within our tab bar's actual
    // height (~39px: 8px top padding + tab's 7px+7px padding + ~15px line
    // height + 1px bottom border) — Electron's unset default assumes a
    // shorter native title bar and places them noticeably higher, so they
    // read as a different size/row than the tabs.
    trafficLightPosition: { x: 20, y: 19 },
    backgroundColor: "#f7f3eb",
    webPreferences: {
      preload: join(__dirname, "../preload/mainWindow.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Starts filling the whole screen (like clicking the green zoom button),
  // not macOS's true fullscreen mode — stays a normal, resizable window,
  // no separate Space, traffic lights behave normally.
  win.maximize();

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
