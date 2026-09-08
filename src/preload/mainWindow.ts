import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clanceApp", {
  getSetupStatus: () => ipcRenderer.invoke("setup:get-status"),
  connectClaude: () => ipcRenderer.invoke("setup:connect-claude"),
  disconnectClaude: () => ipcRenderer.invoke("setup:disconnect-claude"),
  openInstallDocs: () => ipcRenderer.invoke("setup:open-install-docs"),
  recheckPermissions: () => ipcRenderer.invoke("setup:recheck-permissions"),
  openScreenRecordingSettings: () =>
    ipcRenderer.invoke("setup:open-screen-recording-settings"),
  openAccessibilitySettings: () =>
    ipcRenderer.invoke("setup:open-accessibility-settings"),
  getShortcutActions: () => ipcRenderer.invoke("setup:get-shortcut-actions"),
  saveShortcuts: (shortcuts: Record<string, string>) =>
    ipcRenderer.invoke("setup:save-shortcuts", shortcuts),
  completeSetup: () => ipcRenderer.invoke("setup:complete"),
  listChatSessions: () => ipcRenderer.invoke("chatHistory:list-sessions"),
  getChatSession: (filePath: string) =>
    ipcRenderer.invoke("chatHistory:get-session", filePath),
  watchSessionFile: (filePath: string, sessionId: string) =>
    ipcRenderer.invoke("chatHistory:watch-session", filePath, sessionId),
  unwatchSessionFile: (filePath: string) =>
    ipcRenderer.invoke("chatHistory:unwatch-session", filePath),
  spawnCliSession: (sessionId: string) =>
    ipcRenderer.invoke("chatHistory:spawn-cli-session", sessionId),
  continueSessionInPopup: (session: { id: string; filePath: string; title: string }) =>
    ipcRenderer.invoke("popup:continue-session", session),
  sendChatMessage: (sessionId: string, goal: string) =>
    ipcRenderer.send("chatDetail:submit-goal", { sessionId, goal }),
  onChatChunk: (callback: (payload: { sessionId: string; text: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string; text: string }) =>
      callback(payload);
    ipcRenderer.on("chatDetail:response-chunk", listener);
    return () => ipcRenderer.removeListener("chatDetail:response-chunk", listener);
  },
  onChatDone: (callback: (payload: { sessionId: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string }) => callback(payload);
    ipcRenderer.on("chatDetail:response-done", listener);
    return () => ipcRenderer.removeListener("chatDetail:response-done", listener);
  },
  onChatError: (callback: (payload: { sessionId: string; message: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string; message: string }) =>
      callback(payload);
    ipcRenderer.on("chatDetail:response-error", listener);
    return () => ipcRenderer.removeListener("chatDetail:response-error", listener);
  },
  onSessionUpdated: (callback: (payload: { sessionId: string }) => void) => {
    const listener = (_event: unknown, payload: { sessionId: string }) => callback(payload);
    ipcRenderer.on("session:updated", listener);
    return () => ipcRenderer.removeListener("session:updated", listener);
  },
  getPreferences: () => ipcRenderer.invoke("settings:get-preferences"),
  setLaunchOnLogin: (enabled: boolean) =>
    ipcRenderer.invoke("settings:set-launch-on-login", enabled),
  setReuseTabs: (enabled: boolean) =>
    ipcRenderer.invoke("settings:set-reuse-tabs", enabled),
  listSkills: () => ipcRenderer.invoke("extensibility:list-skills"),
  setSkillEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke("extensibility:set-skill-enabled", name, enabled),
  listMcpServers: () => ipcRenderer.invoke("extensibility:list-mcp-servers"),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke("extensibility:set-mcp-server-enabled", name, enabled),
});
