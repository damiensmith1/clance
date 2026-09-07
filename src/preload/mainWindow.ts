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
});
