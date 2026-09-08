import * as pty from "node-pty";
import { BrowserWindow } from "electron";
import { execFileSync } from "child_process";

const sessions = new Map<string, pty.IPty>();

// GUI-launched apps (vs. a terminal-launched dev build) inherit launchd's
// minimal PATH, missing directories a login shell would add (e.g. nvm,
// ~/.local/bin — where `claude` itself often lives). Resolve it once via a
// literal, non-interpolated login-shell invocation, never from user input,
// so we can spawn the target binary directly instead of through a shell
// string (which would otherwise be a command-injection vector via `args`).
let resolvedPath: string | undefined;
function getLoginShellPath(): string {
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
  win: BrowserWindow
): void {
  if (sessions.has(terminalId)) return;

  const ptyProcess = pty.spawn(command, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 30,
    cwd,
    env: { ...process.env, PATH: getLoginShellPath() } as Record<string, string>,
  });

  ptyProcess.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send("terminal:data", { terminalId, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (!win.isDestroyed()) {
      win.webContents.send("terminal:exit", { terminalId, exitCode });
    }
    sessions.delete(terminalId);
  });

  sessions.set(terminalId, ptyProcess);
}

export function writeToPty(terminalId: string, data: string): void {
  sessions.get(terminalId)?.write(data);
}

export function resizePty(terminalId: string, cols: number, rows: number): void {
  sessions.get(terminalId)?.resize(cols, rows);
}

export function killPty(terminalId: string): void {
  sessions.get(terminalId)?.kill();
  sessions.delete(terminalId);
}
