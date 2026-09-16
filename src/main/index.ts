import { app, ipcMain, Menu, BrowserWindow } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys, isValidAccelerator } from "./hotkey";
import {
  toggleClancePopup,
  openPopupWithArgs,
  warmAgentPool,
  openNewSessionInDirectory,
  isPopupSessionName,
  refreshContext,
  sessionMcpArgs,
} from "./popupWindow";
import { openMainWindow, openSessionInMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { ensureSessionCwd, SESSION_CWD } from "./paths";
import { getSetupStatus } from "./setupStatus";
import {
  readConfig,
  writeConfig,
  getDefaultDirectory,
  addRecentDirectory,
  DEFAULT_VOCABULARY,
} from "./config";
import { pickDirectory } from "./directoryPicker";
import { connectClaude, disconnectClaude, openInstallDocs } from "./claudeAuth";
import {
  checkPermissions,
  requestScreenRecordingAccess,
  openScreenRecordingSettings,
  openAccessibilitySettings,
  requestMicrophoneAccess,
  openMicrophoneSettings,
} from "./permissions";
import { SHORTCUT_ACTIONS } from "./shortcuts";
import { getSession, listSessions, hasRealUserMessage } from "./chatHistory";
import { setSessionArchived } from "./archivedSessions";
import { getLaunchOnLogin, setLaunchOnLogin } from "./launchOnLogin";
import { listSkills } from "./skills";
import { listMcpServers, setMcpServerEnabled } from "./mcpConfig";
import {
  listLocalTools,
  setLocalToolEnabled,
  getLocalToolsServerStatus,
  checkLocalToolsServerHealth,
} from "./localToolsServer";
import {
  createPtySession,
  writeToPty,
  resizePty,
  killPty,
  reparentPty,
  getPtyBuffer,
  warmLoginShellPath,
  pasteImageIntoPty,
} from "./ptyManager";
import { resolveOpenArgs, spawnBackgroundAgent, stopAgent, listAgents } from "./agentSessions";
import { isPoolSpareId } from "./agentPool";
import { copyDroppedFile } from "./dropFiles";
import { readWindowLayout, writeWindowLayout } from "./windowLayout";
import { getHud } from "./dictationWindow";
import {
  toggleDictation,
  cancelDictation,
  reconcileActiveModel,
  warmDictation,
  handleAudio,
  checkAvailability,
  getDictationState,
  onTranscript,
} from "./dictation";
import {
  listModels,
  installModel,
  cancelInstall,
  removeModel,
  isModelInstalled,
  MODEL_CATALOG,
  DownloadProgress,
} from "./whisperModels";
import {
  queryTranscripts,
  deleteTranscripts,
  transcriptStats,
  TranscriptFilter,
} from "./dictationStore";

app.dock?.show();

async function handleTrayPopupClick(): Promise<void> {
  const status = await getSetupStatus();
  if (status.isComplete) {
    toggleClancePopup();
  } else {
    openMainWindow();
  }
}

// `claudeReady` gates only the hotkeys that actually need a working
// `claude` CLI. Dictation is registered either way: it never touches
// Claude, so holding it behind claude-installed-and-logged-in (what
// getSetupStatus().isComplete means) would disable a working feature for
// no reason.
function registerAllHotkeys(shortcuts: Record<string, string>, claudeReady: boolean): void {
  unregisterAllHotkeys();
  if (claudeReady) registerHotkey(toggleClancePopup, shortcuts.togglePopup);
  registerHotkey(() => void toggleDictation(), shortcuts.dictate);
}

app.whenReady().then(async () => {
  ensureSessionCwd();
  // Resolves and caches the login-shell PATH `claude --bg` needs (see
  // ptyManager.ts) well before the popup widget's hotkey ever fires it on
  // demand — that resolution can itself be slow (an interactive login
  // shell sourcing .zshrc/.zprofile/nvm/etc.), and doing it now instead of
  // on the widget's critical path is pure upside.
  warmLoginShellPath();

  Menu.setApplicationMenu(createAppMenu());
  createTray(handleTrayPopupClick, openMainWindow);

  // Picks up models already on disk that the config doesn't know about, so
  // dictation doesn't claim to be unconfigured next to installed weights.
  void reconcileActiveModel();

  // Moves dictation's ~1s of cold-start work off the first hotkey press —
  // see warmDictation. Unconditional: dictation doesn't depend on Claude
  // being set up, same reasoning as its hotkey registration.
  warmDictation();

  const status = await getSetupStatus();
  // Unconditional: this registers the dictation hotkey even before setup
  // is finished, and the popup hotkey only when Claude is ready.
  registerAllHotkeys(readConfig().shortcuts, status.isComplete);
  if (status.isComplete) {
    // Pre-warms the popup's spare background agent so the first hotkey
    // press of the session doesn't have to wait on a cold mint — see
    // agentPool.ts. Only meaningful once setup's done (minting needs a
    // working `claude auth`), same gating as the hotkeys themselves.
    warmAgentPool();
  } else {
    openMainWindow();
  }

  if (process.env.CLANCE_FORCE_MAIN_WINDOW) openMainWindow();
});

// Only reopens the main window for a "no windows at all" activation — a
// fresh launch, or clicking the dock icon with nothing open — the standard
// macOS convention. Unconditionally calling openMainWindow() here also
// fired whenever the *popup* was reactivated: hiding it via app.hide()
// (see popupWindow.ts's hideWidgetKeepAlive) deactivates the whole app, so
// showing it again on the next hotkey press re-activates Clance and would
// otherwise pop the main window open right alongside it — exactly the
// "this is supposed to be a quiet overlay" bug this guard exists to avoid.
// The popup window itself is never destroyed (only hidden), so it already
// counts toward "not zero windows" once created, correctly skipping this.
app.on("activate", () => {
  // The dictation HUD is excluded from this count on purpose. It's a real
  // BrowserWindow that outlives its first use (kept alive, just hidden, so
  // the next dictation appears instantly rather than reloading a page), so
  // counting it meant that after a single dictation there was always "1
  // window open" and clicking the dock icon silently did nothing — with no
  // main window ever having been opened, the app looked dead.
  //
  // The popup still counts, deliberately: revealing it reactivates the app
  // (hideWidgetKeepAlive uses app.hide(), see popupWindow.ts) and that
  // fires this same event, which must not pop the main window open
  // alongside the overlay. The HUD can never cause that — it's
  // `focusable: false` and only ever shown with showInactive(), so it
  // never activates the app in the first place.
  const windows = BrowserWindow.getAllWindows().filter((win) => win !== getHud());
  if (windows.length === 0) openMainWindow();
});

app.on("will-quit", unregisterAllHotkeys);

// Keep the app running from the tray with no windows open.
app.on("window-all-closed", () => {});

ipcMain.handle("setup:get-status", () => getSetupStatus());

ipcMain.handle("setup:connect-claude", () => connectClaude());

ipcMain.handle("setup:disconnect-claude", () => disconnectClaude());

ipcMain.handle("setup:open-install-docs", () => openInstallDocs());

ipcMain.handle("setup:recheck-permissions", () => checkPermissions());

ipcMain.handle("setup:open-screen-recording-settings", () =>
  openScreenRecordingSettings()
);

ipcMain.handle("setup:request-screen-recording", () =>
  requestScreenRecordingAccess()
);

ipcMain.handle("setup:open-accessibility-settings", () =>
  openAccessibilitySettings()
);

ipcMain.handle("setup:get-shortcut-actions", () => SHORTCUT_ACTIONS);

// While the settings UI is recording a new shortcut, Clance's own global
// hotkeys have to come down. They're registered with the OS, so otherwise
// pressing the very combination you're trying to rebind fires the feature
// instead of reaching the renderer that's listening for it.
ipcMain.handle("setup:set-shortcut-capture", async (_event, capturing: boolean) => {
  if (capturing) {
    unregisterAllHotkeys();
    return;
  }
  const status = await getSetupStatus();
  registerAllHotkeys(readConfig().shortcuts, status.isComplete);
});

ipcMain.handle(
  "setup:save-shortcuts",
  async (_event, shortcuts: Record<string, string>) => {
    for (const accelerator of Object.values(shortcuts)) {
      if (!isValidAccelerator(accelerator)) {
        throw new Error(`"${accelerator}" isn't a valid keyboard shortcut.`);
      }
    }

    const config = readConfig();
    const merged = { ...config.shortcuts, ...shortcuts };

    // Two actions bound to the same accelerator can't both work —
    // globalShortcut.register simply returns false for the second one, so
    // without this the save would "succeed" and one hotkey would silently
    // stop responding. Unreachable while there was only one action; adding
    // dictation made it reachable.
    const seen = new Map<string, string>();
    for (const [id, accelerator] of Object.entries(merged)) {
      const existing = seen.get(accelerator);
      if (existing) {
        const label = (actionId: string) =>
          SHORTCUT_ACTIONS.find((a) => a.id === actionId)?.label ?? actionId;
        throw new Error(
          `"${accelerator}" is already used by ${label(existing)} — pick a different shortcut for ${label(id)}.`
        );
      }
      seen.set(accelerator, id);
    }

    config.shortcuts = merged;
    config.shortcutsConfigured = true;
    writeConfig(config);

    const status = await getSetupStatus();
    registerAllHotkeys(config.shortcuts, status.isComplete);

    return config;
  }
);

ipcMain.handle("setup:complete", async () => {
  const status = await getSetupStatus();
  registerAllHotkeys(readConfig().shortcuts, status.isComplete);
  return status;
});

ipcMain.handle("chatHistory:list-sessions", () => listSessions());

ipcMain.handle("chatHistory:get-session", (_event, filePath: string) =>
  getSession(filePath)
);

ipcMain.handle("chatHistory:resolve-open-args", async (_event, sessionId: string, name: string) =>
  resolveOpenArgs(sessionId, name, (await sessionMcpArgs()).args)
);

ipcMain.handle(
  "chatHistory:set-archived",
  (_event, sessionId: string, archived: boolean) => setSessionArchived(sessionId, archived)
);

// cwd is explicit only when the caller picked one (the main window's "New
// Session" dropdown) rather than the default row — tracked as a recent
// directory in exactly that case, same invariant popupWindow.ts's
// openNewSessionInDirectory keeps for the popup's equivalent flow (picking
// "Default" should never itself become a "recent" entry).
ipcMain.handle("agents:spawn-new", async (_event, name: string, claudeArgs: string[], cwd?: string | null) => {
  if (cwd) addRecentDirectory(cwd);
  const { args: mcpArgs } = await sessionMcpArgs();
  return spawnBackgroundAgent(name, [...claudeArgs, ...mcpArgs], cwd || getDefaultDirectory());
});

// Guards against shelling out `claude stop` with no real id (seen live:
// the renderer invoked this with `undefined`, which the CLI happily
// stringifies into "No job matching 'undefined'" rather than failing
// cleanly) — belt-and-suspenders alongside ChatsSection.js's own
// same-shaped guard, since this handler has no other caller to trust.
ipcMain.handle("agents:stop", (_event, id: string) => (id ? stopAgent(id) : undefined));

// Filters out pool spares (see agentPool.ts) — they're real running
// background agents from the CLI's point of view, but not conversations
// yet from the user's, so the Chats tab's Active list shouldn't show them
// until they've actually been claimed. Also filters out claimed-but-still-
// empty widget sessions — a popup conversation that was just opened and
// hasn't had a real message typed into it yet shouldn't show up as
// "created" either (see popupWindow.ts's cleanupIfAbandoned for the
// complementary on-close cleanup). isPopupSessionName catches this by the
// name every popup-originated session (mint or spare) is given, rather
// than an id explicitly tracked somewhere — an id set missed spares minted
// directly by agentPool.ts and reset on every app restart, so a spare
// orphaned by a rare two-refill race (isPoolSpareId's own pool.json
// out-of-sync with what's actually running) was invisible to both checks
// at once; the name check has no such gap, and isPoolSpareId stays as the
// more specific, unambiguous signal for the common case.
ipcMain.handle("agents:list", async (_event, opts: { all?: boolean }) => {
  const agents = await listAgents(opts);
  const kept = await Promise.all(
    agents.map(async (agent) => {
      if (isPoolSpareId(agent.id)) return null;
      if (isPopupSessionName(agent.name) && !(await hasRealUserMessage(agent.sessionId))) return null;
      return agent;
    })
  );
  return kept.filter((agent): agent is (typeof agents)[number] => agent !== null);
});

ipcMain.handle("popup:open-with-args", (_event, args: string[]) => openPopupWithArgs(args));

ipcMain.handle("popup:refresh-context", () => refreshContext());

ipcMain.handle(
  "popup:open-in-app",
  (_event, payload: { terminalId: string; args: string[] }) =>
    openSessionInMainWindow(payload.terminalId, payload.args)
);

ipcMain.handle("popup:open-new-in-directory", (_event, dir: string) => openNewSessionInDirectory(dir));

// Shared by the popup's "New session in..." flow and Settings' default-
// directory field — see directoryPicker.ts. Anchored to whichever window
// actually invoked it, same pattern as "terminal:reparent" below.
ipcMain.handle("dialog:pick-directory", (event) => pickDirectory(BrowserWindow.fromWebContents(event.sender)));

ipcMain.handle("config:get-recent-directories", () => readConfig().recentDirectories);

ipcMain.handle("settings:get-preferences", () => ({
  launchOnLogin: getLaunchOnLogin(),
  defaultDirectory: readConfig().defaultDirectory,
  // The *configured* accelerators, so UI that shows a hotkey hint (the
  // Dictation tab) can't drift from what the user actually rebound it to.
  shortcuts: readConfig().shortcuts,
}));

ipcMain.handle("settings:set-launch-on-login", (_event, enabled: boolean) => {
  setLaunchOnLogin(enabled);
  return getLaunchOnLogin();
});

ipcMain.handle("settings:set-default-directory", (_event, dir: string | null) => {
  const config = readConfig();
  config.defaultDirectory = dir;
  writeConfig(config);
  // Whatever spare was pre-warmed under the old default is now wrong for
  // this one — warmAgentPool() with no arg re-reads getDefaultDirectory()
  // fresh (picking up what was just written above) and refillPool's own
  // cwd-mismatch handling stops+removes the stale spare rather than
  // leaving it as an orphaned, untracked process. See
  // docs/working-directory-design.md.
  warmAgentPool().catch(() => {});
  return config.defaultDirectory;
});

ipcMain.handle("layout:get", () => readWindowLayout());

ipcMain.handle("layout:save", (_event, layout: unknown) => {
  writeWindowLayout(layout);
});

ipcMain.handle("extensibility:list-skills", () => listSkills());

ipcMain.handle("extensibility:list-mcp-servers", () => listMcpServers());

ipcMain.handle(
  "extensibility:set-mcp-server-enabled",
  (_event, name: string, enabled: boolean) => setMcpServerEnabled(name, enabled)
);

ipcMain.handle("extensibility:list-local-tools", () => listLocalTools());

ipcMain.handle(
  "extensibility:set-local-tool-enabled",
  (_event, name: string, enabled: boolean) => setLocalToolEnabled(name, enabled)
);

ipcMain.handle("extensibility:local-tools-server-status", () => getLocalToolsServerStatus());

ipcMain.handle("extensibility:check-local-tools-server-health", () => checkLocalToolsServerHealth());

ipcMain.handle(
  "terminal:create",
  (
    event,
    payload: { terminalId: string; command: string; args: string[]; cols: number; rows: number }
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    return createPtySession(
      payload.terminalId,
      payload.command,
      payload.args,
      SESSION_CWD,
      win,
      payload.cols,
      payload.rows
    );
  }
);

// A plain, general-purpose terminal tab (not a `claude` process at all) —
// the user's own login shell, for running `claude` themselves, project
// commands, or anything else, right alongside their Clance-launched
// sessions. Unlike "terminal:create" above (always an `attach` viewport
// onto a background agent, where cwd is irrelevant — the real process
// already has its own), this pty *is* the actual process the user's
// typing into, so its cwd matters: the same configured default directory
// a fresh Clance session would open in, not the hardcoded SESSION_CWD
// bucket. `-il` (interactive login) matches what a real Terminal.app
// window gives you — aliases, PATH, everything from the user's own shell
// startup files, sourced fresh rather than reusing the cached PATH-only
// resolution `getLoginShellPath()` does for spawning `claude` itself.
ipcMain.handle(
  "terminal:create-shell",
  (event, payload: { terminalId: string; cols: number; rows: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    return createPtySession(
      payload.terminalId,
      process.env.SHELL || "/bin/zsh",
      ["-il"],
      getDefaultDirectory(),
      win,
      payload.cols,
      payload.rows
    );
  }
);

ipcMain.on("terminal:input", (_event, payload: { terminalId: string; data: string }) => {
  writeToPty(payload.terminalId, payload.data);
});

ipcMain.handle(
  "terminal:paste-image",
  (_event, payload: { terminalId: string; imagePath: string }) =>
    pasteImageIntoPty(payload.terminalId, payload.imagePath)
);

ipcMain.on(
  "terminal:resize",
  (_event, payload: { terminalId: string; cols: number; rows: number }) => {
    resizePty(payload.terminalId, payload.cols, payload.rows);
  }
);

ipcMain.on("terminal:kill", (_event, payload: { terminalId: string }) => {
  killPty(payload.terminalId);
});

ipcMain.handle("terminal:reparent", (event, terminalId: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? reparentPty(terminalId, win) : false;
});

// A freshly (re)connected client's xterm instance has no scrollback of its
// own — used by TerminalSection.js's registry when it creates a brand-new
// terminal (as opposed to reusing one already alive in this renderer's own
// memory) to replay recent output before live data starts flowing.
ipcMain.handle("terminal:get-buffer", (_event, terminalId: string) => getPtyBuffer(terminalId));

ipcMain.handle("files:copy-dropped", (_event, sourcePath: string) =>
  copyDroppedFile(sourcePath)
);

// ---- dictation (see docs/dictation.md) ----

// Audio arrives as a raw ArrayBuffer from the HUD renderer, which owns the
// microphone (the main process has no getUserMedia).
ipcMain.on("dictation:audio", (_event, pcm: ArrayBuffer) => {
  void handleAudio(new Float32Array(pcm));
});

// Silence/limit auto-stop and Escape both come back through here so every
// stop follows the same path through the state machine as a hotkey press.
ipcMain.on("dictation:request-stop", () => void toggleDictation());
ipcMain.on("dictation:request-cancel", () => void cancelDictation());

ipcMain.on("dictation:level", () => {
  // The meter is drawn in the HUD itself; this exists so the renderer has a
  // channel to report level if anything outside the HUD ever needs it.
});

ipcMain.on("dictation:mic-error", (_event, message: string) => {
  console.error("Dictation microphone error:", message);
});

ipcMain.handle("dictation:toggle", () => toggleDictation());
ipcMain.handle("dictation:cancel", () => cancelDictation());
ipcMain.handle("dictation:state", () => getDictationState());
ipcMain.handle("dictation:availability", () => checkAvailability());

ipcMain.handle("dictation:get-settings", () => readConfig().dictation);

ipcMain.handle(
  "dictation:save-settings",
  (_event, patch: Partial<ReturnType<typeof readConfig>["dictation"]>) => {
    const config = readConfig();
    config.dictation = { ...config.dictation, ...patch };
    // A null prompt means "reset to the shipped default" — the settings UI
    // has a Reset button and this is how it asks, rather than the renderer
    // needing its own copy of the default text to send back.
    if (patch && patch.vocabulary === null) {
      config.dictation.vocabulary = DEFAULT_VOCABULARY;
    }
    writeConfig(config);
    return config.dictation;
  }
);

ipcMain.handle("dictation:list-models", () => listModels(readConfig().dictation.activeModel));

// Progress is pushed to the requesting window rather than broadcast: the
// install UI lives in the main window, and a 500MB download reports often.
ipcMain.handle("dictation:install-model", async (event, modelId: string) => {
  await installModel(modelId, (progress: DownloadProgress) => {
    if (!event.sender.isDestroyed()) event.sender.send("dictation:install-progress", progress);
  });

  // First installed model becomes active automatically — otherwise the user
  // would finish a download and still have a feature that says it isn't
  // set up.
  const config = readConfig();
  if (!config.dictation.activeModel || !isModelInstalled(config.dictation.activeModel)) {
    config.dictation.activeModel = modelId;
    writeConfig(config);
  }
  return config.dictation;
});

ipcMain.handle("dictation:cancel-install", (_event, modelId: string) => cancelInstall(modelId));

ipcMain.handle("dictation:remove-model", (_event, modelId: string) => {
  removeModel(modelId);
  const config = readConfig();
  if (config.dictation.activeModel === modelId) {
    // Fall back to any other installed model rather than leaving a dangling
    // active id that would read as "installed but broken" at record time.
    const fallback = MODEL_CATALOG.find((m) => m.id !== modelId && isModelInstalled(m.id));
    config.dictation.activeModel = fallback ? fallback.id : null;
    writeConfig(config);
  }
  return config.dictation;
});

ipcMain.handle("dictation:set-active-model", (_event, modelId: string) => {
  const config = readConfig();
  if (!isModelInstalled(modelId)) throw new Error("That model isn't installed yet.");
  config.dictation.activeModel = modelId;
  writeConfig(config);
  return config.dictation;
});

// One filtered query rather than separate list/search handlers: the text
// filter and the date range are the same predicate, and the bulk delete
// below has to be able to reuse it exactly.
ipcMain.handle(
  "dictation:query-transcripts",
  (_event, filter: TranscriptFilter = {}, limit?: number, offset?: number) =>
    queryTranscripts(filter, limit, offset)
);

// Deletes exactly what the current filter selects, and reports the count so
// the UI can confirm what actually went.
ipcMain.handle("dictation:delete-transcripts", (_event, filter: TranscriptFilter = {}) =>
  deleteTranscripts(filter)
);

ipcMain.handle("dictation:stats", (_event, filter: TranscriptFilter = {}) =>
  transcriptStats(filter)
);

ipcMain.handle("dictation:request-microphone", () => requestMicrophoneAccess());
ipcMain.handle("dictation:open-microphone-settings", () => openMicrophoneSettings());

// Keeps an open Dictation tab live as dictations happen elsewhere in the
// OS, rather than only refreshing when the user reopens the tab.
onTranscript((transcript) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("dictation:new-transcript", transcript);
  }
});
