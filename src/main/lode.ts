import { app, BrowserWindow, safeStorage, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { readFileSync } from "fs";
import { join } from "path";
import { readConfig, writeConfig } from "./config";
import { resolveFolder } from "./files";
import { mainWindowContents } from "./mainWindow";

// lode (the `lode-graph` package, github.com/damiensmith1/lode-graph) reads a project as a code graph for
// the Flow tabs. Each project folder gets its own lode, in a utility process
// (lodeWorker.ts) so indexing never blocks the main process, started the
// first time a window talks to that folder and kept while a window does.
//
// The main process only relays: a window's messages (lode's
// MessageConnection protocol) go to that folder's worker, and the worker's
// replies, change notices and events go back to every window using it, as
// "lode:msg" { root, message }. If a worker fails or exits, windows hear
// "lode:status" { root, state: "failed", error } and the next message
// starts a new one.
//
// Keys are Clance's to give, never lode's to find: the Jev key that builds
// a flow for a "/" question is the one set in Settings (or setup), kept
// encrypted in Clance's config with the system keychain (safeStorage); else
// Clance's environment; else, in a dev run, the repo's .env (which nothing
// else reads). A packaged app has no .env, so there it's Settings or the
// environment. Each worker gets it in its environment, and again whenever
// it changes ("jev-key", lodeWorker.ts), so running lodes pick it up.

export type JevSource = "settings" | "environment" | "env-file";

function storedJevKey(): string | undefined {
  const sealed = readConfig().jevKey;
  if (!sealed || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(sealed, "base64")) || undefined;
  } catch {
    return undefined;
  }
}

function envFileJevKey(): string | undefined {
  if (app.isPackaged) return undefined;
  try {
    const line = readFileSync(join(__dirname, "../../.env"), "utf8").match(/^\s*TYPESAFE_API_KEY\s*=\s*(.*)$/m);
    return line?.[1].trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

function jevKey(): { key: string; source: JevSource } | null {
  const stored = storedJevKey();
  if (stored) return { key: stored, source: "settings" };
  if (process.env.TYPESAFE_API_KEY) return { key: process.env.TYPESAFE_API_KEY, source: "environment" };
  const file = envFileJevKey();
  return file ? { key: file, source: "env-file" } : null;
}

/** Whether "/" questions can be asked, and where the key comes from (never
 *  the key itself). */
export function jevStatus(): { source: JevSource | null } {
  return { source: jevKey()?.source ?? null };
}

/** Set (or, with null, remove) the Jev key kept in Settings; running lodes
 *  and windows hear the new status. */
export function setJevKey(key: string | null): { source: JevSource | null } {
  const trimmed = key?.trim();
  if (trimmed && !safeStorage.isEncryptionAvailable()) throw new Error("This Mac's keychain isn't available to keep the key in.");
  const config = readConfig();
  if (trimmed) config.jevKey = safeStorage.encryptString(trimmed).toString("base64");
  else delete config.jevKey;
  writeConfig(config);
  const now = jevKey();
  for (const worker of workers.values()) worker.proc.postMessage({ clance: "jev-key", key: now?.key ?? null });
  const status = { source: now?.source ?? null };
  for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send("lode:jev", status);
  return status;
}

interface Worker {
  proc: UtilityProcess;
  senders: Set<WebContents>;
}

const workers = new Map<string, Worker>();
const watchedSenders = new Set<number>();

function workerFor(root: string): Worker {
  const existing = workers.get(root);
  if (existing) return existing;
  const key = jevKey()?.key;
  const proc = utilityProcess.fork(join(__dirname, "lodeWorker.js"), [root], {
    serviceName: "lode",
    stdio: "pipe",
    env: { ...process.env, TYPESAFE_API_KEY: key ?? "" },
  });
  const worker: Worker = { proc, senders: new Set() };
  workers.set(root, worker);
  let error = "";
  proc.stderr?.on("data", (chunk: Buffer) => (error = (error + chunk.toString()).slice(-2000)));
  proc.on("message", (message: { method?: string; id?: unknown; result?: unknown; error?: string; params?: { error?: string } }) => {
    if (message?.method === "failed") {
      error = message.params?.error ?? error;
      return;
    }
    // An answer to main's own call (lodeCall), not a window's.
    if (typeof message?.id === "string" && message.id.startsWith("main:")) {
      const waiting = mainCalls.get(message.id);
      mainCalls.delete(message.id);
      if (message.error !== undefined) waiting?.reject(new Error(message.error));
      else waiting?.resolve(message.result);
      return;
    }
    for (const sender of worker.senders) if (!sender.isDestroyed()) sender.send("lode:msg", { root, message });
  });
  proc.on("exit", (code) => {
    if (workers.get(root) === worker) workers.delete(root);
    if (code === 0) return;
    for (const sender of worker.senders) if (!sender.isDestroyed()) sender.send("lode:status", { root, state: "failed", error: error.trim() || `lode stopped (${code})` });
  });
  return worker;
}

/** A window's message for a project's lode. */
export function lodeSend(sender: WebContents, root: unknown, message: unknown): void {
  const dir = resolveFolder(root);
  if (!dir || dir !== root) return;
  const worker = workerFor(dir);
  worker.senders.add(sender);
  if (!watchedSenders.has(sender.id)) {
    watchedSenders.add(sender.id);
    sender.once("destroyed", () => {
      watchedSenders.delete(sender.id);
      for (const [key, w] of workers) {
        w.senders.delete(sender);
        if (!w.senders.size) stopLode(key);
      }
    });
  }
  worker.proc.postMessage(message);
}

// Main's own calls to a project's lode (the lode tools Claude sessions
// use, localToolsServer.ts), by an id windows never use.
const mainCalls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCall = 1;

/** Call a project's lode from main: a service method and its params. Only
 *  for a folder a window already has a lode for (its lode tabs), so this
 *  never starts one nothing would stop. */
export function lodeCall(root: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const worker = workers.get(root);
  if (!worker) return Promise.reject(new Error(`no lode tab is open on ${root}`));
  const id = `main:${nextCall++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mainCalls.delete(id);
      reject(new Error(`lode didn't answer ${method} in time`));
    }, 60_000);
    mainCalls.set(id, {
      resolve: (value) => (clearTimeout(timer), resolve(value)),
      reject: (error) => (clearTimeout(timer), reject(error)),
    });
    worker.proc.postMessage({ lode: 1, id, method, params });
  });
}

