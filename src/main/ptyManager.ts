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
  win: BrowserWindow,
  cols: number,
  rows: number
): void {
  if (sessions.has(terminalId)) return;

  // Clance's embedded terminal always renders on a light background
  // (see popup.js / TerminalSection.js xterm themes). Left unset, the CLI
  // defaults to dark-theme-tuned colors and emits several UI colors (diff
  // add/remove, etc.) as hardcoded truecolor RGB rather than the basic
  // ANSI palette — those can't be fixed by remapping xterm's theme, so the
  // CLI itself has to be told the background is light.
  const ptyArgs = command === "claude" ? [...args, "--settings", '{"theme":"light"}'] : args;

  const ptyProcess = pty.spawn(command, ptyArgs, {
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
