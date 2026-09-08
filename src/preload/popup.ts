import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clance", {
  submitGoal: (goal: string) => ipcRenderer.send("submit-goal", goal),
  newConversation: () => ipcRenderer.send("new-conversation"),
  resumeConversation: (sessionId: string) =>
    ipcRenderer.send("resume-conversation", sessionId),
  acceptProposal: (text: string) => ipcRenderer.send("accept-proposal", text),
  reportHeight: (height: number) => ipcRenderer.send("resize-request", height),
  listChatSessions: () => ipcRenderer.invoke("chatHistory:list-sessions"),
  getChatSession: (filePath: string) =>
    ipcRenderer.invoke("chatHistory:get-session", filePath),
  onChunk: (callback: (text: string) => void) =>
    ipcRenderer.on("response-chunk", (_event, text: string) => callback(text)),
  onProposal: (callback: (proposal: { id: string; text: string }) => void) =>
    ipcRenderer.on("response-proposal", (_event, proposal) => callback(proposal)),
  onDone: (callback: () => void) =>
    ipcRenderer.on("response-done", () => callback()),
  onError: (callback: (message: string) => void) =>
    ipcRenderer.on("response-error", (_event, message: string) => callback(message)),
  onNote: (callback: (message: string) => void) =>
    ipcRenderer.on("response-note", (_event, message: string) => callback(message)),
  onShown: (callback: (payload: PopupShownPayload) => void) =>
    ipcRenderer.on("popup-shown", (_event, payload: PopupShownPayload) => callback(payload)),
});

type PopupShownPayload =
  | { mode: "new" }
  | { mode: "picker" }
  | { mode: "resume"; sessionId: string; filePath: string; title: string };
