import { execFile } from "child_process";
import { clipboard } from "electron";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { readConfig, writeConfig } from "./config";
import { addTranscript, Transcript } from "./dictationStore";
import { hideHud, prewarmHud, sendToHud, showHud } from "./dictationWindow";
import { pasteAtCursor, readFrontmostTitle, warmFrontAppModule } from "./frontApp";
import { registerTemporaryHotkey } from "./hotkey";
import { SESSION_CWD } from "./paths";
import { checkPermissions } from "./permissions";
import { setTrayRecording } from "./tray";
import {
  buildWavFile,
  detectMachine,
  isModelInstalled,
  MODEL_CATALOG,
  modelPath,
  recommendModel,
  resolveWhisperBinary,
} from "./whisperModels";

const AUDIO_DIR = join(SESSION_CWD, "dictation");
export const SAMPLE_RATE = 16000;

export type DictationState = "idle" | "recording" | "transcribing";

type Listener = (transcript: Transcript) => void;

let state: DictationState = "idle";
// Captured at recording start so history can say where a transcript went,
// and so the HUD can show it. Read via readFrontmostTitle, never
// captureFrontmostWindow — see the comment on that function.
let targetApp: string | undefined;
// Resolved off the critical path (see startRecording) and awaited only when
// the history row is written.
let targetAppPending: Promise<void> | undefined;
let cancelEscapeHotkey: (() => void) | undefined;
let maxDurationTimer: NodeJS.Timeout | undefined;
// The in-flight `whisper-cli`. Held so cancelDictation can kill it —
// otherwise a slow or wedged transcription could only be waited out.
let activeTranscription: { child: ReturnType<typeof execFile>; cancelled: boolean } | undefined;
const listeners = new Set<Listener>();

