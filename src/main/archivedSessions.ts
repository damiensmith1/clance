import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

// A session "archive" is Clance-local bookkeeping only — it never touches
// the actual transcript file under ~/.claude/projects/. Those are the real
// Claude Code CLI's own storage, shared across every project on the
// machine, not just Clance's; permanently deleting one is a much bigger,
// harder-to-undo action than hiding it from Clance's own Sessions list, so
// this is deliberately the only "clean up sessions" affordance for now.
const ARCHIVED_SESSIONS_PATH = join(SESSION_CWD, "archived-sessions.json");

function readArchivedIds(): string[] {
  try {
    const raw = readFileSync(ARCHIVED_SESSIONS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeArchivedIds(ids: string[]): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(ARCHIVED_SESSIONS_PATH, JSON.stringify(ids, null, 2), "utf8");
}

export function getArchivedSessionIds(): Set<string> {
  return new Set(readArchivedIds());
}

export function setSessionArchived(sessionId: string, archived: boolean): void {
  const ids = new Set(readArchivedIds());
  if (archived) {
    ids.add(sessionId);
  } else {
    ids.delete(sessionId);
  }
  writeArchivedIds([...ids]);
}
