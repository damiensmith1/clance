import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clance", {
  reportHeight: (height: number) => ipcRenderer.send("resize-request", height),
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
  onShown: (callback: (payload: PopupShownPayload) => void) =>
    ipcRenderer.on("popup-shown", (_event, payload: PopupShownPayload) => callback(payload)),
});

type PopupShownPayload =
  | { mode: "new"; args: string[] }
  | { mode: "picker"; contextText: string };
