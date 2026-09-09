import { readdir, readFile, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { homedir } from "os";
import { basename, dirname, extname, join } from "path";
import { SESSION_CWD } from "./paths";
import { getArchivedSessionIds } from "./archivedSessions";

// Where the Claude Code CLI (and Clance itself, via the Agent SDK) stores
// every session's JSONL transcript, one subdirectory per project cwd.
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Clance always runs the SDK against SESSION_CWD, so its own sessions land
// in one stable, encoded bucket alongside every real project's bucket.
const CLANCE_PROJECT_DIR = SESSION_CWD.replace(/[/.]/g, "-");

const TITLE_MAX_LENGTH = 70;
const RESULT_PREVIEW_LENGTH = 200;

export type SessionSummary = {
  id: string;
  filePath: string;
  projectLabel: string;
  title: string;
  lastModified: string;
  // Clance-local bookkeeping (see archivedSessions.ts) — never reflects
  // anything about the underlying transcript file itself.
  archived: boolean;
};

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool"; label: string }
  | { type: "thinking" };

export type ChatTurn = {
  role: "user" | "assistant";
  blocks: ChatBlock[];
};

export type SessionDetail = {
  id: string;
  projectLabel: string;
  title: string;
  turns: ChatTurn[];
};

function projectLabelFor(dirName: string): string {
  if (dirName === CLANCE_PROJECT_DIR) return "Clance";
  const segments = dirName.replace(/-/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] || dirName;
}

// The CLI injects these as synthetic "user" messages when a local slash
// command runs (e.g. /clear, /model) — not something the human actually
// typed, so they should never surface as a session title or a "YOU" turn.
function isSyntheticLocalCommandText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("<local-command-stdout>") ||
    trimmed.startsWith("<command-name>")
  );
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

// `content` is either a plain string (older sessions) or an array of
// Anthropic Messages API content blocks — this pulls the first text block
// out of either shape.
function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return undefined;
}

async function firstUserTitle(filePath: string): Promise<string> {
  const rl = createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "user") continue;
      const message = entry.message as Record<string, unknown> | undefined;
      const text = extractText(message?.content);
      if (text && text.trim() && !isSyntheticLocalCommandText(text)) {
        return truncate(text, TITLE_MAX_LENGTH);
      }
    }
  } finally {
    rl.close();
  }
  return "New conversation";
}

// Used to label a main-window tab opened from the popup widget's "Open in
// App" button, which only has a session id (from the terminal's --resume
// args), not a title. The session can be resumed from any project — the
// terminal running it is always in SESSION_CWD, but that's unrelated to
// where the *original* conversation's project directory was — so this has
// to check each project bucket for the id the same way listSessions()
// does, just stopping at the first match instead of reading every
// session's title. Null if no project has that file, or it's somehow gone —
// for a brand-new session with no resumed-from id at all, the caller finds
// one first via findRecentClanceSessionId below.
export async function titleForSessionId(sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const dirName of projectDirs) {
    const filePath = join(CLAUDE_PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
    try {
      return await firstUserTitle(filePath);
    } catch {
      continue;
    }
  }
  return null;
}

// Finds the session id for a brand-new (never `--resume`'d) Clance popup
// session by its pty's own spawn time, for the "Open in App" case
// resolveSessionId (agentSessions.ts) can't handle — such a session has no
// id anywhere in its launch args (`--append-system-prompt ...`), so the
// only place it exists yet is the CLI's own transcript file, created
// moments after the process starts. All Clance sessions land in this one
// bucket (CLANCE_PROJECT_DIR), unlike titleForSessionId which has to check
// every project's bucket for a known id. Picks the file whose birthtime is
// closest to (and no more than SPAWN_MATCH_TOLERANCE_MS earlier than)
// spawnedAt. Not airtight — two brand-new Clance sessions starting within
// the tolerance window could be mismatched — but there's no other id to
// key off before the user's first turn lands.
const SPAWN_MATCH_TOLERANCE_MS = 3000;

