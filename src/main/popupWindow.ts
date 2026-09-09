import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";
import { captureFrontmostWindow, captureSelectedText } from "./frontApp";
import { captureAndSaveActiveDisplay } from "./screenCapture";
import { checkPermissions } from "./permissions";
import { ensureInsertTextServer } from "./insertTextServer";
import { spawnBackgroundAgent } from "./agentSessions";

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 480;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 220;

// Raw pieces behind the system-prompt/typed-context text, kept around
// separately so the widget's "See context" hover card can show the actual
// screenshot image and selection rather than re-parsing them back out of
// buildContextText's prose.
type ContextPreview = {
  windowTitle?: string;
  screenshotPath?: string;
  selectedText?: string;
  systemPrompt: string;
};

type PopupShownPayload =
  | { mode: "new"; args: string[]; contextPreview?: ContextPreview }
  | { mode: "picker"; contextText: string; contextPreview?: ContextPreview };

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
// onto the popup itself — the same capture also backs the insert_text MCP
// tool, see insertTextMcpArgs below).
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

// A highlighted selection can be an entire document — cap what rides into
// the system prompt so one huge selection can't blow out the context
// window on every single invocation.
const MAX_SELECTED_TEXT_CHARS = 4000;
function truncateSelectedText(text: string): string {
  return text.length > MAX_SELECTED_TEXT_CHARS
    ? `${text.slice(0, MAX_SELECTED_TEXT_CHARS)}\n[...truncated]`
    : text;
}

// Built fresh per invocation (never cached) so the CLI session always
// reflects what the user was actually looking at and how they opened the
// widget.
function buildContextText(
  windowTitle: string | undefined,
  screenshotPath: string | undefined,
  selectedText: string | undefined,
  insertTextAvailable: boolean
): string {
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
  if (selectedText) {
    lines.push(
      `The user had this text highlighted/selected in that app:\n"""\n${truncateSelectedText(sanitizeForTerminal(selectedText))}\n"""\n` +
        "Treat this selection as the primary subject of their request — focus on it unless they clearly ask about something unrelated to it."
    );
  }
  if (insertTextAvailable) {
    lines.push(
      "You have an insert_text tool that types text directly into that frontmost app. If the user's request is " +
        "naturally about producing content for that app — writing, drafting, replying, filling in something — use " +
        "insert_text to deliver it there instead of just printing it in this terminal, without waiting to be told " +
        "explicitly to insert/type/paste it. Don't use it for requests that are really just questions or unrelated " +
        "to that app."
    );
  }
  return lines.join("\n");
}

// captureSelection gates on the same Accessibility permission insert_text
// needs, since it's the same underlying mechanism (a simulated keystroke,
// here Cmd+C instead of Cmd+V) — see captureSelectedText in frontApp.ts.
async function captureContextText(
  insertTextAvailable: boolean,
  captureSelection: boolean
): Promise<{ text: string; preview: ContextPreview }> {
  const [windowTitle, screenshotPath, selectedText] = await Promise.all([
    captureFrontmostWindow(),
    captureAndSaveActiveDisplay().catch(() => undefined),
    captureSelection ? captureSelectedText() : Promise.resolve(undefined),
  ]);
  const text = buildContextText(windowTitle, screenshotPath, selectedText, insertTextAvailable);
  return {
    text,
    preview: { windowTitle, screenshotPath, selectedText, systemPrompt: text },
  };
}

// Gives the launched CLI session an `insert_text` tool that types into
// whatever app was frontmost when the popup opened (see
// src/main/insertTextServer.ts) — additive (not --strict-mcp-config), so the
// user's own configured MCP servers still load too. Gated on Accessibility
// since that's what the underlying keystroke injection needs; when it's not
// granted, the CLI just doesn't see the tool rather than seeing one that
// silently fails.
async function insertTextMcpArgs(): Promise<string[]> {
  if (!checkPermissions().accessibility) return [];
  const { url, token } = await ensureInsertTextServer();
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: { clance: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } },
    }),
  ];
}

export async function toggleClancePopup(): Promise<void> {
  if (popup && !popup.isDestroyed() && popup.isVisible() && currentMode === "new") {
    hidePopup();
    return;
  }
  // insertTextMcpArgs first — buildContextText needs to know whether the
  // tool is available so it can only tell the model about it when it is.
  // Its own Accessibility check also gates whether to attempt a selection
  // capture (same underlying mechanism — see captureContextText).
  const mcpArgs = await insertTextMcpArgs();
  const accessibilityGranted = mcpArgs.length > 0;
  const { text: contextText, preview } = await captureContextText(accessibilityGranted, accessibilityGranted);
  // A brand-new session has no prior recorded system-prompt snapshot, so
  // this rides in invisibly — --system-prompt-snapshot off makes sure that
  // stays true on any *future* resume of this exact session too (see
  // togglePopupPicker below for why that flag matters).
  //
  // Minted as a background agent immediately, same as every other
  // Clance-launched session (see docs/background-agent-architecture.md) —
  // the popup terminal that opens below is just an `attach` viewport onto
  // it, so closing the widget or the app never ends the conversation.
  const id = await spawnBackgroundAgent("Clance popup", [
    "--append-system-prompt",
    contextText,
    "--system-prompt-snapshot",
    "off",
    ...mcpArgs,
  ]);
  showPopup({
    mode: "new",
    args: ["attach", id],
    contextPreview: preview,
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
  // No insert_text tool here (see insertTextMcpArgs) — that needs the MCP
  // server wired in at launch, which resumed sessions never get. Selection
  // capture has no such requirement (it's just a simulated Cmd+C, same
  // Accessibility gate), so it rides along in the typed context same as
  // toggleClancePopup's.
  const { text: contextText, preview } = await captureContextText(false, checkPermissions().accessibility);
  showPopup({ mode: "picker", contextText, contextPreview: preview });
}
