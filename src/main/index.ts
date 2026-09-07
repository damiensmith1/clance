import { app, ipcMain, Menu } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys } from "./hotkey";
import { toggleClancePopup } from "./popupWindow";
import { openMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { askClance } from "./agent";
import { captureActiveDisplay } from "./screenCapture";
import { ensureSessionCwd, readLastSessionId, writeLastSessionId } from "./paths";

app.dock?.show();

let currentSessionId: string | undefined;
let warnedAboutScreenCapture = false;

app.whenReady().then(() => {
  ensureSessionCwd();
  currentSessionId = readLastSessionId();

  Menu.setApplicationMenu(createAppMenu());
  createTray(toggleClancePopup, openMainWindow);
  registerHotkey(toggleClancePopup);
});

app.on("activate", openMainWindow);

app.on("will-quit", unregisterAllHotkeys);

// Keep the app running from the tray with no windows open.
app.on("window-all-closed", () => {});

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
