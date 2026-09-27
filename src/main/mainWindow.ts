import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { hidePopup } from "./popupWindow";
import { resolveSessionId } from "./agentSessions";
import { titleForSessionId, findRecentClanceSessionId, SESSION_PLACEHOLDER_TITLE } from "./chatHistory";

let mainWindow: BrowserWindow | null = null;
let mainWindowReady: Promise<void> | null = null;

// ---- unsaved edits on close and quit ----
//
// The editor's buffers live in the renderer, so closing the window (or
// quitting) is held until the renderer says whether anything needs saving:
// it answers "close" at once when nothing does, "pending" while its Save /
// Don't Save / Cancel is up, then "close" or "cancel". A renderer that never
// answers — crashed, hung, still loading — can't keep the window open.

const CLOSE_REPLY_TIMEOUT_MS = 1500;
let closeApproved = false;
let asking = false;
let quitAfterClose = false;
let replyTimer: NodeJS.Timeout | null = null;

function finishClose(reply: string): void {
  asking = false;
  if (replyTimer) clearTimeout(replyTimer);
  replyTimer = null;
  if (reply !== "close") {
    quitAfterClose = false;
    return;
  }
  closeApproved = true;
  if (quitAfterClose) app.quit();
  else mainWindow?.close();
}

function askToClose(win: BrowserWindow): void {
  if (asking) return;
  asking = true;
  win.webContents.send("window:before-close");
  replyTimer = setTimeout(() => finishClose("close"), CLOSE_REPLY_TIMEOUT_MS);
}

ipcMain.on("window:before-close-reply", (event, reply: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (reply === "pending") {
    if (replyTimer) clearTimeout(replyTimer);
    replyTimer = null;
    return;
  }
  finishClose(typeof reply === "string" ? reply : "close");
});

/**
 * Called from `before-quit`. True means the quit is being held while the
 * renderer asks about unsaved edits; it resumes on its own if they're dealt
 * with.
 */
export function holdQuitForUnsavedEdits(): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || closeApproved) return false;
  quitAfterClose = true;
  askToClose(mainWindow);
  return true;
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    // Puts the traffic lights on the same line as the tab labels: the tabs
    // are 32px cards at the bottom of the 40px bar, so their labels centre
    // at y≈24 (y here is the top of the buttons, ~7px above their centre).
    trafficLightPosition: { x: 20, y: 17 },
    backgroundColor: "#fafaf7",
    webPreferences: {
      preload: join(__dirname, "../preload/mainWindow.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // webContents.send() silently drops the event if index.html hasn't
  // finished loading yet — mirrors popupWindow.ts's popupReady, needed by
  // openSessionInMainWindow below.
  mainWindowReady = new Promise((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });

  // Starts filling the whole screen (like clicking the green zoom button),
  // not macOS's true fullscreen mode — stays a normal, resizable window,
  // no separate Space, traffic lights behave normally.
  win.maximize();

  win.loadFile(join(__dirname, "../mainWindow/index.html"));
  win.on("close", (event) => {
    if (closeApproved) return;
    event.preventDefault();
    askToClose(win);
  });
  win.on("closed", () => {
    mainWindow = null;
    closeApproved = false;
    asking = false;
  });

  return win;
}

// Whether a menu command came from the main window, which is the only one
// with tabs to act on (see appMenu.ts's Window menu).
export function isMainWindow(win: BrowserWindow): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && win.id === mainWindow.id;
}

export function openMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

/** Brings the main window forward and sends it `channel` once it has loaded. */
export async function sendToMainWindow(channel: string, payload?: unknown): Promise<void> {
  openMainWindow();
  await mainWindowReady;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Brings the main window forward on one of its sections (e.g. Settings, from
// the dictation HUD's "not set up" action).
export async function openMainWindowSection(section: "chats" | "dictation" | "settings"): Promise<void> {
  openMainWindow();
  await mainWindowReady;
  mainWindow!.webContents.send("open-section", section);
}

// terminalId embeds its pty's spawn time (popup.js's `popup-${Date.now()}`,
// TerminalSection.js's `term-${Date.now()}-<n>`) — the only clue left for a
// brand-new session once resolveSessionId comes up empty (see
// findRecentClanceSessionId in chatHistory.ts).
function spawnTimestampFromTerminalId(terminalId: string): number | null {
  const match = terminalId.match(/(\d{10,})/);
  return match ? Number(match[1]) : null;
}

// Used by the popup widget's "Open in App" button: brings the main window
// forward and hands it the live session to continue there, then dismisses
// the widget. The terminal's pty isn't restarted — its ownership is
// reparented to the main window separately (see ptyManager.reparentPty,
// triggered by the renderer once it's ready to receive this session's
// output), so an in-flight response isn't lost.
export async function openSessionInMainWindow(terminalId: string, args: string[]): Promise<void> {
  // Title resolution is best-effort — it reaches into ~/.claude/projects/
  // (readdir/stat/readline over files Clance doesn't own) purely to label
  // the tab nicely. A failure here used to take down the whole handoff with
  // it: since this ran un-guarded before openMainWindow()/hidePopup(), any
  // throw meant the button did nothing at all — popup stays open, no tab
  // appears, no error surfaced anywhere a user would see it. The actual
  // handoff (open a tab, even an unnamed one, and close the widget)
  // should never be held hostage by a nice-to-have label.
  let title: string | null = null;
  try {
    let sessionId = await resolveSessionId(args);
    if (!sessionId) {
      // A brand-new (never --resume'd) session has no id in its launch args
      // at all — fall back to finding it by spawn time so the tab still gets
      // labeled with the real session title instead of a generic placeholder.
      const spawnedAt = spawnTimestampFromTerminalId(terminalId);
      if (spawnedAt) sessionId = await findRecentClanceSessionId(spawnedAt);
    }
    title = sessionId ? await titleForSessionId(sessionId) : null;
  } catch (err) {
    console.error("openSessionInMainWindow: title resolution failed, opening unnamed", err);
  }

  openMainWindow();
  await mainWindowReady;
  // A session nobody has typed into yet has no title, so the tab opens
  // under the same placeholder everything else uses and renames itself once
  // the conversation has a name (Shell.js).
  mainWindow!.webContents.send("open-session-tab", {
    terminalId,
    args,
    title: title ?? SESSION_PLACEHOLDER_TITLE,
  });
  hidePopup();
}
