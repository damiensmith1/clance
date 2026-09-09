import * as pty from "node-pty";
import { BrowserWindow } from "electron";
import { execFileSync } from "child_process";

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
