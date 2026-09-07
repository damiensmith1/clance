import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";
import { captureFrontmostWindow } from "./frontApp";

type ResumableSession = { id: string; filePath: string; title: string };

const WIDTH = 560;
const MIN_HEIGHT = 90; // just enough for the empty input row
const MAX_HEIGHT = 480;

type PopupShownPayload =
  | { mode: "new" }
  | { mode: "picker" }
  | { mode: "resume"; sessionId: string; filePath: string; title: string };

let popup: BrowserWindow | null = null;
let popupReady: Promise<void> | null = null;
let currentMode: PopupShownPayload["mode"] | null = null;

function createPopup(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, "../preload/popup.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // popup.webContents.send() silently drops the event if popup.js hasn't
  // run yet and attached its ipcRenderer.on("popup-shown", ...) listener —
  // there's no queuing for a missed event, so showPopup() must wait for
  // this before sending.
  popupReady = new Promise((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  win.loadFile(join(__dirname, "../popup/popup.html"));
  win.on("blur", () => {
    win.hide();
    currentMode = null;
  });

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

// Capturing the frontmost window happens here, before .show()/.focus()
// steal focus onto the popup itself — this is the window a proposeText
// tool's proposed text gets typed back into once accepted.
async function showPopup(payload: PopupShownPayload): Promise<void> {
  if (!popup || popup.isDestroyed()) {
    popup = createPopup();
  }

  await Promise.all([captureFrontmostWindow(), popupReady]);

  positionNearCursor(popup);
  popup.show();
  popup.focus();
  popup.webContents.send("popup-shown", payload);
  currentMode = payload.mode;
}

export function toggleClancePopup(): void {
  if (popup && !popup.isDestroyed() && popup.isVisible() && currentMode === "new") {
    popup.hide();
    currentMode = null;
    return;
  }
  showPopup({ mode: "new" });
}

export function togglePopupPicker(): void {
  if (popup && !popup.isDestroyed() && popup.isVisible() && currentMode === "picker") {
    popup.hide();
    currentMode = null;
    return;
  }
  showPopup({ mode: "picker" });
}

export function openPopupWithSession(session: ResumableSession): void {
  showPopup({
    mode: "resume",
    sessionId: session.id,
    filePath: session.filePath,
    title: session.title,
  });
}
