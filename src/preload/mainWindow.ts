import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clanceApp", {
  getSetupStatus: () => ipcRenderer.invoke("setup:get-status"),
  connectClaude: () => ipcRenderer.invoke("setup:connect-claude"),
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
  getPreferences: () => ipcRenderer.invoke("settings:get-preferences"),
  setTheme: (theme: "light" | "dark" | "system") =>
    ipcRenderer.invoke("settings:set-theme", theme),
  setLaunchOnLogin: (enabled: boolean) =>
    ipcRenderer.invoke("settings:set-launch-on-login", enabled),
  listSkills: () => ipcRenderer.invoke("extensibility:list-skills"),
  setSkillEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke("extensibility:set-skill-enabled", name, enabled),
  listMcpServers: () => ipcRenderer.invoke("extensibility:list-mcp-servers"),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke("extensibility:set-mcp-server-enabled", name, enabled),
});
