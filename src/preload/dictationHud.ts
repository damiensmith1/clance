import { contextBridge, ipcRenderer } from "electron";

type Unsubscribe = () => void;

function on<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export type AssistantView =
  | { state: "listening"; heard: string }
  | { state: "thinking"; heard: string }
  | { state: "asking"; question: string; options: string[] }
  | { state: "acting"; label: string }
  | { state: "said"; message: string; ok: boolean };

export type DictationStartPayload = {
  sampleRate: number;
  autoStopSilenceMs: number;
  maxDurationMs: number;
  targetApp: string | null;
  inputDevice: { id: string; label: string } | null;
};

contextBridge.exposeInMainWorld("clanceDictation", {
  // The recorded PCM, handed over as a plain ArrayBuffer. Float32 at 16kHz:
  // ~1.2MB per 20s, and the 5-minute cap bounds it at ~19MB, which is fine
  // for one structured-clone copy but is why it's sent once at the end
  // rather than streamed frame by frame.
  sendAudio: (pcm: ArrayBuffer) => ipcRenderer.send("dictation:audio", pcm),
  // Silence/limit auto-stop routes back through the main process rather
  // than the renderer finalizing on its own, so manual and automatic stops
  // follow exactly one path through the state machine.
  requestStop: () => ipcRenderer.send("dictation:request-stop"),
  cancel: () => ipcRenderer.send("dictation:request-cancel"),
  micError: (message: string) => ipcRenderer.send("dictation:mic-error", message),
  resize: (width: number) => ipcRenderer.send("dictation:resize", width),
  action: (name: "open-settings" | "open-microphone-settings") => ipcRenderer.send("dictation:hud-action", name),

  onStart: (cb: (p: DictationStartPayload) => void) => on("dictation:start", cb),
  onStop: (cb: () => void) => on("dictation:stop", cb),
  onCancel: (cb: () => void) => on("dictation:cancel", cb),
  onState: (cb: (p: { state: string }) => void) => on("dictation:state", cb),
  onDone: (cb: (p: { text: string; inserted: boolean; targetApp: string | null }) => void) => on("dictation:done", cb),
  onEmpty: (cb: () => void) => on("dictation:empty", cb),
  onError: (cb: (p: { message: string }) => void) => on("dictation:error", cb),
  onUnavailable: (cb: (p: { reason?: string; message?: string }) => void) => on("dictation:unavailable", cb),

  // The assistant (⌥A) shares this window: same microphone, same pill, same
  // never-take-focus rules. Only what's drawn in it differs, so these ride
  // alongside the dictation channels rather than in a second preload.
  onAssistantOpen: (cb: () => void) => on("assistant:open", cb),
  onAssistantClose: (cb: () => void) => on("assistant:close", cb),
  onAssistantView: (cb: (view: AssistantView) => void) => on("assistant:view", cb),
});
