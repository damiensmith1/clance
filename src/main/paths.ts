import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

// Fixed pseudo-project directory Clance runs the CLI against, so all of its
// sessions land under one stable `~/.claude/projects/<encoded-this-path>/`
// bucket regardless of what app was frontmost when invoked.
export const SESSION_CWD = join(homedir(), ".clance");

export function ensureSessionCwd(): void {
  mkdirSync(SESSION_CWD, { recursive: true });
}
