import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";
import { captureFrontmostWindow } from "./frontApp";
import { captureAndSaveActiveDisplay } from "./screenCapture";

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 480;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 220;

type PopupShownPayload =
  | { mode: "new"; args: string[] }
  | { mode: "picker"; contextText: string };

let popup: BrowserWindow | null = null;
let popupReady: Promise<void> | null = null;
let currentMode: PopupShownPayload["mode"] | null = null;

// positionNearCursor's own win.setPosition() call fires a "move" event
// just like a user drag does — this tells the "move" listener below to
// ignore that one instead of mistaking it for the user repositioning the
// widget themselves.
let ignoreNextMove = false;
// Once the user has dragged the widget somewhere, showPopup() stops
// recentering it on the cursor — otherwise every next hotkey press would
// silently undo the move, which defeats the point of dragging it at all.
let userHasRepositioned = false;

// Hides the widget without destroying it (so its state/pty wiring is cheap
// to resume next time) — the only way it closes now. It used to also
// auto-hide on blur, but that made it disappear mid-drag or whenever
// another app briefly stole focus; dismissal is now always an explicit
// user action (the widget's own close button, or "Open in App").
export function hidePopup(): void {
  if (popup && !popup.isDestroyed()) popup.hide();
  currentMode = null;
}

function createPopup(): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Draggable (via #toolbar's -webkit-app-region: drag) and resizable
    // from any edge/corner, like a normal borderless browser window —
    // content used to drive the window's size instead (see the old
    // resize-request IPC, now gone); now the window's size is whatever
    // the user last left it at, and #app's CSS fills that fully.
    resizable: true,
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

  win.on("move", () => {
    if (ignoreNextMove) {
      ignoreNextMove = false;
      return;
    }
    userHasRepositioned = true;
  });

  return win;
}

function positionNearCursor(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const [width, height] = win.getSize();
  // Reserve room for the popup's current size so it never opens partly
  // off-screen.
  const x = Math.min(cursor.x, display.workArea.x + display.workArea.width - width);
  const y = Math.min(cursor.y, display.workArea.y + display.workArea.height - height);
  ignoreNextMove = true;
  win.setPosition(Math.max(x, display.workArea.x), Math.max(y, display.workArea.y));
}

ipcMain.on("popup:close", () => hidePopup());

// windowTitle/screenshotPath are already resolved by the caller (they both
// need the frontmost window captured before .show()/.focus() steal focus
// onto the popup itself — the same capture also backs typeIntoCapturedWindow
// for a future accept/reject text-insert flow).
async function showPopup(payload: PopupShownPayload): Promise<void> {
  if (!popup || popup.isDestroyed()) {
    popup = createPopup();
  }

  await popupReady;

  if (!userHasRepositioned) positionNearCursor(popup);
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
    hidePopup();
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

// Reopens an already-running terminal tab's session in the popup — used by
// the main window's "pop out to widget" button. Unlike toggleClancePopup,
// this never captures fresh screen context: the session already exists
// (mid-conversation, possibly resumed/attached), so there's no "just
// invoked via hotkey" moment to describe.
export async function openPopupWithArgs(args: string[]): Promise<void> {
  await showPopup({ mode: "new", args });
}

export async function togglePopupPicker(): Promise<void> {
  if (popup && !popup.isDestroyed() && popup.isVisible() && currentMode === "picker") {
    hidePopup();
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