export function onTranscript(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDictationState(): DictationState {
  return state;
}

/**
 * Pays dictation's one-time startup costs at launch instead of on the
 * first hotkey press.
 *
 * Measured cold, the path from hotkey to a visible HUD was ~1.04s of
 * serial work — 296ms loading the nut-js native addon, 398ms resolving the
 * whisper binary and model, 345ms creating the HUD window and loading its
 * page — against ~50ms once warm. All of it is cacheable, and none of it
 * depends on anything the user does, so it belongs at startup alongside
 * warmLoginShellPath and warmAgentPool.
 *
 * Everything here is best-effort and independent: a failure just means
 * that one cost is paid on first use, as before.
 */
export function warmDictation(): void {
  void prewarmHud();
  void warmFrontAppModule();
  // Caches the resolved binary path and the machine specs that pick the
  // thread count at transcription time.
  void resolveWhisperBinary();
  void detectMachine();
}

/**
 * Adopts an installed model when the config doesn't name a usable one.
 *
 * Normally the install flow sets `activeModel` itself, but it can end up
 * null-but-installable: weights dropped into ~/.clance/models by hand, a
 * config reset, or the active model removed while another remained. Without
 * this, dictation would report "no model installed" while sitting next to a
 * perfectly good one. Called once at startup.
 *
 * Prefers this machine's recommended model, then the best other installed
 * one. MODEL_CATALOG is ordered smallest-to-largest, so picking the *last*
 * installed entry is what "best available" means — taking the first would
 * quietly settle on `tiny.en`, the one tier Phase 0 rejected as too
 * inaccurate to use.
 */
export async function reconcileActiveModel(): Promise<void> {
  const config = readConfig();
  const active = config.dictation.activeModel;
  if (active && isModelInstalled(active)) return;

  const { modelId: recommended } = await recommendModel();
  const best = isModelInstalled(recommended)
    ? recommended
    : [...MODEL_CATALOG].reverse().find((m) => isModelInstalled(m.id))?.id ?? null;

  if (best === null && active === null) return;
  config.dictation.activeModel = best;
  writeConfig(config);
}

export type DictationAvailability = {
  ready: boolean;
  reason?: "no-model" | "no-binary" | "no-microphone";
  message?: string;
};

export async function checkAvailability(): Promise<DictationAvailability> {
  const { dictation } = readConfig();
  if (!(await resolveWhisperBinary())) {
    return {
      ready: false,
      reason: "no-binary",
      message: "Speech engine not found — install it with: brew install whisper.cpp",
    };
  }
  if (!dictation.activeModel || !isModelInstalled(dictation.activeModel)) {
    return {
      ready: false,
      reason: "no-model",
      message: "No speech model installed yet — install one in Settings → Dictation.",
    };
  }
  if (!checkPermissions().microphone) {
    return {
      ready: false,
      reason: "no-microphone",
      message: "Clance needs microphone access to dictate.",
    };
  }
  return { ready: true };
}

/**
 * The global-shortcut entry point: starts recording, or stops and
 * transcribes if already recording.
 *
 * Press-to-start/press-to-stop rather than hold-to-talk, because Electron's
 * globalShortcut delivers no key-up event — genuine push-to-talk needs a
 * native key listener (see docs/design.md's open questions).
 */
export async function toggleDictation(): Promise<void> {
  if (state === "recording") {
    await stopRecording();
    return;
  }
  // Pressing the dictate key while it's transcribing means "get me out of
  // this" — it used to be ignored, which left a slow transcription with no
  // way to abort short of quitting the app.
  if (state === "transcribing") {
    await cancelDictation();
    return;
  }

  const availability = await checkAvailability();
  if (!availability.ready) {
    // Shows the HUD purely to explain itself — a shortcut that silently
    // does nothing is worse than one that says why.
    await showHud();
    sendToHud("dictation:unavailable", availability);
    setTimeout(() => {
      if (state === "idle") hideHud();
    }, 4000);
    return;
  }

  await startRecording();
}

async function startRecording(): Promise<void> {
  const config = readConfig();
  state = "recording";

  // Deliberately not awaited: reading the frontmost window title costs
  // ~300ms the first time (it loads a native addon) and the HUD used to
  // sit behind it, so the user pressed the hotkey and watched nothing
  // happen. Nothing about recording needs the title — it's only metadata
  // for the history row, which isn't written until after transcription —
  // so it resolves in parallel and handleAudio awaits it at the point it
  // actually matters.
  targetApp = undefined;
  targetAppPending = readFrontmostTitle().then((title) => {
    targetApp = title;
  });

  await showHud();
  setTrayRecording(true);
  sendToHud("dictation:start", {
    sampleRate: SAMPLE_RATE,
    autoStopSilenceMs: config.dictation.autoStopSilenceMs,
    maxDurationMs: config.dictation.maxDurationMs,
    targetApp: targetApp ?? null,
  });

  cancelEscapeHotkey = registerTemporaryHotkey("Escape", () => void cancelDictation());

  // Belt and braces alongside the renderer's own cap: if the HUD renderer
  // wedged, this still tears the recording down rather than leaving the
  // microphone live indefinitely.
  maxDurationTimer = setTimeout(() => {
    if (state === "recording") void stopRecording();
  }, config.dictation.maxDurationMs + 5000);
}

/** Asks the HUD to stop capturing and send its buffer over. */
async function stopRecording(): Promise<void> {
  if (state !== "recording") return;
  state = "transcribing";
  // Note: deliberately does NOT release the Escape hotkey — that's held
  // until the state machine returns to idle (see settleToIdle), so Escape
  // keeps working while transcription runs.
  if (maxDurationTimer) clearTimeout(maxDurationTimer);
  maxDurationTimer = undefined;
  setTrayRecording(false);
  sendToHud("dictation:stop");
  sendToHud("dictation:state", { state: "transcribing" });
}

export async function cancelDictation(): Promise<void> {
  if (state === "idle") return;
  // Kills an in-flight transcription rather than letting it finish and
  // paste text the user has just said they don't want.
  if (activeTranscription) {
    activeTranscription.cancelled = true;
    activeTranscription.child.kill("SIGKILL");
    activeTranscription = undefined;
  }
  settleToIdle();
  sendToHud("dictation:cancel");
  hideHud();
}

// The single place the state machine returns to idle: drops the Escape
// hotkey, the duration timer and the tray indicator together, so no path
// can leave one of them dangling.
function settleToIdle(): void {
  state = "idle";
  cancelEscapeHotkey?.();
  cancelEscapeHotkey = undefined;
  if (maxDurationTimer) clearTimeout(maxDurationTimer);
  maxDurationTimer = undefined;
  setTrayRecording(false);
}

/**
 * Handed the recorded PCM by the HUD renderer (audio capture has to happen
 * in a renderer — the main process has no getUserMedia). Writes a WAV,
 * transcribes it, inserts the text, and records it in history.
 */
export async function handleAudio(samples: Float32Array): Promise<void> {
  if (state !== "transcribing") return;

  const config = readConfig();
  const modelId = config.dictation.activeModel;
  const binary = await resolveWhisperBinary();

  if (!modelId || !binary || samples.length === 0) {
    settleToIdle();
    hideHud();
    return;
  }

  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  mkdirSync(AUDIO_DIR, { recursive: true });
  const stamp = Date.now();
  const wavPath = join(AUDIO_DIR, `dictation-${stamp}.wav`);
  const outBase = join(AUDIO_DIR, `dictation-${stamp}`);

  try {
    writeFileSync(wavPath, buildWavFile(samples, SAMPLE_RATE));

    const started = Date.now();
    const text = await transcribe(binary, modelPath(modelId), wavPath, outBase, config.dictation.vocabulary);
    const transcribeMs = Date.now() - started;

    // A cancel that landed while whisper was running: the process was
    // killed, state is already idle, and the HUD is down. Returning here
    // stops a cancelled dictation from still pasting and being recorded.
    if (state !== "transcribing") return;

    if (!text) {
      sendToHud("dictation:empty");
      setTimeout(() => {
        if (state === "transcribing") {
          settleToIdle();
          hideHud();
        }
      }, 1800);
      return;
    }

    // Insert first, record second: the paste is the time-critical part the
    // user is waiting on, and a history write failing must not cost them
    // the text itself.
    let inserted = false;
    if (config.dictation.insertMode === "paste" && checkPermissions().accessibility) {
      try {
        await pasteAtCursor(text);
        inserted = true;
      } catch {
        clipboard.writeText(text);
      }
    } else {
      // Clipboard-only: either the user's preference, or Accessibility
      // isn't granted. Degrades rather than failing — see docs/design.md's "Dictation".
      clipboard.writeText(text);
    }

    // The only point the target app's title is actually needed.
    await targetAppPending;

    const transcript = addTranscript({
      text,
      createdAt: stamp,
      durationMs,
      transcribeMs,
      model: modelId,
      targetApp: targetApp ?? null,
      inserted,
    });

    sendToHud("dictation:done", { text, inserted, transcribeMs });
    for (const listener of listeners) listener(transcript);

    setTimeout(() => {
      if (state === "transcribing") {
        settleToIdle();
        hideHud();
      }
    }, 900);
  } catch (error) {
    // A kill from cancelDictation surfaces here as a spawn error; it's not
    // a failure worth showing, the HUD is already down. Read through the
    // getter: `state` is narrowed to "transcribing" by the guard above, but
    // cancelDictation can genuinely have changed it across the await.
    if (getDictationState() === "idle") return;
    settleToIdle();
    sendToHud("dictation:error", {
      message: error instanceof Error ? error.message : String(error),
    });
    setTimeout(() => hideHud(), 3000);
  } finally {
    if (!config.dictation.keepAudio) rmSync(wavPath, { force: true });
    rmSync(`${outBase}.txt`, { force: true });
  }
}

/**
 * One `whisper-cli` run per utterance.
 *
 * Spawn-per-utterance rather than a warm process: Phase 0 measured the
 * spawn plus model load at ~350ms of a 737ms total, which isn't worth
 * holding ~720MB resident permanently on an 8GB machine to reclaim.
 *
 * Flags are the Phase 0 shipping config. Greedy (`-bo 1 -bs 1`) beat the
 * default 5-beam search on speed *and* tied it on output, and `--prompt`
 * vocabulary seeding is what recovers camelCase identifiers and `src` vs
 * `source`. `-otxt -of` writes the transcript to a file instead of making
 * this parse it out of stdout alongside ggml's own logging.
 */
async function transcribe(
  binary: string,
  model: string,
  wavPath: string,
  outBase: string,
  vocabulary: string
): Promise<string> {
  const { perfCores } = await detectMachine();
  const args = [
    "-m", model,
    "-f", wavPath,
    "-l", "en",
    "-t", String(Math.max(2, Math.min(perfCores, 8))),
    "-bo", "1",
    "-bs", "1",
    "-nt",
    "-np",
    "-otxt",
    "-of", outBase,
  ];
  if (vocabulary.trim()) args.push("--prompt", vocabulary.trim());

  // Spawned rather than awaited through promisify so the child handle is
  // available to cancelDictation, which needs to be able to kill it.
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      (error) => {
        const wasCancelled = activeTranscription?.cancelled === true;
        activeTranscription = undefined;
        if (wasCancelled) resolve();
        else if (error) reject(error);
        else resolve();
      }
    );
    activeTranscription = { child, cancelled: false };
  });

  try {
    return cleanTranscript(readFileSync(`${outBase}.txt`, "utf8"));
  } catch {
    return "";
  }
}

// whisper emits its own leading space and a trailing newline, and marks
// non-speech with bracketed tags like `[BLANK_AUDIO]` or `(silence)` that
// would otherwise be pasted into the user's document verbatim.
function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[A-Z_ ]+\]/g, "")
    .replace(/\((?:silence|music|inaudible)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
