import { BrowserWindow, desktopCapturer, screen } from "electron";

const MAX_DIMENSION = 1568; // Claude's recommended max image edge — larger wastes tokens.

// The widget sits on top of whatever the user is asking about, so it has to
// be out of the frame for any screenshot Clance takes of their screen. It's
// registered by its owner rather than imported here: popupWindow.ts already
// imports localToolsServer.ts, which is a caller of this, so reaching back
// for the window would close a cycle.
let getWidget: () => BrowserWindow | null = () => null;

export function registerCaptureConcealedWindow(fn: () => BrowserWindow | null): void {
  getWidget = fn;
}

// How long the window server needs to actually paint the opacity change
// before a capture reads the display back — the same value used for this
// class of problem elsewhere (see frontApp.ts).
const WINDOW_SERVER_SETTLE_MS = 150;

// Nesting is handled: only the outermost caller hides and restores, so a
// conceal inside another can't reveal the window early.
let concealDepth = 0;

/**
 * Runs `fn` with the widget out of the frame. setOpacity(0), not hide():
 * hiding the window hands focus to whatever macOS considers "next" (its own
 * main window, if one is open), dragging in a pile of window-activation
 * side effects. Opacity keeps the window fully present at the OS level —
 * still focused, still "visible" — just fully transparent, which is enough
 * to keep it out of desktopCapturer's screenshot without touching anything
 * else. A widget that is already hidden costs nothing: no wait, no restore.
 */
export async function withWidgetConcealed<T>(fn: () => Promise<T>): Promise<T> {
  const widget = getWidget();
  if (!widget || widget.isDestroyed() || !widget.isVisible()) return fn();

  const outermost = concealDepth === 0;
  concealDepth += 1;
  if (outermost) {
    widget.setOpacity(0);
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SERVER_SETTLE_MS));
  }
  try {
    return await fn();
  } finally {
    concealDepth -= 1;
    if (concealDepth === 0 && !widget.isDestroyed()) widget.setOpacity(1);
  }
}

/**
 * Screenshot of the display nearest the cursor (where the popup opens),
 * captured fresh for this call — never cached or taken ambiently. The
 * widget is concealed for the duration, so it never photographs itself.
 * Returns undefined if Screen Recording permission hasn't been granted
 * (macOS returns an empty/black thumbnail rather than throwing).
 */
export function captureActiveDisplay(): Promise<string | undefined> {
  return withWidgetConcealed(captureActiveDisplayNow);
}

async function captureActiveDisplayNow(): Promise<string | undefined> {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const scale = Math.min(
    1,
    MAX_DIMENSION / Math.max(display.size.width, display.size.height)
  );

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });

  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    return undefined;
  }

  return source.thumbnail.toPNG().toString("base64");
}
