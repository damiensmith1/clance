import * as pty from "node-pty";
import { BrowserWindow, clipboard, nativeImage, ClipboardItem } from "electron";
import { execFile, execFileSync } from "child_process";

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
let resolvedPath: string | undefined;
export function getLoginShellPath(): string {
  if (resolvedPath) return resolvedPath;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    resolvedPath = execFileSync(shell, ["-ilc", "echo -n $PATH"], {
      encoding: "utf8",
    }).trim();
  } catch {
    resolvedPath = process.env.PATH || "";
  }
  return resolvedPath;
}

// Fire-and-forget: resolves the same PATH as getLoginShellPath(), but via
// the non-blocking execFile rather than execFileSync — call this once,
// early, at app startup so the (potentially slow — an interactive login
// shell can take a while to source .zshrc/.zprofile/nvm/etc.) shell spin-up
// has already happened by the time anything actually needs the PATH, e.g.
// the popup widget's hotkey-triggered `claude --bg` spawn. Harmless no-op
// if getLoginShellPath() already resolved it (synchronously, on demand)
// first — this only ever fills the same cache, never races it unsafely,
// since the last write wins and both branches compute the same value.
export function warmLoginShellPath(): void {
  if (resolvedPath) return;
  const shell = process.env.SHELL || "/bin/zsh";
  execFile(shell, ["-ilc", "echo -n $PATH"], { encoding: "utf8" }, (err, stdout) => {
    if (!err && stdout) resolvedPath = stdout.trim();
  });
}

export function createPtySession(
  terminalId: string,
  command: string,
  args: string[],
  cwd: string,
  win: BrowserWindow,
  cols: number,
  rows: number
): void {
  if (sessions.has(terminalId)) return;

  const ptyProcess = pty.spawn(command, args, {
    name: "xterm-256color",
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 30,
    cwd,
    env: {
      ...process.env,
      PATH: getLoginShellPath(),
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
