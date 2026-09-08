import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clanceApp", {
  getSetupStatus: () => ipcRenderer.invoke("setup:get-status"),
  connectClaude: () => ipcRenderer.invoke("setup:connect-claude"),
  disconnectClaude: () => ipcRenderer.invoke("setup:disconnect-claude"),
  openInstallDocs: () => ipcRenderer.invoke("setup:open-install-docs"),
  recheckPermissions: () => ipcRenderer.invoke("setup:recheck-permissions"),
  openScreenRecordingSettings: () =>
    ipcRenderer.invoke("setup:open-screen-recording-settings"),
  requestScreenRecordingAccess: () =>
    ipcRenderer.invoke("setup:request-screen-recording"),
  openAccessibilitySettings: () =>
    ipcRenderer.invoke("setup:open-accessibility-settings"),
  getShortcutActions: () => ipcRenderer.invoke("setup:get-shortcut-actions"),
  saveShortcuts: (shortcuts: Record<string, string>) =>
    ipcRenderer.invoke("setup:save-shortcuts", shortcuts),
  completeSetup: () => ipcRenderer.invoke("setup:complete"),
  listChatSessions: () => ipcRenderer.invoke("chatHistory:list-sessions"),
  resolveOpenArgs: (sessionId: string) =>
    ipcRenderer.invoke("chatHistory:resolve-open-args", sessionId),
  createTerminal: (terminalId: string, command: string, args: string[]) =>
    ipcRenderer.invoke("terminal:create", { terminalId, command, args }),
  writeTerminal: (terminalId: string, data: string) =>
    ipcRenderer.send("terminal:input", { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.send("terminal:resize", { terminalId, cols, rows }),
  killTerminal: (terminalId: string) =>
    ipcRenderer.send("terminal:kill", { terminalId }),
  onTerminalData: (callback: (payload: { terminalId: string; data: string }) => void) => {
    const listener = (_event: unknown, payload: { terminalId: string; data: string }) =>
      callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback: (payload: { terminalId: string; exitCode: number }) => void) => {
    const listener = (_event: unknown, payload: { terminalId: string; exitCode: number }) =>
      callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
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
