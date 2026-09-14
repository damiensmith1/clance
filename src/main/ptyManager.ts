import * as pty from "node-pty";
import { BrowserWindow, clipboard, nativeImage, ClipboardItem } from "electron";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

const execFileAsync = promisify(execFile);

// `win` is mutable per-session (not just captured at spawn time) so a
// session can be reparented to a different window after the fact — see
// reparentPty, used when "Open in App" moves a popup's live session into
// the main window without restarting the underlying CLI process.
type PtySession = { proc: pty.IPty; win: BrowserWindow };

const sessions = new Map<string, PtySession>();

// GUI-launched apps (vs. a terminal-launched dev build) inherit launchd's
// minimal PATH, missing directories a login shell would add (e.g. nvm,
// ~/.local/bin — where `claude` itself often lives). Resolve it once via a
// literal, non-interpolated login-shell invocation, never from user input,
// so we can spawn the target binary directly instead of through a shell
// string (which would otherwise be a command-injection vector via `args`).
//
// Resolution is always async — it used to fall back to a *synchronous*
// execFileSync() the first time anything needed the PATH before
// warmLoginShellPath()'s background resolution had finished. That's exactly
// what happened when a widget was opened right after app launch: the popup's
// pty attach (createPtySession) and the background agent mint
// (agentSessions.ts's claudeExecOptions) both ultimately called this, and an
// interactive login shell sourcing .zshrc/.zprofile/nvm/etc. can take the
// better part of a minute — during which the *synchronous* call froze the
// entire single-threaded Electron main process, including the local tools
// MCP HTTP server, so the `claude` child process trying to reach it over
// HTTP got nothing back and gave up (see localToolsServer.ts's session/GET
// debugging for what that failure looks like from the CLI's side). Awaiting
// the same in-flight resolution instead never blocks anything else in the
// process while it waits — but that still means every single app launch
// pays the full ~minute-long interactive-shell cost before a widget can
// actually mint a session, since nothing was ever persisted between
// launches. Cached to disk (see PATH_CACHE_FILE below) so only the very
// first launch ever pays that cost — every launch after that has an
// immediately-usable PATH while a fresh resolution quietly re-runs in the
// background to catch up with anything that's changed since (a new nvm
// install, etc.), rather than trusting a possibly-stale value forever.
let resolvedPath: string | undefined = readCachedPath();
let resolvingPath: Promise<string> | undefined;

// Sits next to agentPool.ts's pool.json in the same per-user directory.
// Just a resolved PATH string — nothing sensitive enough to need anything
// more than best-effort read/write, same as pool.json.
const PATH_CACHE_FILE = join(SESSION_CWD, "loginShellPath.json");

function readCachedPath(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(PATH_CACHE_FILE, "utf8"));
    return typeof parsed?.path === "string" ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedPath(path: string): void {
  try {
    mkdirSync(SESSION_CWD, { recursive: true });
    writeFileSync(PATH_CACHE_FILE, JSON.stringify({ path }), "utf8");
  } catch {
    // Best-effort — a failed write just means the next launch pays the full
    // lookup again instead of a corrupted or half-written cache being read
    // back, since readCachedPath's own JSON.parse would just fail closed too.
  }
}

