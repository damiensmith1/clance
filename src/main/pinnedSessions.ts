import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

// Pinning is Clance-local bookkeeping, exactly like archiving (see
// archivedSessions.ts): a list of session ids Clance keeps at the top of
// its own Sessions list, never anything written to the transcripts under
// ~/.claude/projects/, which belong to the CLI and are shared with every
// other project on the machine.
const PINNED_SESSIONS_PATH = join(SESSION_CWD, "pinned-sessions.json");

function readPinnedIds(): string[] {
  try {
    const raw = readFileSync(PINNED_SESSIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writePinnedIds(ids: string[]): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(PINNED_SESSIONS_PATH, JSON.stringify(ids, null, 2), "utf8");
}

export function getPinnedSessionIds(): Set<string> {
  return new Set(readPinnedIds());
}

export function setSessionPinned(sessionId: string, pinned: boolean): void {
  const ids = new Set(readPinnedIds());
  if (pinned) {
    ids.add(sessionId);
  } else {
    ids.delete(sessionId);
  }
  writePinnedIds([...ids]);
}
