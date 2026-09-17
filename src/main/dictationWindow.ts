import { app, BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";

// Compact by design: while recording the HUD shows only a dot, the level
// meter and elapsed time, so it stays out of the way of whatever the user
// is dictating into.
const WIDTH = 210;
const HEIGHT = 36;
// The pill fits its content: a short status is narrower than the recording
// pill, and a message with an action widens it instead of being cut off. The
// renderer reports the width it needs.
const MIN_WIDTH = 120;
const MAX_WIDTH = 560;
let currentWidth = WIDTH;
// Gap between the HUD and the bottom of the *work area*, which macOS has
// already shrunk to exclude the Dock and menu bar — so this is only a
// small visual gap, not clearance for the Dock. It started at 120px, which
// double-counted that clearance and left the HUD floating well up the
// screen. Kept just above the Dock rather than over it: the HUD sits at
// screen-saver window level, so a larger value would cover Dock icons.
const BOTTOM_MARGIN = 8;

let hud: BrowserWindow | null = null;
let hudReady: Promise<void> | undefined;

/**
 * The recording HUD.
 *
 * The single most important property of this window is that it **never
 * takes key focus**. Dictation pastes into whatever app was frontmost, so
 * if this window activated, the frontmost app would become Clance and the
 * transcript would land here instead of where the user was typing. Hence
 * `focusable: false` plus `showInactive()` at every show site — and why
 * Escape-to-cancel has to be a temporary global shortcut (see
 * hotkey.ts's registerTemporaryHotkey) rather than a keydown handler.
 *
 * This is the opposite of popupWindow.ts, which takes focus deliberately.
 */
function createHud(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    // Floats above full-screen apps too — dictation is meant to work
    // wherever the user already is, including a full-screen editor.
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "../preload/dictationHud.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium throttles timers and animations in a page it considers
      // backgrounded, and a pre-warmed HUD sits hidden between dictations
      // — so the renderer that has to paint the level meter the instant
      // the hotkey fires is exactly the one being throttled. This is why
      // the HUD appears noticeably faster when the main window is open:
      // an active, visible window keeps the app and its GPU/compositor
      // work unthrottled, and the HUD rides on that.
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  // skipTransformProcessType is the whole point of this call's options:
  // without it, setVisibleOnAllWorkspaces flips the app between
  // UIElementApplication and ForegroundApplication, and that transform
  // hides the Dock icon — which is exactly what was observed when the HUD
  // appeared. Skipping the transform keeps the window on all workspaces
  // and over full-screen apps without touching the app's activation
  // policy.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  hudReady = new Promise((resolve) => {
    win.webContents.once("did-finish-load", () => resolve());
  });
  win.loadFile(join(__dirname, "../dictationHud/index.html"));

  win.on("closed", () => {
    hud = null;
    hudReady = undefined;
  });

  return win;
}

export function getHud(): BrowserWindow | null {
  return hud;
}

/**
 * Creates the HUD and loads its page at app startup, without showing it.
 *
 * Creating the window and waiting for did-finish-load costs ~345ms, and it
 * was being paid on the first dictation — the one moment the user is
 * watching for instant feedback. Pre-warmed here it drops to ~1ms, the
 * same trick warmAgentPool and warmLoginShellPath already use. Safe to
 * leave sitting hidden: it's excluded from index.ts's activate-handler
 * window count (see the comment there) precisely because it outlives its
 * first use.
 */
export async function prewarmHud(): Promise<void> {
  try {
    if (!hud) hud = createHud();
    await hudReady;
  } catch {
    // Best effort — showHud() creates it on demand if this didn't work.
  }
}

// Bottom-centre of whichever display holds the cursor — not at the cursor
// like the popup, since the thing being dictated into is usually right
// there and covering it would be worse than useless.
function position(win: BrowserWindow, display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())): void {
  const { x, y, width, height } = display.workArea;
  win.setBounds({
    x: Math.round(x + (width - currentWidth) / 2),
    y: Math.round(y + height - HEIGHT - BOTTOM_MARGIN),
    width: currentWidth,
    height: HEIGHT,
  });
}

// Resizes in place, re-centred on the display the HUD is already on, so a
// state change never makes it jump to wherever the cursor has moved.
ipcMain.on("dictation:resize", (_event, width: unknown) => {
  if (typeof width !== "number" || !Number.isFinite(width)) return;
  const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.ceil(width)));
  if (next === currentWidth || !hud || hud.isDestroyed()) return;
  currentWidth = next;
  position(hud, screen.getDisplayMatching(hud.getBounds()));
});

export async function showHud(): Promise<BrowserWindow> {
  if (!hud) hud = createHud();
  await hudReady;
  currentWidth = WIDTH;
  position(hud);
  // showInactive, never show() — see the class comment above.
  hud.showInactive();
  // Idempotent guard. skipTransformProcessType above should prevent the
  // Dock icon from ever being dropped, but the icon vanishing is very
  // visible and re-asserting it costs nothing, so this doesn't rely on
  // that alone.
  app.dock?.show();
  return hud;
}

export function hideHud(): void {
  hud?.hide();
}

/** Fire-and-forget state push to the HUD renderer. */
export function sendToHud(channel: string, payload?: unknown): void {
  if (hud && !hud.isDestroyed()) hud.webContents.send(channel, payload);
}
