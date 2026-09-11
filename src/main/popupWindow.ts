import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";
import { captureFrontmostWindow, captureSelectedText } from "./frontApp";
import { captureAndSaveActiveDisplay } from "./screenCapture";
import { checkPermissions } from "./permissions";
import { ensureInsertTextServer } from "./insertTextServer";
import { spawnBackgroundAgent, resolveSessionId, stopAgent, rmAgent } from "./agentSessions";
import { claimPoolSpare, refillPool } from "./agentPool";
import { hasRealUserMessage, CLANCE_CONTEXT_PREFIX } from "./chatHistory";
import { getDefaultDirectory, addRecentDirectory } from "./config";

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
  // Sent the instant the window appears, before any of the context-capture/
  // agent-spawn work below has even started — so the widget is never just a
  // blank frame while the user waits on that chain (see toggleClancePopup).
  | { mode: "loading" }
  | { mode: "new"; args: string[]; contextPreview?: ContextPreview; visibleContext?: string };

let popup: BrowserWindow | null = null;
let popupReady: Promise<void> | null = null;
let currentMode: PopupShownPayload["mode"] | null = null;

// The agent id of whatever session toggleClancePopupInner most recently
// minted or claimed — tracked here (not just in the renderer) so an
// explicit close can decide whether to clean it up. Deliberately NOT set
// by openPopupWithArgs (the main window's "pop out to widget" button): that
// path is always a pre-existing, already-real conversation, so there's
// nothing here for it to opt into — cleanupIfAbandoned below finding this
// null is exactly the right (safe) behavior for it.
let currentAgentId: string | null = null;

// Every popup-originated session — a fresh mint, a claimed spare, or a
// still-unclaimed spare sitting in the pool — is named via this prefix
// (see popupSessionName below). Used by index.ts's "agents:list" handler,
// alongside a *live* content check (chatHistory.ts's hasRealUserMessage),
// to hide a widget session from the Active list while it's still
// genuinely empty. A name check rather than an id set tracked in memory:
// an earlier version tracked ids explicitly, but that missed spares
// minted directly by agentPool.ts (never routed through here at all) and
// reset on every app restart — a spare orphaned by a rare two-refill race
// (two app instances/restarts close together each minting one, only the
// last write to pool.json surviving) was invisible to both gaps at once,
// showing up in Active forever with no way to reach it. The name prefix
// is stateless and can't be orphaned the same way: no other mechanism
// mints a background agent named "Clance popup ..." by coincidence, so
// checking by name is both more complete and doesn't need bookkeeping.
const POPUP_SESSION_NAME_PREFIX = "Clance popup";

export function isPopupSessionName(name: string | undefined): boolean {
  return !!name && name.startsWith(POPUP_SESSION_NAME_PREFIX);
}

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

// If the session that's about to close was minted/claimed by this popup
// and never got a single real user turn, there's no reason to keep it
// running — or even keep it around as a stopped-but-resumable session,
// which would just be silent clutter in the Closed list forever (its
// transcript title would fall back to "New conversation" indefinitely,
// since it never had any real content to derive one from). Deliberately
// NOT wired into hidePopup() itself — "Open in App" also calls hidePopup()
// but is the opposite of abandonment (the conversation is being kept, just
// moved to a tab), so this is only called from the two truly-explicit-close
// call sites below. Best-effort: any failure here is silently swallowed —
// worst case is a harmless stopped/empty session sitting around, exactly
// the pre-existing behavior this is improving on, not a regression.
async function cleanupIfAbandoned(): Promise<void> {
  const id = currentAgentId;
  currentAgentId = null;
  if (!id) return;
  try {
    const sessionId = await resolveSessionId(["attach", id]);
    if (!sessionId) return;
    if (await hasRealUserMessage(sessionId)) return;
    await stopAgent(id);
    await rmAgent(id);
  } catch {
    // Best-effort — see comment above.
  }
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

ipcMain.on("popup:close", () => {
  hidePopup();
  cleanupIfAbandoned();
});

// Creates/positions the window but never shows it — safe to run concurrently
// with screen-context capture (captureContextText below), since it has no
// visible effect. Showing/focusing is a separate step (revealPopupWindow)
// callers must not do until capture has finished: a full-screen screenshot
// would otherwise catch the widget itself sitting on screen, and stealing
// focus mid-capture would break the simulated Cmd+C selectedText capture
// needs from whatever app the user was actually in.
async function preparePopupWindow(): Promise<void> {
  if (!popup || popup.isDestroyed()) {
    popup = createPopup();
  }

  await popupReady;

  if (!userHasRepositioned) positionNearCursor(popup);
}

// The other half of preparePopupWindow — only call this once any capture
// that needed the widget invisible/unfocused has already completed.
function revealPopupWindow(): void {
  if (!popup) return;
  popup.show();
  popup.focus();
}

// popup.webContents.send() silently drops the event if the window isn't
// showing yet — always call revealPopupWindow() (after preparePopupWindow())
// first.
function sendToPopup(payload: PopupShownPayload): void {
  popup?.webContents.send("popup-shown", payload);
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
  const lines = [CLANCE_CONTEXT_PREFIX];
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
export async function insertTextMcpArgs(): Promise<string[]> {
  if (!checkPermissions().accessibility) return [];
  const { url, token } = await ensureInsertTextServer();
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: { clance: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } },
    }),
  ];
}

