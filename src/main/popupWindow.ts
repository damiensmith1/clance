import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";
import { captureFrontmostWindow } from "./frontApp";
import { captureAndSaveActiveDisplay } from "./screenCapture";

const WIDTH = 560;
const MIN_HEIGHT = 90; // just enough for the empty input row
const MAX_HEIGHT = 480;

type PopupShownPayload =
  | { mode: "new"; args: string[] }
  | { mode: "picker"; contextText: string };

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

// windowTitle/screenshotPath are already resolved by the caller (they both
// need the frontmost window captured before .show()/.focus() steal focus
// onto the popup itself — the same capture also backs typeIntoCapturedWindow
// for a future accept/reject text-insert flow).
async function showPopup(payload: PopupShownPayload): Promise<void> {
  if (!popup || popup.isDestroyed()) {
    popup = createPopup();
  }

  await popupReady;

  positionNearCursor(popup);
  popup.show();
  popup.focus();
  popup.webContents.send("popup-shown", payload);
  currentMode = payload.mode;
}

// windowTitle comes from whatever app happens to be frontmost — any app can
// set its own window title to arbitrary text, including terminal escape
// sequences, so this can't be trusted verbatim. Strips C0/C1 control chars
// (this also destroys embedded bracketed-paste markers like \x1b[201~,
// since ESC itself is stripped).
function sanitizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

// Built fresh per invocation (never cached) so the CLI session always
// reflects what the user was actually looking at and how they opened the
// widget.
function buildContextText(windowTitle: string | undefined, screenshotPath: string | undefined): string {
  const lines = [
    "The user just invoked Clance via its global screen-overlay shortcut — a quick-access popup, not a full coding session.",
  ];
  if (windowTitle) {
    lines.push(`The frontmost window at the time was: "${sanitizeForTerminal(windowTitle)}".`);
  }
  if (screenshotPath) {
    lines.push(
      `A screenshot of their screen at that moment was saved to: ${screenshotPath}. Read it if it's relevant to what they ask.`
    );
  }
  return lines.join("\n");
}

async function captureContextText(): Promise<string> {
  const [windowTitle, screenshotPath] = await Promise.all([
    captureFrontmostWindow(),
    captureAndSaveActiveDisplay().catch(() => undefined),
  ]);
  return buildContextText(windowTitle, screenshotPath);
}

export async function toggleClancePopup(): Promise<void> {
  if (popup && !popup.isDestroyed() && popup.isVisible() && currentMode === "new") {
    popup.hide();
    currentMode = null;
    return;
  }
  const contextText = await captureContextText();
  // A brand-new session has no prior recorded system-prompt snapshot, so
  // this rides in invisibly — --system-prompt-snapshot off makes sure that
  // stays true on any *future* resume of this exact session too (see
  // togglePopupPicker below for why that flag matters).
  showPopup({
    mode: "new",
    args: ["--append-system-prompt", contextText, "--system-prompt-snapshot", "off"],
  });
}

export async function togglePopupPicker(): Promise<void> {
  if (popup && !popup.isDestroyed() && popup.isVisible() && currentMode === "picker") {
    popup.hide();
    currentMode = null;
    return;
  }
  // Resumed sessions can't reliably take a fresh --append-system-prompt:
  // the CLI only honors it if the session's *original* launch had
  // --system-prompt-snapshot off, which is true for sessions Clance itself
  // created (see toggleClancePopup) but not for anything else (a session
  // started from a bare terminal, or any pre-existing session) — and
  // there's no way to tell which from here. So this is instead typed into
  // the terminal as visible, unsubmitted input once the session opens.
  const contextText = await captureContextText();
  showPopup({ mode: "picker", contextText });
}
