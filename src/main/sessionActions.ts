import { shell } from "electron";
import { mkdirSync, statSync, writeFileSync, chmodSync } from "fs";
import { isAbsolute, join } from "path";
import { cwdForSessionId } from "./chatHistory";
import { SESSION_CWD } from "./paths";

// The Sessions tab's right-click actions that need the file system or other
// apps. Every argument arrives from the renderer, so ids are checked against
// the CLI's own id shape and paths must be existing absolute directories
// before anything is opened or written.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function isDirectory(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The working directory a transcript was recorded in, or null. */
export async function sessionFolder(sessionId: unknown): Promise<string | null> {
  if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) return null;
  const cwd = await cwdForSessionId(sessionId);
  return isDirectory(cwd) ? cwd : null;
}

/** Opens a session's folder in Finder. */
export async function revealFolder(dir: unknown): Promise<boolean> {
  if (!isDirectory(dir)) return false;
  return (await shell.openPath(dir)) === "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Continues a session in Terminal.app: `claude attach <agentId>` for a live
 * background agent, otherwise `claude --resume <sessionId>`, in the session's
 * own folder.
 *
 * Done by opening a generated `.command` file rather than scripting Terminal
 * with AppleScript, which would need the Automation permission. The command
 * runs through the user's login shell so `claude` is on PATH the same way it
 * is in their own terminal.
 */
export async function resumeInTerminal(target: {
  sessionId?: unknown;
  agentId?: unknown;
  cwd?: unknown;
}): Promise<boolean> {
  const agentId = typeof target.agentId === "string" && ID_PATTERN.test(target.agentId) ? target.agentId : null;
  const sessionId = typeof target.sessionId === "string" && ID_PATTERN.test(target.sessionId) ? target.sessionId : null;
  if (!agentId && !sessionId) return false;

  const cwd = isDirectory(target.cwd) ? target.cwd : sessionId ? await sessionFolder(sessionId) : null;
  const claudeCommand = agentId ? `claude attach ${agentId}` : `claude --resume ${sessionId}`;
  const script = [
    "#!/bin/sh",
    cwd ? `cd ${shellQuote(cwd)} || exit 1` : "",
    `exec "\${SHELL:-/bin/zsh}" -ilc ${shellQuote(claudeCommand)}`,
    "",
  ]
    .filter((line, index, all) => line !== "" || index === all.length - 1)
    .join("\n");

  const dir = join(SESSION_CWD, "terminal");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `resume-${agentId ?? sessionId}.command`);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return (await shell.openPath(file)) === "";
}
