import { BrowserWindow } from "electron";
import { join } from "path";
import { hidePopup } from "./popupWindow";
import { resolveSessionId } from "./agentSessions";
import { titleForSessionId, findRecentClanceSessionId, SESSION_PLACEHOLDER_TITLE } from "./chatHistory";

let mainWindow: BrowserWindow | null = null;
let mainWindowReady: Promise<void> | null = null;

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
  win.on("closed", () => {
    mainWindow = null;
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