export async function findRecentClanceSessionId(spawnedAt: number): Promise<string | null> {
  const projectPath = join(CLAUDE_PROJECTS_DIR, CLANCE_PROJECT_DIR);
  let entries: string[];
  try {
    entries = await readdir(projectPath);
  } catch {
    return null;
  }

  let best: { id: string; birthtimeMs: number } | null = null;
  for (const entry of entries) {
    if (extname(entry) !== ".jsonl") continue;
    try {
      const fileStat = await stat(join(projectPath, entry));
      if (fileStat.birthtimeMs < spawnedAt - SPAWN_MATCH_TOLERANCE_MS) continue;
      if (!best || fileStat.birthtimeMs < best.birthtimeMs) {
        best = { id: basename(entry, ".jsonl"), birthtimeMs: fileStat.birthtimeMs };
      }
    } catch {
      continue;
    }
  }
  return best?.id ?? null;
}

export async function listSessions(): Promise<SessionSummary[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  const archivedIds = getArchivedSessionIds();

  for (const dirName of projectDirs) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, dirName);
    let entries: string[];
    try {
      entries = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (extname(entry) !== ".jsonl") continue;
      const filePath = join(projectPath, entry);
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) continue;
        const id = basename(entry, ".jsonl");
        summaries.push({
          id,
          filePath,
          projectLabel: projectLabelFor(dirName),
          title: await firstUserTitle(filePath),
          lastModified: fileStat.mtime.toISOString(),
          archived: archivedIds.has(id),
        });
      } catch {
        continue;
      }
    }
  }

  summaries.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  return summaries;
}

function toolUseLabel(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const input = block.input as Record<string, unknown> | undefined;
  const arg =
    input &&
    (input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query);
  return arg ? `${name}: ${truncate(String(arg), 80)}` : name;
}

function toolResultLabel(block: Record<string, unknown>): string {
  const text = extractText(block.content);
  const preview = text ? truncate(text, RESULT_PREVIEW_LENGTH) : "(result)";
  return `Result: ${preview}`;
}

function normalizeBlocks(content: unknown): ChatBlock[] {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: ChatBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({ type: "tool", label: toolUseLabel(block) });
    } else if (block.type === "tool_result") {
      blocks.push({ type: "tool", label: toolResultLabel(block) });
    } else if (block.type === "thinking") {
      blocks.push({ type: "thinking" });
    }
  }
  return blocks;
}

export async function getSession(filePath: string): Promise<SessionDetail | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const turns: ChatTurn[] = [];
  let title: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;

    const message = entry.message as Record<string, unknown> | undefined;
    const blocks = normalizeBlocks(message?.content);
    if (blocks.length === 0) continue;

    const isRealUserMessage =
      entry.type === "user" &&
      blocks.some((block) => block.type === "text" && !isSyntheticLocalCommandText(block.text));

    if (title === undefined && isRealUserMessage) {
      const textBlock = blocks.find(
        (block): block is { type: "text"; text: string } =>
          block.type === "text" && !isSyntheticLocalCommandText(block.text)
      );
      if (textBlock) title = truncate(textBlock.text, TITLE_MAX_LENGTH);
    }

    // A "user" entry with no real text is just the SDK feeding a tool
    // result back to the model — not something the human typed. Folding it
    // into the ongoing assistant turn (instead of giving it its own "YOU"
    // turn) keeps a whole tool-use loop as one continuous exchange, rather
    // than a wall of alternating one-line turns.
    const role: "user" | "assistant" = isRealUserMessage ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.blocks.push(...blocks);
    } else {
      turns.push({ role, blocks });
    }
  }

  return {
    id: basename(filePath, ".jsonl"),
    projectLabel: projectLabelFor(basename(dirname(filePath))),
    title: title ?? "New conversation",
    turns,
  };
}
