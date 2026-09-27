import { realpathSync } from "fs";
import { sep } from "path";
import { addWritableRoot, getDefaultDirectory, readConfig } from "./config";
import { findRepoRoot, isDirectory } from "./git";
import { listAgents } from "./agentSessions";
import { SESSION_CWD } from "./paths";

// Where the editor and file operations may write. Reads are looser — a file
// tab reads whatever folder the renderer names, inside that folder — but a
// write is the one thing the main window's bridge can do that isn't undone
// by closing a tab, so the places it may land are decided here rather than by
// whatever path arrives over IPC.
//
// A path is writable when it's inside one of:
// - a root registered by something the main process owns: a folder picked in
//   its dialog, a file or folder opened from Finder or `clance`;
// - the places Clance already works: the default session directory, recent
//   session directories, ~/.clance, where the running agents are working;
// - the repository around any of those.
//
// Every path is compared after resolving symbolic links, the same order the
// read side uses, because a link inside an allowed folder can point anywhere.
//
// This sits on every save, so it has to be cheap. The places from config are
// checked first — they cover nearly every save — and each folder's
// repository is looked up once and remembered. Asking the CLI where the agents
// are working costs a subprocess (~0.5 s), so that list is only consulted when
// nothing else matched, and is refreshed at most once a minute.

const AGENT_ROOTS_MS = 60_000;

// folder → [its real path, its repository's real path], looked up once.
const expanded = new Map<string, string[]>();
let agentRoots: { at: number; roots: string[] } | null = null;
let agentRefresh: Promise<string[]> | null = null;

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

async function expand(base: string): Promise<string[]> {
  const known = expanded.get(base);
  if (known) return known;
  const out: string[] = [];
  if (isDirectory(base)) {
    const resolved = real(base);
    if (resolved) out.push(resolved);
    const repo = await findRepoRoot(base);
    const resolvedRepo = repo ? real(repo) : null;
    if (resolvedRepo && resolvedRepo !== resolved) out.push(resolvedRepo);
  }
  expanded.set(base, out);
  return out;
}

function inside(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

async function configRoots(): Promise<string[]> {
  const config = readConfig();
  const bases = [...config.writableRoots, getDefaultDirectory(), SESSION_CWD, ...config.recentDirectories];
  return (await Promise.all(bases.map(expand))).flat();
}

async function currentAgentRoots(): Promise<string[]> {
  if (agentRoots && Date.now() - agentRoots.at < AGENT_ROOTS_MS) return agentRoots.roots;
  agentRefresh ??= (async () => {
    const agents = await listAgents({ all: true }).catch(() => []);
    const cwds = [...new Set(agents.map((agent) => agent.cwd).filter((cwd): cwd is string => typeof cwd === "string"))];
    const roots = (await Promise.all(cwds.map(expand))).flat();
    agentRoots = { at: Date.now(), roots };
    return roots;
  })().finally(() => {
    agentRefresh = null;
  });
  return agentRefresh;
}

/** Records a folder the person chose through the main process. */
export async function registerRoot(dir: string): Promise<void> {
  const resolved = real(dir);
  if (!resolved || !isDirectory(resolved)) return;
  addWritableRoot(resolved);
}

/**
 * Whether an absolute, already-resolved path may be written. The caller
 * resolves (the file itself if it exists, else its parent) before asking.
 */
export async function isWritable(resolvedPath: string): Promise<boolean> {
  if (inside(resolvedPath, await configRoots())) return true;
  return inside(resolvedPath, await currentAgentRoots());
}
