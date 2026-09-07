import { app, ipcMain, Menu, nativeTheme } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys, isValidAccelerator } from "./hotkey";
import { toggleClancePopup } from "./popupWindow";
import { openMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { askClance } from "./agent";
import { captureActiveDisplay } from "./screenCapture";
import { ensureSessionCwd, readLastSessionId, writeLastSessionId } from "./paths";
import { getSetupStatus } from "./setupStatus";
import { readConfig, writeConfig, ThemePreference } from "./config";
import { connectClaude, openInstallDocs } from "./claudeAuth";
import {
  checkPermissions,
  openScreenRecordingSettings,
  openAccessibilitySettings,
} from "./permissions";
import { SHORTCUT_ACTIONS } from "./shortcuts";
import { getSession, listSessions } from "./chatHistory";
import { getLaunchOnLogin, setLaunchOnLogin } from "./launchOnLogin";

app.dock?.show();

let currentSessionId: string | undefined;
let warnedAboutScreenCapture = false;

async function handleTrayPopupClick(): Promise<void> {
  const status = await getSetupStatus();
  if (status.isComplete) {
    toggleClancePopup();
  } else {
    openMainWindow();
  }
}

app.whenReady().then(async () => {
  ensureSessionCwd();
  currentSessionId = readLastSessionId();
  nativeTheme.themeSource = readConfig().theme;

  Menu.setApplicationMenu(createAppMenu());
  createTray(handleTrayPopupClick, openMainWindow);

  const status = await getSetupStatus();
  if (status.isComplete) {
    const config = readConfig();
    registerHotkey(toggleClancePopup, config.shortcuts.togglePopup);
  } else {
    openMainWindow();
  }
});

app.on("activate", openMainWindow);

app.on("will-quit", unregisterAllHotkeys);

// Keep the app running from the tray with no windows open.
app.on("window-all-closed", () => {});

ipcMain.handle("setup:get-status", () => getSetupStatus());

ipcMain.handle("setup:connect-claude", () => connectClaude());

ipcMain.handle("setup:open-install-docs", () => openInstallDocs());

ipcMain.handle("setup:recheck-permissions", () => checkPermissions());

ipcMain.handle("setup:open-screen-recording-settings", () =>
  openScreenRecordingSettings()
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
      unregisterAllHotkeys();
      registerHotkey(toggleClancePopup, config.shortcuts.togglePopup);
    }

    return config;
  }
);

ipcMain.handle("setup:complete", async () => {
  const status = await getSetupStatus();
  if (status.isComplete) {
    const config = readConfig();
    registerHotkey(toggleClancePopup, config.shortcuts.togglePopup);
  }
  return status;
});

ipcMain.on("submit-goal", async (event, goal: string) => {
  try {
    const screenshotBase64 = await captureActiveDisplay().catch(() => undefined);

    if (!screenshotBase64 && !warnedAboutScreenCapture) {
      warnedAboutScreenCapture = true;
      event.sender.send(
        "response-note",
        "Screen Recording permission not granted — continuing without screen context."
      );
    }

    for await (const agentEvent of askClance(goal, currentSessionId, screenshotBase64)) {
      if (agentEvent.kind === "text") {
        event.sender.send("response-chunk", agentEvent.text);
      } else {
        if (agentEvent.sessionId) {
          currentSessionId = agentEvent.sessionId;
          writeLastSessionId(agentEvent.sessionId);
        }
        event.sender.send("response-done");
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    event.sender.send("response-error", message);
  }
});

ipcMain.on("new-conversation", () => {
  currentSessionId = undefined;
});

ipcMain.handle("chatHistory:list-sessions", () => listSessions());

ipcMain.handle("chatHistory:get-session", (_event, filePath: string) =>
  getSession(filePath)
);

ipcMain.handle("settings:get-preferences", () => ({
  theme: readConfig().theme,
  launchOnLogin: getLaunchOnLogin(),
}));

ipcMain.handle("settings:set-theme", (_event, theme: ThemePreference) => {
  const config = readConfig();
  config.theme = theme;
  writeConfig(config);
  nativeTheme.themeSource = theme;
  return config;
});

ipcMain.handle("settings:set-launch-on-login", (_event, enabled: boolean) => {
  setLaunchOnLogin(enabled);
  return getLaunchOnLogin();
});
