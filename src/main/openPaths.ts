import { app } from "electron";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative, sep } from "path";
import { findRepoRoot } from "./git";
import { registerRoot } from "./roots";
import { sendToMainWindow } from "./mainWindow";
import { getLoginShellPath } from "./ptyManager";

// Files and folders opened in Clance from outside it: Finder's Open With,
// a drop on the Dock icon, double-clicking a file Clance is the default app
// for, and the `clance` command (which runs `open -b`, so it arrives the same
// way). macOS delivers all of them as `open-file`, including during launch —
// before the window exists — so paths are queued until it's ready.
//
// A path opened this way was chosen by the person, through the OS, so its
// folder (or repository) becomes somewhere the editor may write (roots.ts).

export type OpenPath =
  | { kind: "file"; root: string; path: string }
  | { kind: "folder"; root: string };

async function resolve(target: string): Promise<OpenPath | null> {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return null;
  }
  let isDir: boolean;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    return null;
  }
  if (isDir) {
    await registerRoot(real);
    return { kind: "folder", root: real };
  }
  const folder = dirname(real);
  const repo = await findRepoRoot(folder);
  let root = folder;
  if (repo) {
    try {
      const realRepo = realpathSync(repo);
      if (real.startsWith(realRepo + sep)) root = realRepo;
    } catch {
      // The file's own folder, then.
    }
  }
  await registerRoot(root);
  return { kind: "file", root, path: relative(root, real).split(sep).join("/") };
}

let ready = false;
const queue: string[] = [];
// Resolved and waiting for the renderer to take them. Held here rather than
// only sent, because the window finishing loading isn't the same as its tabs
// listening: the renderer takes whatever is waiting when it mounts, and again
// whenever it's told more has arrived.
const pending: OpenPath[] = [];

async function deliver(paths: string[]): Promise<void> {
  const resolved = (await Promise.all(paths.map(resolve))).filter((p): p is OpenPath => p !== null);
  if (resolved.length === 0) return;
  pending.push(...resolved);
  await sendToMainWindow("open-paths-available");
}

export function takeOpenedPaths(): OpenPath[] {
  return pending.splice(0);
}

/** Registered before `ready`: macOS sends launch-time opens early. */
export function listenForOpenedPaths(): void {
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (ready) void deliver([path]);
    else queue.push(path);
  });
}

/** Once the app can show a window, hands over anything opened during launch. */
export function flushOpenedPaths(): void {
  ready = true;
  if (queue.length === 0) return;
  void deliver(queue.splice(0));
}

// ---- the `clance` command --------------------------------------------------

/** The script inside the app (or the repo, for a dev build). */
function scriptPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "bin", "clance") : join(__dirname, "../../packaging/bin/clance");
}

// Where to link it: the first of these that exists and is writable without
// asking for a password. Homebrew's bin is already on PATH for anyone who
// installed Clance through the cask (which links it itself).
function candidateDirs(): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")];
}

export type CliStatus = { installed: string | null; script: string };

export function cliStatus(): CliStatus {
  const script = scriptPath();
  for (const dir of candidateDirs()) {
    const link = join(dir, "clance");
    try {
      if (lstatSync(link).isSymbolicLink() || existsSync(link)) return { installed: link, script };
    } catch {
      // Not there.
    }
  }
  return { installed: null, script };
}

export async function installCli(): Promise<{ ok: true; path: string; onPath: boolean } | { ok: false; error: string }> {
  const script = scriptPath();
  if (!existsSync(script)) return { ok: false, error: "The clance script isn't in this build" };
  for (const dir of candidateDirs()) {
    const isHomeBin = dir.startsWith(homedir());
    if (!existsSync(dir)) {
      if (!isHomeBin) continue;
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        continue;
      }
    }
    const link = join(dir, "clance");
    try {
      // Replace an older link of ours; never a file someone else put there.
      if (existsSync(link) || lstatSync(link).isSymbolicLink()) {
        if (!lstatSync(link).isSymbolicLink() || !readlinkSync(link).endsWith(join("bin", "clance"))) continue;
        unlinkSync(link);
      }
    } catch {
      // Nothing there yet.
    }
    try {
      symlinkSync(script, link);
    } catch {
      continue;
    }
    const onPath = !isHomeBin || (await getLoginShellPath()).split(":").includes(dir);
    return { ok: true, path: link, onPath };
  }
  return { ok: false, error: "No writable bin folder found" };
}