// Every popup conversation used to be minted with the exact same literal
// name ("Clance popup") — harmless for the CLI itself, but the Chats tab's
// Active list falls back to this name (ChatsSection.js) whenever a
// session's real transcript-derived title hasn't loaded yet, so two
// recently-opened widget conversations were indistinguishable in that
// window. A cheap time-qualified name fixes that without needing to wait
// on the real title.
export function popupSessionName(): string {
  return `${POPUP_SESSION_NAME_PREFIX} ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

// Fills the pool spare(s) with the same insert_text MCP wiring a fresh mint
// would get — that wiring doesn't depend on any per-invocation capture
// (it's just the already-running local server's URL/token), so there's no
// reason a spare should be missing it. Called once at app startup
// (index.ts), after every claim (toggleClancePopupInner below), and safe to
// call repeatedly — refillPool collapses concurrent calls into one fill.
export async function warmAgentPool(cwd: string = getDefaultDirectory()): Promise<void> {
  const mcpArgs = await insertTextMcpArgs();
  await refillPool(mcpArgs, popupSessionName, cwd);
}

// Set for the duration of the capture/spawn chain below — the widget now
// appears (in a "loading" state) before that chain finishes, which invites
// a second hotkey press while it's still in flight; without this, that
// second press would race a second `claude --bg` spawn against the first.
let opening = false;

export async function toggleClancePopup(): Promise<void> {
  if (popup && !popup.isDestroyed() && popup.isVisible() && currentMode === "new") {
    hidePopup();
    cleanupIfAbandoned();
    return;
  }
  if (opening) return;
  opening = true;
  try {
    await toggleClancePopupInner();
  } finally {
    opening = false;
  }
}

async function toggleClancePopupInner(): Promise<void> {
  // preparePopupWindow() only creates/positions the window — it has no
  // visible effect, so it's safe to run concurrently with context capture
  // below. It can NOT be revealed yet: captureContextText's screenshot
  // needs the widget to not be on screen at all (a full-screen capture
  // would otherwise catch the widget itself), and its selection capture
  // (simulated Cmd+C) needs whatever app the user was in to still hold
  // keyboard focus, which revealing/focusing the popup would steal.
  // insertTextMcpArgs() has no such constraint (nothing it does is visible
  // or focus-sensitive) and doesn't depend on the capture result, so it
  // runs alongside both rather than after.
  const accessibilityGranted = checkPermissions().accessibility;
  const [, mcpArgs, { text: contextText, preview }] = await Promise.all([
    preparePopupWindow(),
    insertTextMcpArgs(),
    captureContextText(accessibilityGranted, accessibilityGranted),
  ]);

  // Only now — context safely captured — is it safe to actually show the
  // widget. The remaining work (spawning the background agent) still takes
  // real time, so it shows a "loading" state rather than staying invisible
  // until that's done too.
  revealPopupWindow();
  sendToPopup({ mode: "loading" });

  // The directory a brand-new session opens in — Settings' configured
  // default, or SESSION_CWD if never set (see config.ts's
  // getDefaultDirectory). Resumed/attached sessions never consult this —
  // they inherit their own recorded cwd instead (agentSessions.ts's
  // resolveOpenArgs). See docs/working-directory-design.md.
  const dir = getDefaultDirectory();

  // Try the pool first — a pre-warmed spare skips the mint latency
  // entirely, but it was minted before this invocation's context existed,
  // so it can't have received --append-system-prompt. Its context has to
  // ride in the same visible-typed way a resumed session's does (see
  // popup.js's openTerminal) instead of invisibly. Accepted trade-off,
  // decided 2026-09-10: every "New Conversation" open now prefers speed
  // over invisible context when a spare is available, rather than only
  // pooling for cases where invisibility doesn't matter. claimPoolSpare
  // only ever hands back a spare minted at exactly `dir` — one minted
  // under a since-changed default is discarded rather than claimed (see
  // agentPool.ts), so `id` below is always genuinely at `dir` either way.
  const claimedId = claimPoolSpare(dir);
  let id: string;
  let visibleContext: string | undefined;
  if (claimedId) {
    id = claimedId;
    visibleContext = contextText;
    // Fire-and-forget — don't make this open wait on minting the next
    // spare, just make sure one's on the way for next time.
    warmAgentPool(dir).catch(() => {});
  } else {
    // A brand-new session has no prior recorded system-prompt snapshot, so
    // this rides in invisibly — --system-prompt-snapshot off makes sure that
    // stays true on any *future* resume of this exact session too: a resumed
    // session can't reliably take a fresh --append-system-prompt otherwise
    // (the CLI only honors it if the session's *original* launch had this
    // off), and there'd be no way to tell from here whether a given resumed
    // session was Clance's own or something else entirely (a bare-terminal
    // session, say) that never had this flag at all. That's also why the
    // popup's "Open in..." dropdown (popup.js) types context visibly into a
    // resumed session's input instead of relying on this invisible path.
    //
    // Minted as a background agent immediately, same as every other
    // Clance-launched session (see docs/background-agent-architecture.md) —
    // the popup terminal that opens below is just an `attach` viewport onto
    // it, so closing the widget or the app never ends the conversation.
    id = await spawnBackgroundAgent(
      popupSessionName(),
      ["--append-system-prompt", contextText, "--system-prompt-snapshot", "off", ...mcpArgs],
      dir
    );
  }
  // The user may have hit the hotkey again (hiding the widget) while all of
  // the above was in flight — don't resurrect it out from under them.
  if (currentMode !== "loading") {
    // The session still got minted/claimed even though nobody ever saw it
    // — without this it'd leak exactly the way cleanupIfAbandoned exists to
    // prevent, just via a path that never reaches an explicit close at all.
    currentAgentId = id;
    cleanupIfAbandoned();
    return;
  }
  currentAgentId = id;
  sendToPopup({
    mode: "new",
    args: ["attach", id],
    contextPreview: preview,
    visibleContext,
  });
}

// Reopens an already-running terminal tab's session in the popup — used by
// the main window's "pop out to widget" button. Unlike toggleClancePopup,
// this never captures fresh screen context: the session already exists
// (mid-conversation, possibly resumed/attached), so there's no "just
// invoked via hotkey" moment to describe.
export async function openPopupWithArgs(args: string[]): Promise<void> {
  await preparePopupWindow();
  revealPopupWindow();
  sendToPopup({ mode: "new", args });
}

// Guards openNewSessionInDirectory the same way `opening` guards the
// hotkey path — a double-click on a recent-directory row (or "Browse…")
// shouldn't be able to mint two sessions.
let openingNewInDirectory = false;

// Mints a brand-new session at a directory the user explicitly chose (the
// "Open in..." dropdown's "New session in..." flow — see popup.js) —
// always a plain, un-pooled mint, since the directory isn't known until
// the user picks it, so there's nothing the pool could have pre-warmed.
// No context injection, unlike the hotkey path: this isn't "the user just
// invoked Clance and here's what they were looking at" — it's a
// deliberate "open a session somewhere" action, and whatever happened to
// be on screen when the dropdown was opened has no particular relevance
// to the directory being picked now. See docs/working-directory-design.md.
export async function openNewSessionInDirectory(dir: string): Promise<void> {
  if (openingNewInDirectory) return;
  openingNewInDirectory = true;
  try {
    await preparePopupWindow();
    revealPopupWindow();
    sendToPopup({ mode: "loading" });

    addRecentDirectory(dir);
    const mcpArgs = await insertTextMcpArgs();
    const id = await spawnBackgroundAgent(popupSessionName(), mcpArgs, dir);

    // Same as toggleClancePopupInner: the widget may have been dismissed
    // while the mint was in flight — don't resurrect it, and don't leak
    // the session that was minted for a widget nobody's looking at anymore.
    if (currentMode !== "loading") {
      currentAgentId = id;
      cleanupIfAbandoned();
      return;
    }
    currentAgentId = id;
    sendToPopup({ mode: "new", args: ["attach", id] });
  } finally {
    openingNewInDirectory = false;
  }
}
