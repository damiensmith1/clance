import { readdir, readFile, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { homedir } from "os";
import { basename, dirname, extname, join } from "path";
import { SESSION_CWD } from "./paths";

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
      if (text && text.trim()) return truncate(text, TITLE_MAX_LENGTH);
    }
  } finally {
    rl.close();
  }
  return "New conversation";
}

export async function listSessions(): Promise<SessionSummary[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];

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
        summaries.push({
          id: basename(entry, ".jsonl"),
          filePath,
          projectLabel: projectLabelFor(dirName),
          title: await firstUserTitle(filePath),
          lastModified: fileStat.mtime.toISOString(),
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

    if (title === undefined && entry.type === "user") {
      const textBlock = blocks.find((block): block is { type: "text"; text: string } => block.type === "text");
      if (textBlock) title = truncate(textBlock.text, TITLE_MAX_LENGTH);
    }

    turns.push({ role: entry.type as "user" | "assistant", blocks });
  }

  return {
    id: basename(filePath, ".jsonl"),
    projectLabel: projectLabelFor(basename(dirname(filePath))),
    title: title ?? "New conversation",
    turns,
  };
}
