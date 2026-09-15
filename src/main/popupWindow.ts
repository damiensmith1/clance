import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "path";
import { captureFrontmostWindow, captureSelectedText } from "./frontApp";
import { captureAndSaveActiveDisplay } from "./screenCapture";
import { checkPermissions } from "./permissions";
import { ensureLocalToolsServer, listLocalTools } from "./localToolsServer";
import { getActiveMcpServers, type StoredMcpServerConfig } from "./mcpConfig";
import { spawnBackgroundAgent, resolveSessionId, stopAgent, rmAgent } from "./agentSessions";
import { claimPoolSpare, refillPool } from "./agentPool";
import { hasRealUserMessage, REFRESH_CONTEXT_PREFIX } from "./chatHistory";
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

// The toolbar's Hide button. Unlike hidePopup() (the close button, and the
// hotkey's own toggle-while-visible), this deliberately leaves currentMode
// and currentAgentId untouched — the conversation isn't being abandoned,
// just tucked away. The window itself is only ever hide()'d here, never
// reloaded, so its terminal/xterm state stays fully alive underneath;
// toggleClancePopup's own "already have a hidden live widget" check below
// is what brings it back on the next hotkey press instead of claiming a
// pool spare or minting a new session.
export function hideWidgetKeepAlive(): void {
  if (popup && !popup.isDestroyed()) popup.hide();
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

ipcMain.on("popup:hide", () => hideWidgetKeepAlive());

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

// Built fresh per refresh (never cached) so the re-captured context reflects
// what's actually on screen right now. The only remaining caller is
// refreshContext's explicit Cmd+Shift+R path — a plain hotkey-open no
// longer captures or types any of this (see localToolsSystemPrompt below
// for what a fresh/claimed session gets instead, baked in invisibly at
// mint time), so this is always the "refresh" framing now.
function buildContextText(
  windowTitle: string | undefined,
  screenshotPath: string | undefined,
  selectedText: string | undefined
): string {
  const lines = [REFRESH_CONTEXT_PREFIX];
  if (windowTitle) {
    lines.push(`The frontmost window now is: "${sanitizeForTerminal(windowTitle)}".`);
  }
  if (screenshotPath) {
    lines.push(
      "An updated screenshot of their screen, just captured, is attached to this conversation as an " +
        "image — look at it directly if it's relevant to what they ask, no need to read a file for it."
    );
  }
  if (selectedText) {
    lines.push(
      `The user had this text highlighted/selected in that app:\n"""\n${truncateSelectedText(sanitizeForTerminal(selectedText))}\n"""\n` +
        "Treat this selection as the primary subject of their request — focus on it unless they clearly ask about something unrelated to it."
    );
  }
  return lines.join("\n");
}

// captureSelection gates on the same Accessibility permission insert_text
// needs, since it's the same underlying mechanism (a simulated keystroke,
// here Cmd+C instead of Cmd+V) — see captureSelectedText in frontApp.ts.
// Only caller is refreshContext's explicit Cmd+Shift+R path (a plain
// hotkey-open captures nothing at all anymore, see toggleClancePopupInner),
// so this always captures a screenshot too — that's the explicit "look
// again" action.
async function captureContextText(
  captureSelection: boolean
): Promise<{ text: string; preview: ContextPreview }> {
  const [windowTitle, screenshotPath, selectedText] = await Promise.all([
    captureFrontmostWindow(),
    captureAndSaveActiveDisplay().catch(() => undefined),
    captureSelection ? captureSelectedText() : Promise.resolve(undefined),
  ]);
  const text = buildContextText(windowTitle, screenshotPath, selectedText);
  return {
    text,
    preview: { windowTitle, screenshotPath, selectedText, systemPrompt: text },
  };
}

// Re-captures screen context for the *live* session already showing in the
// popup, instead of only ever photographing the moment the hotkey was
// pressed (see docs/ideas.md's "Context capture is one-shot and frozen").
// Triggered from the popup's own Cmd+Shift+R handler (popup.js) rather than
// a hotkey, since Cmd+Space-style global shortcuts are already spoken for by
// togglePopup. The result rides into the pty exactly like a resumed
// session's initial context does (popup.js's injectContextIntoTerminal) —
// there's no flag equivalent to --append-system-prompt for a process
// that's already running.
//
// Deliberately doesn't reuse hidePopup() — that also nulls currentMode,
// which every other check in this module treats as "no live conversation
// showing." A refresh needs the popup invisible just long enough for an
// accurate screenshot (the same reason preparePopupWindow/revealPopupWindow
// are split at initial open), not a real close.
export async function refreshContext(): Promise<{ text: string; preview: ContextPreview } | null> {
  if (!popup || popup.isDestroyed() || currentMode !== "new") return null;
  const accessibilityGranted = checkPermissions().accessibility;
  // setOpacity(0), not hide(): hiding this window hands focus to whatever
  // macOS considers "next" (its own main window, if one happens to be
  // open), dragging in a pile of window-activation side effects. Opacity
  // keeps the window fully present at the OS level — still focused, still
  // "visible" — just fully transparent, which is enough to keep it out of
  // desktopCapturer's screenshot without touching anything else.
  popup.setOpacity(0);
  try {
    // The opacity change needs a beat to actually land before the
    // screenshot reads the display back — same wait-for-the-window-server-
    // to-catch-up value used elsewhere for this class of problem (see
    // frontApp.ts's captureSelectedText).
    await new Promise((resolve) => setTimeout(resolve, 150));
    return await captureContextText(accessibilityGranted);
  } finally {
    if (popup && !popup.isDestroyed()) popup.setOpacity(1);
  }
}

// Which of localToolsServer.ts's LOCAL_TOOLS are pre-authorized (no
// per-call CLI prompt) when enabled — independent of the Settings on/off
// toggle below, which controls whether a tool is offered *at all*. Only
// `tier: "auto"` tools qualify: click_at is as low-stakes an action as
// exists, and (unlike every other action tool here) it's never told which
// app to act on, only where on the *currently frontmost* display — it
// can't reach somewhere the user didn't already have on screen. The
// `tier: "approval"` tools (insert_text, activate_app,
// clear_focused_field, replace_focused_field) always keep the CLI's native
// "Allow / Deny / Always allow" prompt even when enabled — insert_text
// predates this whole tool set and was always designed around that prompt
// being the actual gate; activate_app/clear/replace can redirect to or
// overwrite content in an app the user never referenced, so auto-allowing
// them would let injected content the model reads via
// look_at_screen/read_selection autonomously act on an unrelated app with
// no human ever seeing it happen. See `docs/design.md`'s "Local tools
// server" for the full reasoning.
//
// Gives the launched CLI session every MCP server Clance should wire in:
// Clance's own local "computer use" tools (see src/main/localToolsServer.ts
// for the full list) plus whatever the user has enabled in Settings' "MCP
// Servers" tab (`mcpConfig.ts`'s `getActiveMcpServers()` — previously
// configured but never actually reached a launched session, see
// docs/requirements.md's "Config surface" gap, closed 2026-09-14). Additive
// (not --strict-mcp-config), so a project's own `.mcp.json` still loads too.
// `localToolsAvailable` is returned separately from `args` rather than
// folded into "args is non-empty" — a user's own custom MCP servers can
// make `args` non-empty even when Accessibility isn't granted, and callers
// (see popupMintArgs) need to know specifically whether the *local* tools
// are what's available, since that's what the system-prompt nudge is
// about.
export async function sessionMcpArgs(): Promise<{ args: string[]; localToolsAvailable: boolean }> {
  const mcpServers: Record<string, StoredMcpServerConfig> = { ...getActiveMcpServers() };
  let allowedNames: string[] = [];
  let disallowedNames: string[] = [];

  // Every tool here needs at least keystroke or mouse simulation (even the
  // read-only ones reuse that machinery — see frontApp.ts), so the whole
  // local tools server is gated on Accessibility; when it's not granted,
  // the CLI just doesn't see any of these tools rather than seeing ones
  // that silently fail. This gate is scoped to Clance's own local tools
  // only — a user's own configured MCP servers above have nothing to do
  // with Accessibility and are never held back by it.
  const localToolsAvailable = checkPermissions().accessibility;
  if (localToolsAvailable) {
    const { url, token } = await ensureLocalToolsServer();
    // The mcpServers key becomes the "clance" segment of the CLI's
    // mcp__<key>__<tool> naming convention — exactly what the
    // --allowedTools/--disallowedTools lists below reference, by name. A
    // static, guessable key (this used to be the literal string "clance")
    // could collide with a same-named server a project's own .mcp.json
    // defines — Clance sessions can now open in real project directories
    // (see docs/working-directory-design.md), so that's not a
    // hypothetical, it's an actual file a session's cwd could contain.
    // Since --mcp-config is additive, a colliding project-supplied
    // "clance" server could load alongside ours; if the CLI's precedence
    // rules ever let it win the name, our allowlist — which only ever
    // checks a tool name string — would silently pre-approve calls into
    // that attacker-controlled tool instead of ours, no prompt ever shown.
    // Deriving the key from the same per-launch random token already used
    // for the bearer auth (unpredictable, not a secret in this context)
    // makes it impossible for a static project file to predict or target.
    const serverKey = `clance-${token.slice(0, 16)}`;
    const toolName = (name: string) => `mcp__${serverKey}__${name}`;
    mcpServers[serverKey] = { type: "http", url, headers: { Authorization: `Bearer ${token}` } };

    // Settings' "Custom Tools" toggle list (SkillsSection.js, backed by
    // localToolsServer.ts's listLocalTools()) decides which tools are
    // offered at all, checked fresh at mint time same as everything here
    // — a tool that's off is passed via --disallowedTools so the CLI
    // refuses it outright, not just left unapproved (which would still
    // let the user approve it through a prompt).
    const tools = listLocalTools();
    allowedNames = tools.filter((t) => t.enabled && t.tier === "auto").map((t) => toolName(t.name));
    disallowedNames = tools.filter((t) => !t.enabled).map((t) => toolName(t.name));
  }

  if (Object.keys(mcpServers).length === 0) return { args: [], localToolsAvailable };

  const args = ["--mcp-config", JSON.stringify({ mcpServers })];
  if (allowedNames.length > 0) args.push("--allowedTools", allowedNames.join(" "));
  if (disallowedNames.length > 0) args.push("--disallowedTools", disallowedNames.join(" "));
  return { args, localToolsAvailable };
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

// The system prompt a fresh popup session gets, steering the model to
// actually reach for Clance's local tools unprompted — each tool's own MCP
// description (see localToolsServer.ts) is always visible to the model
// regardless of this text, but discoverability alone doesn't mean the model
// will *reach* for one without being told when that's appropriate, the same
// reason insert_text always got a nudge like this. Used to also carry
// whatever was on screen/selected at the moment the hotkey was pressed, but
// that's gone now (2026-09-14 decision) — offloaded entirely to the model
// calling look_at_screen/read_selection/list_open_windows itself when it
// actually needs to know, rather than front-loading a snapshot that's often
// irrelevant and immediately stale. That makes this text fully static
// (doesn't depend on anything captured per-invocation), which is exactly
// what makes popupMintArgs below safe to bake into a pool spare at warm
// time, not just a fresh mint — see agentPool.ts.
function localToolsSystemPrompt(): string {
  return [
    "The user just invoked Clance via its global screen-overlay shortcut — a quick-access popup, not a full coding session.",
    "You have a look_at_screen tool that takes a fresh screenshot of the user's screen right now. If the user's request is actually about what's currently on their screen, call it before answering rather than guessing.",
    "You also have an insert_text tool that types text directly into whatever app was frontmost when this popup opened. If the user's request is naturally about producing content for that app — writing, drafting, replying, filling in something — use insert_text to deliver it there instead of just printing it in this terminal, without waiting to be told explicitly to insert/type/paste it. Don't use it for requests that are really just questions or unrelated to that app.",
    "Beyond typing, you can also act more directly on the screen: click_at clicks a position on the current display (as a fraction of its width/height, not pixels — eyeball it from a screenshot you've looked at), activate_app brings a different app to the front by name, and clear_focused_field/replace_focused_field clear or replace the entire contents of whatever field is currently focused. Use these when the user's request calls for actually doing something on screen, not just describing or typing text. activate_app and the two field-editing tools will ask the user to approve the first time each session; click_at and insert_text won't. read_selection reads whatever's currently highlighted, and list_open_windows shows what's running if you need an exact name for `app`.",
  ].join("\n");
}

// The full --append-system-prompt/--mcp-config args a fresh popup session
// (or pool spare, see agentPool.ts) should be minted with. Static across
// invocations — see localToolsSystemPrompt above — so unlike the old
// per-invocation context text, it's identical whether this is a pool spare
// warmed at app startup or a session minted right now, which is what makes
// it safe for claimPoolSpare's staleness check to compare a spare's args
// against this directly. Returns just the mcp args with no system prompt at
// all when local tools aren't available (Accessibility not granted) —
// nothing to nudge the model toward using.
async function popupMintArgs(): Promise<string[]> {
  const { args, localToolsAvailable } = await sessionMcpArgs();
  if (!localToolsAvailable) return args;
  return ["--append-system-prompt", localToolsSystemPrompt(), "--system-prompt-snapshot", "off", ...args];
}

// Fills the pool spare(s) with the same args a fresh mint would get (see
// popupMintArgs) — that wiring doesn't depend on any per-invocation capture
// (it's just the already-running local server's URL/token plus the static
// system prompt above), so there's no reason a spare should be missing it.
// Called once at app startup (index.ts), after every claim
// (toggleClancePopupInner below), and safe to call repeatedly — refillPool
// collapses concurrent calls into one fill.
export async function warmAgentPool(cwd: string = getDefaultDirectory()): Promise<void> {
  const spawnArgs = await popupMintArgs();
  await refillPool(spawnArgs, popupSessionName, cwd);
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
  // The toolbar's Hide button (hideWidgetKeepAlive above) leaves the widget
  // hidden but its conversation still fully live and attached — reopen the
  // same window instead of falling through to claim/mint below, which
  // would otherwise abandon it in favor of a brand-new session every time.
  if (popup && !popup.isDestroyed() && !popup.isVisible() && currentMode === "new" && currentAgentId) {
    revealPopupWindow();
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
  // Nothing rides into the prompt anymore (no screenshot, window title, or
  // selection prose — see popupMintArgs/localToolsSystemPrompt), but
  // captureFrontmostWindow() still has to run here, before the popup steals
  // focus: it's not just prompt content, it's also the *only* way
  // frontApp.ts's `capturedWindow` ever gets set — what insert_text/
  // click_at/clear_focused_field/replace_focused_field fall back to
  // targeting when the model doesn't pass an explicit `app`. Skipping it
  // entirely would silently break that default for every fresh widget open
  // (nothing to fall back to, or a stale target left over from wherever the
  // last Cmd+Shift+R refresh happened). Its own return value (the title
  // text) is unused here now — only the side effect matters — but it's
  // still cheap enough (no screenshot, no simulated Cmd+C) that it's not
  // worth special-casing out of preparePopupWindow's concurrent run.
  await Promise.all([preparePopupWindow(), captureFrontmostWindow()]);
  revealPopupWindow();
  sendToPopup({ mode: "loading" });

  // The directory a brand-new session opens in — Settings' configured
  // default, or SESSION_CWD if never set (see config.ts's
  // getDefaultDirectory). Resumed/attached sessions never consult this —
  // they inherit their own recorded cwd instead (agentSessions.ts's
  // resolveOpenArgs). See docs/working-directory-design.md.
  const dir = getDefaultDirectory();
  const spawnArgs = await popupMintArgs();

  // Try the pool first — a pre-warmed spare skips the mint latency
  // entirely. Its args are now identical to whatever a fresh mint would get
  // (see popupMintArgs — no longer per-invocation, so nothing is lost by
  // having been baked in ahead of time). claimPoolSpare only ever hands
  // back a spare minted at exactly `dir` *and* with exactly this
  // invocation's freshly-recomputed `spawnArgs` — one minted under a
  // since-changed default directory, or whose baked-in wiring has since
  // gone stale (e.g. Accessibility wasn't granted yet at the app-startup
  // prewarm that made it), is discarded rather than claimed (see
  // agentPool.ts), so `id` below is always genuinely at `dir` with correct
  // tool wiring either way.
  const claimedId = claimPoolSpare(dir, spawnArgs);
  let id: string;
  if (claimedId) {
    id = claimedId;
    // Fire-and-forget — don't make this open wait on minting the next
    // spare, just make sure one's on the way for next time.
    warmAgentPool(dir).catch(() => {});
  } else {
    // Minted as a background agent immediately, same as every other
    // Clance-launched session (see docs/background-agent-architecture.md) —
    // the popup terminal that opens below is just an `attach` viewport onto
    // it, so closing the widget or the app never ends the conversation.
    id = await spawnBackgroundAgent(popupSessionName(), spawnArgs, dir);
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
  sendToPopup({ mode: "new", args: ["attach", id] });
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
    const { args: mcpArgs } = await sessionMcpArgs();
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
