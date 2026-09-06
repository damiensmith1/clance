import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clance", {
  submitGoal: (goal: string) => ipcRenderer.send("submit-goal", goal),
  newConversation: () => ipcRenderer.send("new-conversation"),
  onChunk: (callback: (text: string) => void) =>
    ipcRenderer.on("response-chunk", (_event, text: string) => callback(text)),
  onDone: (callback: () => void) =>
    ipcRenderer.on("response-done", () => callback()),
  onShown: (callback: () => void) =>
    ipcRenderer.on("popup-shown", () => callback()),
});