async function resolveLoginShellPath(): Promise<string> {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const { stdout } = await execFileAsync(shell, ["-ilc", "echo -n $PATH"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return process.env.PATH || "";
  }
}

// Call once, early, at app startup (index.ts) — unconditionally, even when a
// cached value already satisfies getLoginShellPath() immediately, so the
// cache still gets refreshed (and corrected, if it's gone stale) once per
// launch rather than being trusted forever. Only guards against running the
// (slow) resolution twice concurrently, never against running it at all.
export function warmLoginShellPath(): void {
  if (resolvingPath) return;
  resolvingPath = resolveLoginShellPath().then((path) => {
    resolvedPath = path;
    resolvingPath = undefined;
    writeCachedPath(path);
    return path;
  });
}

// Every real caller needs the resolved PATH to actually spawn something
// (`pty.spawn`, `execFile`). Returns the cached value immediately if one
// exists — even while a fresh resolution is still running in the
// background to refresh it for *next* launch — rather than making every
// caller wait on that fresh resolution just to double-check a value that's
// almost always still correct. Only actually waits when there's truly
// nothing cached yet (first launch ever, or a cache read/write failure).
export async function getLoginShellPath(): Promise<string> {
  if (resolvedPath) return resolvedPath;
  if (resolvingPath) return resolvingPath;
  warmLoginShellPath();
  return resolvingPath!;
}

// Reserves `terminalId` for the duration of the (now async, PATH-resolving)
// spawn below — without this, a second call for the same id arriving while
// the first is still awaiting the PATH would race past the `sessions.has`
// check too (nothing's in the map yet) and spawn twice.
const pendingSessions = new Set<string>();

export async function createPtySession(
  terminalId: string,
  command: string,
  args: string[],
  cwd: string,
  win: BrowserWindow,
  cols: number,
  rows: number
): Promise<void> {
  if (sessions.has(terminalId) || pendingSessions.has(terminalId)) return;
  pendingSessions.add(terminalId);

  let path: string;
  try {
    path = await getLoginShellPath();
  } finally {
    pendingSessions.delete(terminalId);
  }
  if (sessions.has(terminalId) || win.isDestroyed()) return;

  const ptyProcess = pty.spawn(command, args, {
    name: "xterm-256color",
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 30,
    cwd,
    env: {
      ...process.env,
      PATH: path,
      // Clance's terminals aren't tied to whatever project a code editor
      // happens to have open — auto-connecting to it just shows an
      // unrelated file in the status line.
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
    } as Record<string, string>,
  });

  const session: PtySession = { proc: ptyProcess, win };
  sessions.set(terminalId, session);

  ptyProcess.onData((data) => {
    if (!session.win.isDestroyed()) {
      session.win.webContents.send("terminal:data", { terminalId, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (!session.win.isDestroyed()) {
      session.win.webContents.send("terminal:exit", { terminalId, exitCode });
    }
    sessions.delete(terminalId);
  });
}

export function writeToPty(terminalId: string, data: string): void {
  sessions.get(terminalId)?.proc.write(data);
}

// Delivers a screenshot into a pty-hosted CLI session as a real image
// content block, instead of a path the model has to Read() itself: writes
// the PNG to the OS clipboard, then injects a single Ctrl+V byte (0x16)
// directly into the pty. The CLI polls the clipboard for image data on
// Ctrl+V the same way it would for a human pasting a screenshot — confirmed
// by a live spike (see docs/sep10talks.md) that only that one byte crosses
// the pty, nowhere near enough to carry inlined image bytes itself; the CLI
// reads the clipboard out-of-band. No keystroke simulation or window focus
// needed, unlike insert_text — the terminal already holds focus.
// Best-effort clipboard restore afterwards, same trade-off insertTextServer's
// clipboard paste already accepts (see frontApp.ts's typeIntoCapturedWindow).
export async function pasteImageIntoPty(terminalId: string, imagePath: string): Promise<void> {
  if (!sessions.has(terminalId)) return;
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) return;

  // Snapshot whatever's on the clipboard now (as ClipboardItems, the only
  // shape this Electron version's async clipboard API deals in) so it can
  // be put back afterwards, same best-effort restore trade-off
  // insertTextServer's clipboard paste already accepts.
  const previousItems = await clipboard.read();
  await clipboard.write([
    new ClipboardItem({
      "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }),
    }),
  ]);
  writeToPty(terminalId, "\x16");
  setTimeout(() => {
    if (previousItems.length === 0) return;
    // The bookmark MIME type resolves to a ClipboardBookmark, not a Blob —
    // dropped from the restore since it's an edge case not worth the extra
    // branching for a best-effort put-it-back.
    const restored = previousItems.map((item) => {
      const entries: [string, Promise<Blob>][] = item.types
        .filter((type) => type !== "electron application/bookmark")
        .map((type) => [type, item.getType(type) as Promise<Blob>]);
      return new ClipboardItem(Object.fromEntries(entries));
    });
    void clipboard.write(restored);
  }, 800);
}

export function resizePty(terminalId: string, cols: number, rows: number): void {
  sessions.get(terminalId)?.proc.resize(cols, rows);
}

export function killPty(terminalId: string): void {
  sessions.get(terminalId)?.proc.kill();
  sessions.delete(terminalId);
}

// Redirects an existing session's pty output/exit events to `win` instead
// of whichever window created it — the process itself (and the CLI
// conversation it holds) is untouched. Returns false if the session is
// gone (e.g. already exited) by the time the caller gets around to this.
export function reparentPty(terminalId: string, win: BrowserWindow): boolean {
  const session = sessions.get(terminalId);
  if (!session) return false;
  session.win = win;
  return true;
}
