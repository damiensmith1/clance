import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";
import { rmAgent, spawnBackgroundAgent, stopAgent, UntrustedWorkspaceError } from "./agentSessions";
import { SESSION_PLACEHOLDER_TITLE } from "./chatHistory";

// One pre-warmed session for lode's Ask Claude, in the folder of the lode
// tab you're on, so it opens at once. Like the popup's pool (agentPool.ts),
// but it follows the folder: a session's working directory is fixed when it
// starts, so showing a lode tab on another folder stops the spare and warms
// one there. Ask Claude claims it and the next warms behind it; the folder's
// last lode tab closing, or quitting, stops it.
//
// A spare is a real `claude --bg` process that isn't a conversation yet, so
// the Sessions list hides it (isLodeSpareId). Its id is also kept on disk,
// so one left running by a crash is stopped on the next launch.

interface Spare {
  root: string;
  id: string;
  mcpArgs: string[];
}

const PATH = join(SESSION_CWD, "lode-pool.json");
let spare: Spare | null = null;
let warming: { root: string; job: Promise<Spare | null>; turn: number } | null = null;
let turns = 0; // each warm-up's number, so a superseded one knows
const untrusted = new Set<string>(); // folders a background session can't start in yet

function persist(): void {
  try {
    writeFileSync(PATH, JSON.stringify(spare ? [spare.id] : []), "utf8");
  } catch {
    // Only crash cleanup depends on it.
  }
}

function discard(id: string): void {
  stopAgent(id).catch(() => {});
  rmAgent(id).catch(() => {});
}

function drop(): void {
  if (!spare) return;
  discard(spare.id);
  spare = null;
  persist();
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The spare, for `root` with these args: whatever was warm for another
 *  folder (or with other args) goes. */
export function warmLodeSession(root: string, mcpArgs: string[]): Promise<Spare | null> {
  if (spare && spare.root === root && same(spare.mcpArgs, mcpArgs)) return Promise.resolve(spare);
  if (warming?.root === root) return warming.job;
  drop();
  if (untrusted.has(root)) return Promise.resolve(null);
  const turn = ++turns;
  const job = (async () => {
    try {
      const id = await spawnBackgroundAgent(SESSION_PLACEHOLDER_TITLE, mcpArgs, root);
      // Another folder was shown while this one started: it isn't wanted.
      if (warming?.turn !== turn) {
        discard(id);
        return null;
      }
      drop();
      spare = { root, id, mcpArgs };
      persist();
      return spare;
    } catch (error) {
      if (error instanceof UntrustedWorkspaceError) untrusted.add(root);
      return null;
    } finally {
      if (warming?.turn === turn) warming = null;
    }
  })();
  warming = { root, job, turn };
  return job;
}

/** A session for `root` now: the spare if it's for `root` (or about to be),
 *  else a fresh one. The next spare starts warming behind it. */
export async function claimLodeSession(root: string, mcpArgs: string[]): Promise<{ id: string; name: string } | { untrusted: true; cwd: string }> {
  untrusted.delete(root); // it may have been trusted since
  if (warming?.root === root) await warming.job;
  let id: string | undefined;
  if (spare && spare.root === root && same(spare.mcpArgs, mcpArgs)) {
    id = spare.id;
    spare = null;
    persist();
  }
  if (!id) {
    try {
      id = await spawnBackgroundAgent(SESSION_PLACEHOLDER_TITLE, mcpArgs, root);
    } catch (error) {
      if (error instanceof UntrustedWorkspaceError) return { untrusted: true, cwd: root };
      throw error;
    }
  }
  void warmLodeSession(root, mcpArgs);
  return { id, name: SESSION_PLACEHOLDER_TITLE };
}

/** The folder's last lode tab closed: its spare goes. */
export function releaseLodeSession(root: string): void {
  if (warming?.root === root) warming = null; // what it starts is discarded
  if (spare?.root === root) drop();
}

/** Quitting: the spare goes. */
export function releaseAllLodeSessions(): void {
  warming = null;
  drop();
}

/** A spare a crash left running, from the last launch. */
export function discardLeftoverLodeSessions(): void {
  try {
    const ids = JSON.parse(readFileSync(PATH, "utf8"));
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") discard(id);
  } catch {
    // None.
  }
  persist();
}

/** For the Sessions list: the spare isn't a conversation yet. */
export function isLodeSpareId(id: string): boolean {
  return spare?.id === id;
}
