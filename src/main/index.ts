import { app, ipcMain, Menu } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys, isValidAccelerator } from "./hotkey";
import { toggleClancePopup, togglePopupPicker, openPopupWithSession } from "./popupWindow";
import { openMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { askClance } from "./agent";
import { captureActiveDisplay } from "./screenCapture";
import { ensureSessionCwd, readLastSessionId, writeLastSessionId } from "./paths";
import { getSetupStatus } from "./setupStatus";
import { readConfig, writeConfig } from "./config";
import { connectClaude, disconnectClaude, openInstallDocs } from "./claudeAuth";
import {
  checkPermissions,
  openScreenRecordingSettings,
  openAccessibilitySettings,
} from "./permissions";
import { SHORTCUT_ACTIONS } from "./shortcuts";
import { getSession, listSessions } from "./chatHistory";
import { getLaunchOnLogin, setLaunchOnLogin } from "./launchOnLogin";
import { listSkills, setSkillEnabled } from "./skills";
import { listMcpServers, setMcpServerEnabled } from "./mcpConfig";
import { typeIntoCapturedWindow } from "./frontApp";

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

function registerAllHotkeys(shortcuts: Record<string, string>): void {
  unregisterAllHotkeys();
  registerHotkey(toggleClancePopup, shortcuts.togglePopup);
  registerHotkey(togglePopupPicker, shortcuts.sessionPicker);
}

app.whenReady().then(async () => {
  ensureSessionCwd();
  currentSessionId = readLastSessionId();

  Menu.setApplicationMenu(createAppMenu());
  createTray(handleTrayPopupClick, openMainWindow);

  const status = await getSetupStatus();
  if (status.isComplete) {
    registerAllHotkeys(readConfig().shortcuts);
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

ipcMain.handle("setup:disconnect-claude", () => disconnectClaude());

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
      } else if (agentEvent.kind === "proposal") {
        event.sender.send("response-proposal", { id: agentEvent.id, text: agentEvent.text });
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

ipcMain.on("resume-conversation", (_event, sessionId: string) => {
  currentSessionId = sessionId;
});

ipcMain.on("accept-proposal", async (_event, text: string) => {
  try {
    await typeIntoCapturedWindow(text);
  } catch (error) {
    console.error("Failed to type proposed text:", error);
  }
});

ipcMain.handle("chatHistory:list-sessions", () => listSessions());

ipcMain.handle("chatHistory:get-session", (_event, filePath: string) =>
  getSession(filePath)
);

ipcMain.handle(
  "popup:continue-session",
  (_event, session: { id: string; filePath: string; title: string }) => {
    openPopupWithSession(session);
  }
);

// Lets the main window's Chat Detail tab continue a session directly,
// independent of the popup's single shared currentSessionId — each tab
// resumes its own session explicitly rather than sharing global state.
ipcMain.on(
  "chatDetail:submit-goal",
  async (event, payload: { sessionId: string; goal: string }) => {
    try {
      for await (const agentEvent of askClance(payload.goal, payload.sessionId, undefined)) {
        if (agentEvent.kind === "text" || agentEvent.kind === "proposal") {
          event.sender.send("chatDetail:response-chunk", {
            sessionId: payload.sessionId,
            text: agentEvent.text,
          });
        } else {
          event.sender.send("chatDetail:response-done", { sessionId: payload.sessionId });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      event.sender.send("chatDetail:response-error", { sessionId: payload.sessionId, message });
    }
  }
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
