import { execFile } from "child_process";
import { createHash } from "crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { statfs } from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { join } from "path";
import { promisify } from "util";
import { SESSION_CWD } from "./paths";
import { getLoginShellPath } from "./ptyManager";

const execFileAsync = promisify(execFile);

export const MODELS_DIR = join(SESSION_CWD, "models");

// ggml weights from whisper.cpp's own Hugging Face repo. Sizes and hashes
// are the *measured* values of the exact files the Phase 0 spike ran
// against (see docs/design.md's "Dictation") — not copied from a README — so a
// verified install is byte-identical to what those numbers describe.
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export type WhisperModel = {
  id: string;
  label: string;
  bytes: number;
  sha256: string;
  // Rough peak RSS during transcription, measured on an M2. Shown to the
  // user because it's the number that actually matters on a small machine,
  // and it isn't proportional to download size — see `large-v3-turbo-q5_0`.
  peakRssMb: number;
  note: string;
};

export const MODEL_CATALOG: WhisperModel[] = [
  {
    id: "tiny.en",
    label: "Tiny (English)",
    bytes: 77_704_715,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    peakRssMb: 250,
    note: "Fastest, but mangles technical terms. Only worth it on very old hardware.",
  },
  {
    id: "base.en",
    label: "Base (English)",
    bytes: 147_964_211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    peakRssMb: 360,
    note: "Fast, still unreliable on code identifiers and file paths.",
  },
  {
    id: "small.en",
    label: "Small (English)",
    bytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    peakRssMb: 760,
    note: "The first tier that gets code vocabulary right. ~0.7s for a 10s phrase on an M2.",
  },
  {
    id: "large-v3-turbo-q5_0",
    label: "Large v3 Turbo (quantized)",
    bytes: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    peakRssMb: 742,
    note: "Multilingual and highest quality, but ~2.4s on a base M-series chip.",
  },
];

export function findModel(id: string): WhisperModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function modelPath(id: string): string {
  return join(MODELS_DIR, `ggml-${id}.bin`);
}

export function isModelInstalled(id: string): boolean {
  const model = findModel(id);
  if (!model) return false;
  try {
    // Size check, not just existence: a `.part` file renamed by hand, or a
    // truncated copy from an older/interrupted install, would otherwise
    // read as installed and then fail at transcription time instead.
    return statSync(modelPath(id)).size === model.bytes;
  } catch {
    return false;
  }
}

// ---- machine detection ----

export type MachineSpecs = {
  chip: string;
  gpuCores: number | null;
  perfCores: number;
  memBytes: number;
  freeDiskBytes: number;
  appleSilicon: boolean;
};

let cachedSpecs: MachineSpecs | undefined;

