import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("clanceApp", {
  // Dropped File objects no longer carry a real filesystem path in the
  // renderer (Electron removed File#path); webUtils.getPathForFile is the
  // replacement, and it only works from the preload/main-world boundary.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  copyDroppedFile: (sourcePath: string) => ipcRenderer.invoke("files:copy-dropped", sourcePath),
  getSetupStatus: () => ipcRenderer.invoke("setup:get-status"),
  getLastSetupStatus: () => ipcRenderer.invoke("setup:get-last-status"),
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
  // Suspends Clance's global hotkeys so a shortcut recorder can see the
  // keys instead of the OS firing the existing binding.
  setShortcutCapture: (capturing: boolean) =>
    ipcRenderer.invoke("setup:set-shortcut-capture", capturing),
  completeSetup: () => ipcRenderer.invoke("setup:complete"),
  // Screen Recording only takes effect after a restart.
  relaunchApp: () => ipcRenderer.invoke("setup:relaunch"),
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
  launchUpdateCheck: () => ipcRenderer.invoke("app:launch-update-check"),
  openReleasePage: (url: string) => ipcRenderer.invoke("app:open-release-page", url),
  listChatSessions: () => ipcRenderer.invoke("chatHistory:list-sessions"),
  peekSession: (sessionId: string) => ipcRenderer.invoke("chatHistory:peek-session", sessionId),
  resolveOpenArgs: (sessionId: string, name: string) =>
    ipcRenderer.invoke("chatHistory:resolve-open-args", sessionId, name),
  setSessionArchived: (sessionId: string, archived: boolean) =>
    ipcRenderer.invoke("chatHistory:set-archived", sessionId, archived),
  sessionFolder: (sessionId: string) => ipcRenderer.invoke("sessions:folder", sessionId),
  revealFolder: (dir: string) => ipcRenderer.invoke("sessions:reveal-folder", dir),
  resumeInTerminal: (target: { sessionId?: string; agentId?: string; cwd?: string }) =>
    ipcRenderer.invoke("sessions:resume-in-terminal", target),
  spawnNewAgent: (name: string, claudeArgs: string[] = [], cwd: string | null = null) =>
    ipcRenderer.invoke("agents:spawn-new", name, claudeArgs, cwd),
  getRecentDirectories: () => ipcRenderer.invoke("config:get-recent-directories"),
  stopAgent: (id: string) => ipcRenderer.invoke("agents:stop", id),
  listAgents: (opts: { all?: boolean } = {}) => ipcRenderer.invoke("agents:list", opts),
  openInWidget: (args: string[]) => ipcRenderer.invoke("popup:open-with-args", args),
  createTerminal: (terminalId: string, command: string, args: string[], cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:create", { terminalId, command, args, cols, rows }),
  createShellTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:create-shell", { terminalId, cols, rows }),
  writeTerminal: (terminalId: string, data: string) =>
    ipcRenderer.send("terminal:input", { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.send("terminal:resize", { terminalId, cols, rows }),
  killTerminal: (terminalId: string) =>
    ipcRenderer.send("terminal:kill", { terminalId }),
  reparentTerminal: (terminalId: string) => ipcRenderer.invoke("terminal:reparent", terminalId),
  getTerminalBuffer: (terminalId: string): Promise<string> =>
    ipcRenderer.invoke("terminal:get-buffer", terminalId),
  onOpenSection: (callback: (section: string) => void) => {
    const listener = (_event: unknown, section: string) => callback(section);
    ipcRenderer.on("open-section", listener);
    return () => ipcRenderer.removeListener("open-section", listener);
  },
  // Tab commands from the app menu's Window items (⌘W, ⌃⇥, ⇧⌃⇥).
  onWindowCommand: (callback: (command: string) => void) => {
    const listener = (_event: unknown, command: string) => callback(command);
    ipcRenderer.on("window-command", listener);
    return () => ipcRenderer.removeListener("window-command", listener);
  },
  onOpenSessionTab: (
    callback: (payload: { terminalId: string; args: string[]; title: string | null }) => void
  ) => {
    const listener = (
      _event: unknown,
      payload: { terminalId: string; args: string[]; title: string | null }
    ) => callback(payload);
    ipcRenderer.on("open-session-tab", listener);
    return () => ipcRenderer.removeListener("open-session-tab", listener);
  },
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
  getWindowLayout: () => ipcRenderer.invoke("layout:get"),
  saveWindowLayout: (layout: unknown) => ipcRenderer.invoke("layout:save", layout),
  setLaunchOnLogin: (enabled: boolean) =>
    ipcRenderer.invoke("settings:set-launch-on-login", enabled),
  setDefaultDirectory: (dir: string | null) =>
    ipcRenderer.invoke("settings:set-default-directory", dir),
  pickDirectory: () => ipcRenderer.invoke("dialog:pick-directory"),
  listLocalTools: () => ipcRenderer.invoke("extensibility:list-local-tools"),
  setLocalToolEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke("extensibility:set-local-tool-enabled", name, enabled),
  localToolsServerStatus: () => ipcRenderer.invoke("extensibility:local-tools-server-status"),
  dismissLocalToolsPortChange: () => ipcRenderer.invoke("extensibility:dismiss-local-tools-port-change"),
  checkLocalToolsServerHealth: () =>
    ipcRenderer.invoke("extensibility:check-local-tools-server-health"),

  // ---- dictation (see docs/design.md's "Dictation") ----
  dictationToggle: () => ipcRenderer.invoke("dictation:toggle"),
  dictationAvailability: () => ipcRenderer.invoke("dictation:availability"),
  getDictationSettings: () => ipcRenderer.invoke("dictation:get-settings"),
  saveDictationSettings: (patch: unknown) =>
    ipcRenderer.invoke("dictation:save-settings", patch),
  listDictationModels: () => ipcRenderer.invoke("dictation:list-models"),
  installDictationModel: (modelId: string) =>
    ipcRenderer.invoke("dictation:install-model", modelId),
  // Downloads outlive the view that started them; this is how a remounted
  // settings pane finds one already running.
  activeDictationInstalls: () => ipcRenderer.invoke("dictation:active-installs"),
  cancelDictationInstall: (modelId: string) =>
    ipcRenderer.invoke("dictation:cancel-install", modelId),
  removeDictationModel: (modelId: string) =>
    ipcRenderer.invoke("dictation:remove-model", modelId),
  setActiveDictationModel: (modelId: string) =>
    ipcRenderer.invoke("dictation:set-active-model", modelId),
  onDictationInstallProgress: (callback: (p: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("dictation:install-progress", listener);
    return () => ipcRenderer.removeListener("dictation:install-progress", listener);
  },
  // `filter` is { query?, from?, to? } — see TranscriptFilter.
  queryTranscripts: (filter: unknown, limit?: number, offset?: number) =>
    ipcRenderer.invoke("dictation:query-transcripts", filter, limit, offset),
  deleteTranscripts: (filter: unknown) =>
    ipcRenderer.invoke("dictation:delete-transcripts", filter),
  dictationStats: (filter: unknown) => ipcRenderer.invoke("dictation:stats", filter),
  requestMicrophone: () => ipcRenderer.invoke("dictation:request-microphone"),
  openMicrophoneSettings: () => ipcRenderer.invoke("dictation:open-microphone-settings"),
  onNewTranscript: (callback: (t: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("dictation:new-transcript", listener);
    return () => ipcRenderer.removeListener("dictation:new-transcript", listener);
  },
});