// --- the lode tabs themselves, for the tools: the window holds the canvases ---

const canvasCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCanvasCall = 1;

/** Ask the main window about its lode tabs ("list", "read", "apply", see
 *  Shell.js's canvas handler). */
export function canvasRequest(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const contents = mainWindowContents();
  if (!contents) return Promise.reject(new Error("Clance's main window isn't open, so there are no lode tabs"));
  const id = nextCanvasCall++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      canvasCalls.delete(id);
      reject(new Error("the lode tab didn't answer in time"));
    }, 120_000);
    canvasCalls.set(id, {
      resolve: (value) => (clearTimeout(timer), resolve(value)),
      reject: (error) => (clearTimeout(timer), reject(error)),
    });
    contents.send("lode:canvas-request", { id, op, args });
  });
}

/** The window's answer to a canvasRequest. */
export function canvasReply(id: unknown, result: unknown, error: unknown): void {
  const waiting = typeof id === "number" ? canvasCalls.get(id) : undefined;
  if (!waiting) return;
  canvasCalls.delete(id as number);
  if (typeof error === "string") waiting.reject(new Error(error));
  else waiting.resolve(result);
}

/** A window is done with a project's lode (its last Flow tab closed). */
export function lodeRelease(sender: WebContents, root: unknown): void {
  if (typeof root !== "string") return;
  const worker = workers.get(root);
  if (!worker) return;
  worker.senders.delete(sender);
  if (!worker.senders.size) stopLode(root);
}

function stopLode(root: string): void {
  const worker = workers.get(root);
  if (!worker) return;
  workers.delete(root);
  worker.proc.kill();
}

/** On quit. */
export function stopAllLodes(): void {
  for (const root of [...workers.keys()]) stopLode(root);
}
