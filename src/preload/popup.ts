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
  resolveOpenArgs: (sessionId: string) =>
    ipcRenderer.invoke("chatHistory:resolve-open-args", sessionId),
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

type PopupShownPayload =
  | { mode: "new"; args: string[] }
  | { mode: "picker"; contextText: string };
