import { app, ipcMain, Menu, BrowserWindow } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys, isValidAccelerator } from "./hotkey";
import { toggleClancePopup, togglePopupPicker } from "./popupWindow";
import { openMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { ensureSessionCwd, SESSION_CWD } from "./paths";
import { getSetupStatus } from "./setupStatus";
import { readConfig, writeConfig } from "./config";
import { connectClaude, disconnectClaude, openInstallDocs } from "./claudeAuth";
import {
  checkPermissions,
  requestScreenRecordingAccess,
  openScreenRecordingSettings,
  openAccessibilitySettings,
} from "./permissions";
import { SHORTCUT_ACTIONS } from "./shortcuts";
import { getSession, listSessions } from "./chatHistory";
import { getLaunchOnLogin, setLaunchOnLogin } from "./launchOnLogin";
import { listSkills, setSkillEnabled } from "./skills";
import { listMcpServers, setMcpServerEnabled } from "./mcpConfig";
import { createPtySession, writeToPty, resizePty, killPty } from "./ptyManager";
import { resolveOpenArgs } from "./agentSessions";

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
  registerHotkey(togglePopupPicker, shortcuts.sessionPicker);
}

app.whenReady().then(async () => {
  ensureSessionCwd();

  Menu.setApplicationMenu(createAppMenu());
  createTray(handleTrayPopupClick, openMainWindow);

  const status = await getSetupStatus();
  if (status.isComplete) {
    registerAllHotkeys(readConfig().shortcuts);
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

ipcMain.handle("chatHistory:resolve-open-args", (_event, sessionId: string) =>
  resolveOpenArgs(sessionId)
);

ipcMain.handle("settings:get-preferences", () => ({
  launchOnLogin: getLaunchOnLogin(),
  reuseTabs: readConfig().reuseTabs,
}));

ipcMain.handle("settings:set-launch-on-login", (_event, enabled: boolean) => {
  setLaunchOnLogin(enabled);
  return getLaunchOnLogin();
});

ipcMain.handle("settings:set-reuse-tabs", (_event, enabled: boolean) => {
  const config = readConfig();
  config.reuseTabs = enabled;
  writeConfig(config);
  return config.reuseTabs;
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
  (event, payload: { terminalId: string; command: string; args: string[] }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    createPtySession(payload.terminalId, payload.command, payload.args, SESSION_CWD, win);
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
