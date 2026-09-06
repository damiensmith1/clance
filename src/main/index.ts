import { app, ipcMain } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys } from "./hotkey";
import { toggleClancePopup } from "./popupWindow";
import { askClance } from "./agent";
import { ensureSessionCwd, readLastSessionId, writeLastSessionId } from "./paths";

app.dock?.hide();

let currentSessionId: string | undefined;

app.whenReady().then(() => {
  ensureSessionCwd();
  currentSessionId = readLastSessionId();

  createTray(toggleClancePopup);
  registerHotkey(toggleClancePopup);
});

app.on("will-quit", unregisterAllHotkeys);

// Keep the app running from the tray with no windows open.
app.on("window-all-closed", () => {});

ipcMain.on("submit-goal", async (event, goal: string) => {
  for await (const agentEvent of askClance(goal, currentSessionId)) {
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
});

ipcMain.on("new-conversation", () => {
  currentSessionId = undefined;
});
