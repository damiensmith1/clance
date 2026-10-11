import { app, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveFolder } from "./files";

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
// a flow for a "/" question comes from Clance's environment, or in a dev
// run from the repo's .env (which nothing else reads), and is handed to the
// worker, which gives it to lode as its judge.

function jevKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  if (app.isPackaged) return undefined;
  try {
    const line = readFileSync(join(__dirname, "../../.env"), "utf8").match(/^\s*TYPESAFE_API_KEY\s*=\s*(.*)$/m);
    return line?.[1].trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
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
  const key = jevKey();
  const proc = utilityProcess.fork(join(__dirname, "lodeWorker.js"), [root], {
    serviceName: "lode",
    stdio: "pipe",
    env: { ...process.env, ...(key && { TYPESAFE_API_KEY: key }) },
  });
  const worker: Worker = { proc, senders: new Set() };
  workers.set(root, worker);
  let error = "";
  proc.stderr?.on("data", (chunk: Buffer) => (error = (error + chunk.toString()).slice(-2000)));
  proc.on("message", (message: { method?: string; params?: { error?: string } }) => {
    if (message?.method === "failed") {
      error = message.params?.error ?? error;
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