async function sysctl(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", key], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

// `system_profiler SPDisplaysDataType` is the only place macOS exposes the
// GPU core count, and it costs ~170ms — hence the cache. That count is what
// the model recommendation keys off: Phase 0 found latency (GPU throughput),
// not memory, is what makes a tier unusable, and the quantized large model
// is simultaneously *lighter* and 2.6x slower than `small.en`.
async function detectGpuCores(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/system_profiler",
      ["SPDisplaysDataType"],
      { encoding: "utf8", timeout: 5000 }
    );
    const match = stdout.match(/Total Number of Cores:\s*(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function detectMachine(): Promise<MachineSpecs> {
  if (cachedSpecs) return cachedSpecs;

  const [chip, memRaw, perfRaw, ncpuRaw, gpuCores] = await Promise.all([
    sysctl("machdep.cpu.brand_string"),
    sysctl("hw.memsize"),
    sysctl("hw.perflevel0.physicalcpu"),
    sysctl("hw.ncpu"),
    detectGpuCores(),
  ]);

  let freeDiskBytes = 0;
  try {
    const fsStat = await statfs(SESSION_CWD);
    freeDiskBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
  } catch {
    freeDiskBytes = 0;
  }

  const chipName = chip || "Unknown CPU";
  cachedSpecs = {
    chip: chipName,
    gpuCores,
    // `hw.perflevel0.physicalcpu` is performance cores on Apple Silicon and
    // absent on Intel, where hw.ncpu is the only answer available.
    perfCores: Number(perfRaw) || Math.max(1, Math.floor((Number(ncpuRaw) || 4) / 2)),
    memBytes: Number(memRaw) || 0,
    freeDiskBytes,
    appleSilicon: /Apple/i.test(chipName),
  };
  return cachedSpecs;
}

export type Recommendation = {
  modelId: string;
  reason: string;
  specs: MachineSpecs;
};

const GB = 1024 ** 3;

/**
 * Picks one model for this machine, with a reason the user can read.
 *
 * Keyed off GPU cores rather than RAM — see the benchmark in docs/design.md's
 * "Engine" section. RAM and free disk are guards only: they can push the pick
 * *down* a tier but never up.
 */
export async function recommendModel(): Promise<Recommendation> {
  const specs = await detectMachine();
  const chipLabel = specs.chip.replace(/^Apple\s+/, "");
  const memGb = Math.round(specs.memBytes / GB);

  let modelId: string;
  let reason: string;

  if (!specs.appleSilicon) {
    modelId = "base.en";
    reason = `${specs.chip} has no Metal GPU worth assuming, so Base keeps dictation responsive.`;
  } else if (specs.gpuCores !== null && specs.gpuCores > 10) {
    modelId = "large-v3-turbo-q5_0";
    reason = `${chipLabel} with ${specs.gpuCores} GPU cores can run the highest-quality model fast enough.`;
  } else {
    modelId = "small.en";
    const cores = specs.gpuCores ? `${specs.gpuCores} GPU cores` : "an integrated GPU";
    reason = `${chipLabel} (${cores}, ${memGb} GB) — Small is the fastest model that still gets code vocabulary right.`;
  }

  // Guards. A machine that can't comfortably hold or store the pick gets
  // stepped down rather than handed something that will swap or fail
  // mid-download.
  const picked = findModel(modelId)!;
  if (specs.memBytes > 0 && specs.memBytes < 4 * GB && modelId !== "base.en") {
    modelId = "base.en";
    reason = `Only ${memGb} GB of memory, so Base is the safe pick here.`;
  } else if (specs.freeDiskBytes > 0 && specs.freeDiskBytes < picked.bytes * 2) {
    const freeGb = (specs.freeDiskBytes / GB).toFixed(1);
    modelId = modelId === "large-v3-turbo-q5_0" ? "small.en" : "base.en";
    reason = `Only ${freeGb} GB free on disk, so stepping down to keep room to spare.`;
  }

  return { modelId, reason, specs };
}

// ---- whisper binary ----

let cachedBinary: string | undefined;

/**
 * The `whisper-cli` binary, provided by Homebrew's `whisper.cpp`.
 *
 * Not bundled into the app. Clance is distributed from the command line, so
 * the engine is a Homebrew dependency rather than a static binary built
 * with cmake and shipped inside the bundle (decided 2026-09-16 — see
 * docs/design.md's "Dictation"). Returns undefined when it isn't installed, so callers
 * can surface that instead of a spawn error.
 */
export async function resolveWhisperBinary(): Promise<string | undefined> {
  if (cachedBinary) return cachedBinary;

  // Standard Homebrew locations first. Found here, there's no need to wait
  // on the login-shell PATH below — which runs an interactive shell and can
  // take many seconds on a first launch — just to locate a binary that lives
  // somewhere entirely predictable.
  for (const candidate of ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]) {
    if (existsSync(candidate)) {
      cachedBinary = candidate;
      return cachedBinary;
    }
  }

  // Anything else. GUI-launched apps inherit launchd's minimal PATH, so this
  // has to go through the same resolved login-shell PATH that ptyManager
  // uses to find `claude` — plain `which` against process.env.PATH would
  // miss it.
  try {
    const path = await getLoginShellPath();
    const { stdout } = await execFileAsync("/usr/bin/which", ["whisper-cli"], {
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });
    const found = stdout.trim();
    if (found && existsSync(found)) {
      cachedBinary = found;
      return cachedBinary;
    }
  } catch {
    // Falls through to undefined — not installed.
  }
  return undefined;
}

// ---- install ----

export type DownloadProgress = {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  phase: "downloading" | "verifying" | "warming" | "done" | "error";
  message?: string;
};

const activeDownloads = new Map<string, AbortController>();
// Last progress emitted per in-flight download. Progress arrives as IPC
// pushes, which a renderer that wasn't mounted at the time never saw — so
// a UI opening mid-download needs to be able to *ask* what's happening
// rather than infer "not installed, show Install".
const inFlightProgress = new Map<string, DownloadProgress>();

/** Snapshot of every download currently running. */
export function getActiveInstalls(): DownloadProgress[] {
  return [...inFlightProgress.values()];
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Downloads, verifies, and installs a model, reporting progress as it goes.
 *
 * Resumable: bytes land in a `.part` file that a later call picks up with a
 * Range request, so a cancelled or dropped 500MB download isn't restarted
 * from zero. Verified by SHA-256 *before* being moved into place, and moved
 * with a rename, so `isModelInstalled` can never see a partial file.
 */
export type InstallOutcome = "installed" | "cancelled";

export async function installModel(
  modelId: string,
  onProgress: (p: DownloadProgress) => void
): Promise<InstallOutcome> {
  const model = findModel(modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  if (activeDownloads.has(modelId)) throw new Error(`${model.label} is already downloading.`);

  mkdirSync(MODELS_DIR, { recursive: true });
  const target = modelPath(modelId);
  const partial = `${target}.part`;

  const controller = new AbortController();
  activeDownloads.set(modelId, controller);

  // Wraps the caller's callback so the latest progress is always queryable
  // via getActiveInstalls, not just pushed once and forgotten.
  const report = (progress: DownloadProgress) => {
    inFlightProgress.set(modelId, progress);
    onProgress(progress);
  };

  try {
    let alreadyHave = 0;
    try {
      alreadyHave = statSync(partial).size;
    } catch {
      alreadyHave = 0;
    }
    if (alreadyHave > model.bytes) {
      // A `.part` longer than the finished file can only be corrupt; a
      // Range request from there would hang or 416 rather than recover.
      rmSync(partial, { force: true });
      alreadyHave = 0;
    }

    // Pre-flight the disk before pulling hundreds of megabytes. The
    // recommendation already accounts for free space, but a model chosen
    // by hand doesn't go through that, and running out mid-download leaves
    // a partial file and a vague network-ish error.
    const remaining = model.bytes - alreadyHave;
    const { freeDiskBytes } = await detectMachine();
    if (freeDiskBytes > 0 && freeDiskBytes < remaining + 200 * 1024 * 1024) {
      throw new Error(
        `Not enough free disk space — ${model.label} needs ` +
          `${Math.ceil(remaining / 1024 ** 2)} MB and only ` +
          `${Math.floor(freeDiskBytes / 1024 ** 2)} MB is available.`
      );
    }

    if (alreadyHave < model.bytes) {
      const headers: Record<string, string> = {};
      if (alreadyHave > 0) headers.Range = `bytes=${alreadyHave}-`;

      const response = await fetch(`${HF_BASE}/ggml-${modelId}.bin`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed (HTTP ${response.status}).`);
      }

      // A server that ignored the Range header sends 200 with the whole
      // file; appending that to existing bytes would silently corrupt it.
      const resuming = response.status === 206;
      let received = resuming ? alreadyHave : 0;

      report({
        modelId,
        receivedBytes: received,
        totalBytes: model.bytes,
        phase: "downloading",
      });

      let lastReport = 0;
      const source = Readable.fromWeb(response.body as never);
      source.on("data", (chunk: Buffer) => {
        received += chunk.length;
        // Throttled: a 500MB download fires thousands of chunks and every
        // report crosses an IPC boundary into the renderer.
        if (received - lastReport > 2_000_000) {
          lastReport = received;
          report({
            modelId,
            receivedBytes: received,
            totalBytes: model.bytes,
            phase: "downloading",
          });
        }
      });

      await pipeline(source, createWriteStream(partial, { flags: resuming ? "a" : "w" }));
    }

    report({ modelId, receivedBytes: model.bytes, totalBytes: model.bytes, phase: "verifying" });
    const digest = await sha256File(partial);
    if (digest !== model.sha256) {
      rmSync(partial, { force: true });
      throw new Error("Downloaded file failed its checksum and was discarded.");
    }

    renameSync(partial, target);

    // Phase 0's most dangerous finding: the first Metal-backed run on a
    // machine compiles shaders for ~18s. Paying that here, while the
    // install UI is still on screen and the user expects to be waiting,
    // means the first real dictation doesn't look like a 18-second hang.
    report({ modelId, receivedBytes: model.bytes, totalBytes: model.bytes, phase: "warming" });
    await warmUpModel(modelId);

    report({ modelId, receivedBytes: model.bytes, totalBytes: model.bytes, phase: "done" });
    return "installed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = controller.signal.aborted;
    report({
      modelId,
      receivedBytes: 0,
      totalBytes: model.bytes,
      phase: "error",
      message: cancelled ? "Download cancelled." : message,
    });
    // A cancel is a normal outcome, not a failure — but the caller has to
    // be able to tell the difference. It previously resolved exactly like a
    // successful install, so cancelling the first-ever download still made
    // that model "active" with no file on disk.
    if (!cancelled) throw error;
    return "cancelled";
  } finally {
    activeDownloads.delete(modelId);
    inFlightProgress.delete(modelId);
  }
}

export function cancelInstall(modelId: string): boolean {
  const controller = activeDownloads.get(modelId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Deletes an installed model's weights (and any stale partial download). */
export function removeModel(modelId: string): void {
  rmSync(modelPath(modelId), { force: true });
  rmSync(`${modelPath(modelId)}.part`, { force: true });
}

/**
 * Runs one throwaway inference over a fraction of a second of silence,
 * purely to force Metal shader compilation into the OS shader cache.
 * Best-effort: if it fails, the only consequence is that the first real
 * dictation is slow, so a failure here must not fail the install.
 */
export async function warmUpModel(modelId: string): Promise<void> {
  const binary = await resolveWhisperBinary();
  if (!binary) return;

  const silence = join(MODELS_DIR, ".warmup.wav");
  try {
    const { writeFileSync } = await import("fs");
    writeFileSync(silence, buildWavFile(new Float32Array(16000 / 2), 16000));
    await execFileAsync(binary, ["-m", modelPath(modelId), "-f", silence, "-nt", "-np", "-t", "2"], {
      timeout: 120_000,
    });
  } catch {
    // Best effort, by design.
  } finally {
    rmSync(silence, { force: true });
  }
}

/**
 * 16-bit mono PCM WAV from float samples. whisper.cpp reads WAV via
 * miniaudio, which handles this but not the WebM/Opus a MediaRecorder
 * would produce — which is why the HUD captures raw PCM instead.
 */
export function buildWavFile(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

export type ModelStatus = WhisperModel & { installed: boolean; active: boolean };

export async function listModels(activeModelId: string | null): Promise<{
  models: ModelStatus[];
  recommendation: Recommendation;
  binaryAvailable: boolean;
}> {
  const [recommendation, binary] = await Promise.all([recommendModel(), resolveWhisperBinary()]);
  return {
    models: MODEL_CATALOG.map((m) => ({
      ...m,
      installed: isModelInstalled(m.id),
      active: m.id === activeModelId,
    })),
    recommendation,
    binaryAvailable: Boolean(binary),
  };
}
