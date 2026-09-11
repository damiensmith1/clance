import { app, ipcMain, Menu, BrowserWindow } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys, isValidAccelerator } from "./hotkey";
import {
  toggleClancePopup,
  openPopupWithArgs,
  warmAgentPool,
  openNewSessionInDirectory,
  isPopupSessionName,
} from "./popupWindow";
import { openMainWindow, openSessionInMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { ensureSessionCwd, SESSION_CWD } from "./paths";
import { getSetupStatus } from "./setupStatus";
import { readConfig, writeConfig, getDefaultDirectory } from "./config";
import { pickDirectory } from "./directoryPicker";
import { connectClaude, disconnectClaude, openInstallDocs } from "./claudeAuth";
import {
  checkPermissions,
  requestScreenRecordingAccess,
  openScreenRecordingSettings,
  openAccessibilitySettings,
} from "./permissions";
import { SHORTCUT_ACTIONS } from "./shortcuts";
import { getSession, listSessions, hasRealUserMessage } from "./chatHistory";
import { setSessionArchived } from "./archivedSessions";
import { getLaunchOnLogin, setLaunchOnLogin } from "./launchOnLogin";
import { listSkills, setSkillEnabled } from "./skills";
import { listMcpServers, setMcpServerEnabled } from "./mcpConfig";
import { createPtySession, writeToPty, resizePty, killPty, reparentPty, warmLoginShellPath } from "./ptyManager";
import { resolveOpenArgs, spawnBackgroundAgent, stopAgent, listAgents } from "./agentSessions";
import { isPoolSpareId } from "./agentPool";
import { copyDroppedFile } from "./dropFiles";
import { readWindowLayout, writeWindowLayout } from "./windowLayout";

app.dock?.show();

async function handleTrayPopupClick(): Promise<void> {
  const status = await getSetupStatus();
  if (status.isComplete) {
    toggleClancePopup();
  } else {
    openMainWindow();
  }
}

function registerAllHotkeys(shortcuts: Record<string, string>): void {
  unregisterAllHotkeys();
  registerHotkey(toggleClancePopup, shortcuts.togglePopup);
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

  const status = await getSetupStatus();
  if (status.isComplete) {
    registerAllHotkeys(readConfig().shortcuts);
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

app.on("activate", openMainWindow);

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

ipcMain.handle(
  "setup:save-shortcuts",
  async (_event, shortcuts: Record<string, string>) => {
    for (const accelerator of Object.values(shortcuts)) {
      if (!isValidAccelerator(accelerator)) {
        throw new Error(`"${accelerator}" isn't a valid keyboard shortcut.`);
      }
    }

    const config = readConfig();
    config.shortcuts = { ...config.shortcuts, ...shortcuts };
    config.shortcutsConfigured = true;
    writeConfig(config);

    const status = await getSetupStatus();
    if (status.isComplete) {
      registerAllHotkeys(config.shortcuts);
    }

    return config;
  }
);

ipcMain.handle("setup:complete", async () => {
  const status = await getSetupStatus();
  if (status.isComplete) {
    registerAllHotkeys(readConfig().shortcuts);
  }
  return status;
});

ipcMain.handle("chatHistory:list-sessions", () => listSessions());

ipcMain.handle("chatHistory:get-session", (_event, filePath: string) =>
  getSession(filePath)
);

ipcMain.handle("chatHistory:resolve-open-args", (_event, sessionId: string, name: string) =>
  resolveOpenArgs(sessionId, name)
);

ipcMain.handle(
  "chatHistory:set-archived",
  (_event, sessionId: string, archived: boolean) => setSessionArchived(sessionId, archived)
);

ipcMain.handle(
  "agents:spawn-new",
  (_event, name: string, claudeArgs: string[]) => spawnBackgroundAgent(name, claudeArgs, getDefaultDirectory())
);

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

ipcMain.handle(
  "extensibility:set-skill-enabled",
  (_event, name: string, enabled: boolean) => setSkillEnabled(name, enabled)
);

ipcMain.handle("extensibility:list-mcp-servers", () => listMcpServers());

ipcMain.handle(
  "extensibility:set-mcp-server-enabled",
  (_event, name: string, enabled: boolean) => setMcpServerEnabled(name, enabled)
);

ipcMain.handle(
  "terminal:create",
  (
    event,
    payload: { terminalId: string; command: string; args: string[]; cols: number; rows: number }
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    createPtySession(
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

ipcMain.on("terminal:input", (_event, payload: { terminalId: string; data: string }) => {
  writeToPty(payload.terminalId, payload.data);
});

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

ipcMain.handle("files:copy-dropped", (_event, sourcePath: string) =>
  copyDroppedFile(sourcePath)
);
