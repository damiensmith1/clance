import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("clance", {
  // Dropped File objects no longer carry a real filesystem path in the
  // renderer (Electron removed File#path); webUtils.getPathForFile is the
  // replacement, and it only works from the preload/main-world boundary.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  copyDroppedFile: (sourcePath: string) => ipcRenderer.invoke("files:copy-dropped", sourcePath),
  closeWidget: () => ipcRenderer.send("popup:close"),
  openInApp: (terminalId: string, args: string[]) =>
    ipcRenderer.invoke("popup:open-in-app", { terminalId, args }),
  listChatSessions: () => ipcRenderer.invoke("chatHistory:list-sessions"),
  resolveOpenArgs: (sessionId: string, name: string) =>
    ipcRenderer.invoke("chatHistory:resolve-open-args", sessionId, name),
  pickDirectory: () => ipcRenderer.invoke("dialog:pick-directory"),
  getRecentDirectories: () => ipcRenderer.invoke("config:get-recent-directories"),
  openNewInDirectory: (dir: string) => ipcRenderer.invoke("popup:open-new-in-directory", dir),
  createTerminal: (terminalId: string, command: string, args: string[], cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:create", { terminalId, command, args, cols, rows }),
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
  onShown: (callback: (payload: PopupShownPayload) => void) =>
    ipcRenderer.on("popup-shown", (_event, payload: PopupShownPayload) => callback(payload)),
});

type ContextPreview = {
  windowTitle?: string;
  screenshotPath?: string;
  selectedText?: string;
  systemPrompt: string;
};

type PopupShownPayload =
  | { mode: "loading" }
  | { mode: "new"; args: string[]; contextPreview?: ContextPreview; visibleContext?: string };
