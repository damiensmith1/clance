import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";

// Fixed pseudo-project directory Clance runs the SDK against, so all of its
// sessions land under one stable `~/.claude/projects/<encoded-this-path>/`
// bucket regardless of what app was frontmost when invoked.
export const SESSION_CWD = join(homedir(), ".clance");

const LAST_SESSION_FILE = join(SESSION_CWD, "last-session-id");

export function ensureSessionCwd(): void {
  mkdirSync(SESSION_CWD, { recursive: true });
}

export function readLastSessionId(): string | undefined {
  try {
    return readFileSync(LAST_SESSION_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function writeLastSessionId(sessionId: string): void {
  writeFileSync(LAST_SESSION_FILE, sessionId, "utf8");
}
