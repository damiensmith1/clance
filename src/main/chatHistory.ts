import { readdir, stat } from "fs/promises";
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

export type SessionSummary = {
  id: string;
  filePath: string;
  projectLabel: string;
  title: string;
  lastModified: string;
  // Clance-local bookkeeping (see archivedSessions.ts) — never reflects
  // anything about the underlying transcript file itself.
  archived: boolean;
  // Started by a program through the Agent SDK or `claude -p` rather than by
  // a person — e.g. the security-guidance plugin reviews every commit this
  // way. Hidden from the Sessions list unless its Automated filter is on.
  automated: boolean;
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

// The fixed opening line of every Clance-injected screen-context block (see
// popupWindow.ts's buildContextText, which imports this rather than
// hardcoding it, so the two can't drift apart). A brand-new session gets
// this invisibly via --append-system-prompt — never a "user" turn at all,
// so it never reaches here. A resumed/claimed-spare session gets it typed
// as *visible* unsubmitted input ahead of whatever the user adds
// themselves (see popup.js's openTerminal), so the two end up glued into
// one submitted "user" turn — without stripping this back out, every such
// session's title was this preamble instead of the user's actual request.
export const CLANCE_CONTEXT_PREFIX =
  "The user just invoked Clance via its global screen-overlay shortcut — a quick-access popup, not a full coding session.";

// The opening line of a mid-conversation "refresh context" injection (see
// popupWindow.ts's refreshContext) — always typed as *visible* input into
// the already-live session, the same way a resumed session's initial
// context is, so it can land as the start of any later "user" turn, not
// just the first. Handled by the same stripping logic as
// CLANCE_CONTEXT_PREFIX below so a refresh triggered before the user's
// first real submitted message doesn't corrupt that session's title.
export const REFRESH_CONTEXT_PREFIX =
  "The user asked Clance to refresh its view of their screen mid-conversation.";

// The CLI represents a pasted image as a literal "[Image #<n>]" placeholder
// inline in the typed input — every widget session, fresh-mint or resumed,
// now gets the screenshot pasted this way ahead of whatever text follows
// (see ptyManager.ts's pasteImageIntoPty), so this placeholder is the very
// first thing in every widget session's first turn, even a fresh-mint one
// whose context text otherwise rides in invisibly via --append-system-prompt
// and never reaches here. Stripped before stripClanceContextPrefix below,
// whose startsWith check would otherwise never match — the paste lands with
// no separator ahead of whatever's typed after it.
const LEADING_IMAGE_PLACEHOLDER = /^(?:\[Image #\d+\]\s*)+/;
function stripLeadingImagePlaceholder(text: string): string {
  return text.replace(LEADING_IMAGE_PLACEHOLDER, "");
}

const CLANCE_INJECTED_PREFIXES = [CLANCE_CONTEXT_PREFIX, REFRESH_CONTEXT_PREFIX];

// Strips a leading Clance-injected context block, if present. The
// injection always appends "\n\n" after the block before the user's own
// typed text begins (see popup.js) — that blank line is the boundary; if
// it's never found, this is left untouched rather than guessing.
function stripClanceContextPrefix(text: string): string {
  const prefix = CLANCE_INJECTED_PREFIXES.find((p) => text.startsWith(p));
  if (!prefix) return text;
  const boundary = text.indexOf("\n\n");
  return boundary === -1 ? text : text.slice(boundary + 2);
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

// The CLI stamps every entry with how the session was started: "cli" for an
// interactive session (including Clance's `--bg` agents), "sdk-py", "sdk-ts"
// or "sdk-cli" for one a program started.
function isAutomatedEntrypoint(entrypoint: unknown): boolean {
  return typeof entrypoint === "string" && entrypoint.startsWith("sdk-");
}

async function firstUserTitle(filePath: string): Promise<string> {
  return (await readSessionHead(filePath)).title;
}

async function readSessionHead(filePath: string): Promise<{ title: string; automated: boolean }> {
  let automated = false;
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
      automated ||= isAutomatedEntrypoint(entry.entrypoint);
      const message = entry.message as Record<string, unknown> | undefined;
      const text = extractText(message?.content);
      if (!text || !text.trim() || isSyntheticLocalCommandText(text)) continue;
      // A real turn — this is what makes the session non-empty for
      // hasRealUserMessage/clanceSessionIsEmpty purposes too, so that
      // determination is intentionally based on the raw text above, before
      // any stripping. The *displayed* title prefers the user's own words
      // (stripping the Clance context preamble when present); if nothing's
      // left after stripping — the user submitted just the pasted context
      // with nothing added — fall back to the raw text rather than
      // treating a real, submitted turn as if it didn't happen.
      const stripped = stripClanceContextPrefix(stripLeadingImagePlaceholder(text)).trim();
      return { title: truncate(stripped || text, TITLE_MAX_LENGTH), automated };
    }
  } finally {
    rl.close();
  }
  return { title: EMPTY_CONVERSATION_TITLE, automated };
}

// firstUserTitle's fallback when a transcript has no real (non-synthetic)
// user turn yet — named as a constant rather than repeating the literal, so
// hasRealUserMessage below can share the exact same definition of "empty"
// instead of re-scanning the file with separate logic that could disagree.
const EMPTY_CONVERSATION_TITLE = "New conversation";

// Shared by titleForSessionId and cwdForSessionId below — a session can be
// resumed from any project (the terminal actually running it is always in
// whatever cwd Clance minted/resumed it with, unrelated to where the
// *original* conversation's project directory was), so both need to check
// every project bucket for the id, the same way listSessions() does, just
// stopping at the first match instead of reading every session's title.
async function findSessionFilePath(sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const dirName of projectDirs) {
    const filePath = join(CLAUDE_PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
    try {
      await stat(filePath);
      return filePath;
    } catch {
      continue;
    }
  }
  return null;
}

// Used to label a main-window tab opened from the popup widget's "Open in
// App" button, which only has a session id (from the terminal's --resume
// args), not a title. Null if no project has that file, or it's somehow
// gone — for a brand-new session with no resumed-from id at all, the
// caller finds one first via findRecentClanceSessionId below.
export async function titleForSessionId(sessionId: string): Promise<string | null> {
  const filePath = await findSessionFilePath(sessionId);
  if (!filePath) return null;
  try {
    return await firstUserTitle(filePath);
  } catch {
    return null;
  }
}

// The working directory a session actually ran in — read straight off its
// own transcript (every real "user" entry carries a `cwd` field, confirmed
// against a live session file) rather than guessed, decoded from the
// encoded project-bucket dirname (lossy — both "/" and "." collapse to
// "-", so it's not reliably reversible), or tracked separately by Clance.
// Works for any session, Clance-created or not. Used when resuming/
// attaching an existing session, so it reopens in the directory it
// actually belongs to instead of wherever Clance's own default happens to
// be (see agentSessions.ts's resolveOpenArgs). Null if the transcript has
// no user turn yet, or none of them happen to carry a cwd (very old
// session format) — callers should fall back to a sensible default rather
// than treat this as fatal.
async function firstUserCwd(filePath: string): Promise<string | null> {
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
      const cwd = entry.cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    }
  } finally {
    rl.close();
  }
  return null;
}

export async function cwdForSessionId(sessionId: string): Promise<string | null> {
  const filePath = await findSessionFilePath(sessionId);
  if (!filePath) return null;
  try {
    return await firstUserCwd(filePath);
  } catch {
    return null;
  }
}

// Used to decide whether a just-closed popup session was ever actually used
// or was opened and abandoned with nothing typed (see popupWindow.ts's
// cleanupIfAbandoned) — content-based, not session-instance-based, so a
// real pre-existing conversation (opened via "Open in…", say) always comes
// back true even if this particular viewing added nothing new to it.
export async function hasRealUserMessage(sessionId: string): Promise<boolean> {
  const title = await titleForSessionId(sessionId);
  return title !== null && title !== EMPTY_CONVERSATION_TITLE;
}

// Finds the session id for a brand-new (never `--resume`'d) Clance popup
// session by its pty's own spawn time, for the "Open in App" case
// resolveSessionId (agentSessions.ts) can't handle — such a session has no
// id anywhere in its launch args (`--append-system-prompt ...`), so the
// only place it exists yet is the CLI's own transcript file, created
// moments after the process starts. Now that a Clance session can mint in
// any directory (see docs/design.md's "Working directory"), not just one fixed
// bucket, this has to check every project's bucket for a birthtime match,
// the same way titleForSessionId does for a known id — picks the file
// (across every bucket) whose birthtime is closest to (and no more than
// SPAWN_MATCH_TOLERANCE_MS earlier than) spawnedAt. Not airtight — two
// brand-new Clance sessions starting within the tolerance window, in any
// directories, could be mismatched — but there's no other id to key off
// before the user's first turn lands.
const SPAWN_MATCH_TOLERANCE_MS = 3000;

export async function findRecentClanceSessionId(spawnedAt: number): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }

  let best: { id: string; birthtimeMs: number } | null = null;
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
        const { title, automated } = await readSessionHead(filePath);
        // Scoped to Clance's own default-directory bucket only — a real,
        // unrelated project's session with no messages yet is none of
        // Clance's business to hide, and there's no cheap directory-based
        // signal for "is this actually Clance's" any more now that a
        // session can be minted in any directory (see
        // docs/design.md's "Working directory") — the Active-list equivalent
        // of this check uses a name check instead (see popupWindow.ts's
        // isPopupSessionName) precisely because directory-scoping stopped
        // being reliable. This is only ever a
        // backstop for the default-directory case, not the general one:
        // Clance sessions should rarely reach here empty at all
        // (popupWindow.ts's cleanupIfAbandoned rm's them on close); this
        // just covers that best-effort cleanup itself failing, for
        // whichever fraction of sessions still happen to be minted at the
        // default directory.
        if (dirName === CLANCE_PROJECT_DIR && title === EMPTY_CONVERSATION_TITLE) continue;
        summaries.push({
          id,
          filePath,
          projectLabel: projectLabelFor(dirName),
          title,
          lastModified: fileStat.mtime.toISOString(),
          archived: archivedIds.has(id),
          automated,
        });
      } catch {
        continue;
      }
    }
  }

  summaries.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  return summaries;
}

// ---- Peek (see docs/design.md, "Peeking at a session") ----
//
// A read-only pass over a session's raw JSONL for the Sessions list's Peek
// overlay: enough of the conversation to tell what a session was about
// without attaching a terminal to it. Deliberately not a transcript
// viewer — tool calls collapse to one chip each, their output to a short
// preview — so the reader sees the shape of the conversation, not a wall
// of file contents.

// Transcripts are streamed, never held whole: the largest on this machine
// is ~115 MB, almost all of it tool output, and the IPC serialisation of
// that would stall the window. Every bound below exists to keep a peek's
// payload small no matter how long the session ran. The whole file is still
// read — 451 ms for that 115 MB one, a few ms for a normal session — which
// is what lets the header count every message and the blocks kept be the
// last ones rather than the first.
const PEEK_MAX_BLOCKS = 500;
const PEEK_TEXT_LENGTH = 4000;
const PEEK_RESULT_LENGTH = 220;
const PEEK_TARGET_LENGTH = 120;

export type PeekBlock =
  | { type: "text"; text: string }
  // A slash command the user ran (/commit-message, /insights…). The CLI
  // writes the expansion of one as an ordinary user message; showing that
  // raw would drown the real conversation, so it collapses to its name.
  | { type: "command"; name: string }
  | {
      type: "tool";
      name: string;
      // The one argument worth seeing at a glance — a path for Read/Edit,
      // the command line for Bash, the pattern for Grep. "" when the tool
      // has no such argument.
      target: string;
      // Filled in from the matching tool_result entry later in the file;
      // null while a call is still unanswered (the session is mid-tool, or
      // the result was dropped by a compaction).
      result: string | null;
      failed: boolean;
    };

export type PeekTurn = {
  role: "user" | "assistant";
  // ISO timestamp of the entry that opened this turn, or null for the
  // oldest sessions, whose entries carry no timestamp.
  at: string | null;
  blocks: PeekBlock[];
};

export type SessionPeek = {
  id: string;
  title: string;
  projectLabel: string;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  startedAt: string | null;
  lastMessageAt: string | null;
  // Real messages — what a person typed and what Claude replied — not
  // tool-result round trips, so it reads the way the conversation felt.
  messageCount: number;
  turns: PeekTurn[];
  // True when PEEK_MAX_BLOCKS dropped earlier blocks: `turns` then holds the
  // end of the conversation, and the overlay says so above them.
  truncated: boolean;
};

// Home-relative, and relative to the session's own cwd when it's under it
// — a peek is read at a glance, and the repeated project prefix on every
// path is the least informative part of it.
function shortPath(value: string, cwd: string | null): string {
  if (cwd && value.startsWith(`${cwd}/`)) return value.slice(cwd.length + 1);
  return value.replace(/^\/Users\/[^/]+/, "~");
}

// The single argument that identifies what a tool call actually did. Keyed
// off the argument names the built-in tools use rather than the tool name,
// so an MCP or plugin tool with a `path`/`query`/`command` input gets a
// useful chip too instead of falling back to a bare name.
function toolTarget(input: Record<string, unknown> | undefined, cwd: string | null): string {
  if (!input) return "";
  const pathLike = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof pathLike === "string") return shortPath(pathLike, cwd);
  if (typeof input.pattern === "string") return input.pattern;
  const plain =
    input.command ?? input.query ?? input.url ?? input.prompt ?? input.description ?? input.skill;
  if (typeof plain === "string") return truncate(plain.replace(/\s+/g, " "), PEEK_TARGET_LENGTH);
  return "";
}

// tool_result content is either a string or a content-block array; both
// shapes collapse to one short line here, with the newlines flattened so a
// multi-line result can't stretch the chip down the page.
function toolResultPreview(content: unknown): string {
  const text = extractText(content);
  if (!text || !text.trim()) return "(no output)";
  return truncate(text.replace(/\s+/g, " "), PEEK_RESULT_LENGTH);
}

// The CLI writes a slash command as a user message wrapping the name in
// <command-name>, usually preceded by <command-message>; `/insights` also
// lands as a separate <local-command-stdout> entry. Returns the command's
// name when this is one, so the caller can show a chip instead of the
// expansion.
const COMMAND_NAME_RE = /<command-name>\s*\/?([\w:-]+)\s*<\/command-name>/;
function slashCommandName(text: string): string | null {
  return text.match(COMMAND_NAME_RE)?.[1] ?? null;
}

// How many unanswered tool calls to keep waiting for a result. A result
// lands in the entry right after its call, so this only has to outlive one
// exchange; without a bound, a session with thousands of tool calls would
// hold every chip it ever made long after they were dropped from `turns`.
const PEEK_MAX_PENDING = 200;

type PeekState = {
  turns: PeekTurn[];
  // tool_use id → the chip awaiting its result. Results arrive in a later
  // entry (the next "user" line), so the chip is filled in after the fact
  // rather than emitted as a block of its own.
  pending: Map<string, PeekBlock & { type: "tool" }>;
  blockCount: number;
  messageCount: number;
  truncated: boolean;
};

// Appends `blocks` to the trailing turn when it has the same role, so a
// tool-use loop stays one continuous assistant turn instead of a run of
// one-line turns alternating with the tool results feeding it.
//
// Over the cap, the oldest blocks go rather than the newest: a peek is read
// to see where a session got to, and the overlay opens scrolled to the end.
// Trimming as we go is also what keeps a 115 MB transcript's peek bounded in
// memory, not just over IPC.
function pushBlocks(state: PeekState, role: "user" | "assistant", at: string | null, blocks: PeekBlock[]) {
  if (blocks.length === 0) return;
  const last = state.turns[state.turns.length - 1];
  if (last && last.role === role) last.blocks.push(...blocks);
  else state.turns.push({ role, at, blocks });
  state.blockCount += blocks.length;

  while (state.blockCount > PEEK_MAX_BLOCKS && state.turns.length > 0) {
    const oldest = state.turns[0];
    oldest.blocks.shift();
    state.blockCount -= 1;
    state.truncated = true;
    if (oldest.blocks.length === 0) state.turns.shift();
  }
}

function peekBlocks(
  content: unknown,
  cwd: string | null,
  state: PeekState
): { blocks: PeekBlock[]; isRealMessage: boolean } {
  const raw = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(raw)) return { blocks: [], isRealMessage: false };

  const blocks: PeekBlock[] = [];
  let isRealMessage = false;

  // "thinking" blocks are skipped rather than shown: the CLI records the
  // block but writes its text empty (every one of them, across every
  // transcript on disk), so there is nothing in a log to render.
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string") {
      const text = stripClanceContextPrefix(stripLeadingImagePlaceholder(block.text)).trim();
      if (!text) continue;
      const command = slashCommandName(text);
      if (command) {
        blocks.push({ type: "command", name: command });
        isRealMessage = true;
        continue;
      }
      // Everything else the CLI injects on the user's behalf — the caveat
      // banner, a local command's stdout — is machinery, not conversation.
      if (isSyntheticLocalCommandText(text)) continue;
      blocks.push({ type: "text", text: truncate(text, PEEK_TEXT_LENGTH) });
      isRealMessage = true;
    } else if (block.type === "tool_use") {
      const chip: PeekBlock & { type: "tool" } = {
        type: "tool",
        name: typeof block.name === "string" ? block.name : "tool",
        target: toolTarget(block.input as Record<string, unknown> | undefined, cwd),
        result: null,
        failed: false,
      };
      if (typeof block.id === "string") {
        state.pending.set(block.id, chip);
        // Map iterates in insertion order, so this drops the call that has
        // gone longest without an answer.
        while (state.pending.size > PEEK_MAX_PENDING) {
          state.pending.delete(state.pending.keys().next().value as string);
        }
      }
      blocks.push(chip);
    } else if (block.type === "tool_result") {
      // Not a block of its own: it lands on the chip for the call it
      // answers, which is already in an earlier turn.
      const chip = typeof block.tool_use_id === "string" ? state.pending.get(block.tool_use_id) : undefined;
      if (chip) {
        chip.result = toolResultPreview(block.content);
        chip.failed = block.is_error === true;
        state.pending.delete(block.tool_use_id as string);
      }
    }
  }

  return { blocks, isRealMessage };
}

// Reads a session's transcript for the Peek overlay. `sessionId`, not a
// path, because a live row only knows its session id — the file is found
// the same way every other id-keyed lookup here finds it. Null when no
// project bucket holds that id.
export async function peekSession(sessionId: string): Promise<SessionPeek | null> {
  const filePath = await findSessionFilePath(sessionId);
  if (!filePath) return null;

  const state: PeekState = {
    turns: [],
    pending: new Map(),
    blockCount: 0,
    messageCount: 0,
    truncated: false,
  };
  let title: string | undefined;
  let aiTitle: string | undefined;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let model: string | null = null;
  let startedAt: string | null = null;
  let lastMessageAt: string | null = null;

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

      // The CLI's own one-line summary of the session, rewritten as the
      // conversation goes on — a better header than the first message's
      // opening words, so the last one wins.
      if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
        aiTitle = entry.aiTitle;
        continue;
      }
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      // A subagent's own conversation, threaded into the same file. It
      // belongs to the Task chip that spawned it, not between the user's
      // turns, so it stays out of the peek entirely.
      if (entry.isSidechain) continue;
      // Context the CLI injected as if the user had typed it: a skill's
      // body, a /context report. Not something a person said.
      if (entry.isMeta) continue;

      if (typeof entry.cwd === "string" && !cwd) cwd = entry.cwd;
      // "HEAD" is what the CLI records for a detached checkout — a branch
      // name it isn't, and nothing a reader can act on, so it's left off.
      if (typeof entry.gitBranch === "string" && entry.gitBranch && entry.gitBranch !== "HEAD") {
        gitBranch = entry.gitBranch;
      }
      const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;

      const message = entry.message as Record<string, unknown> | undefined;
      if (entry.type === "assistant" && typeof message?.model === "string") model = message.model;

      const { blocks, isRealMessage } = peekBlocks(message?.content, cwd, state);
      if (blocks.length === 0) continue;

      // A "user" entry carrying no real text is the CLI feeding tool
      // results back to the model — part of Claude's turn, not a new one
      // from the person.
      const role: "user" | "assistant" = entry.type === "assistant" || !isRealMessage ? "assistant" : "user";

      if (title === undefined && role === "user") {
        const first = blocks.find((block) => block.type === "text");
        if (first && first.type === "text") title = truncate(first.text, TITLE_MAX_LENGTH);
      }
      // What the header counts as a "message": something one of them
      // actually said. An assistant entry that is only a tool call is part
      // of answering the message before it, not another one.
      if (blocks.some((block) => block.type === "text" || block.type === "command")) {
        state.messageCount += 1;
        if (timestamp) {
          startedAt ??= timestamp;
          lastMessageAt = timestamp;
        }
      }

      pushBlocks(state, role, timestamp, blocks);
    }
  } catch {
    // A transcript being written to as it's read can end mid-line; keep
    // whatever was parsed rather than failing the whole peek.
  } finally {
    rl.close();
  }

  return {
    id: sessionId,
    title: aiTitle || title || EMPTY_CONVERSATION_TITLE,
    projectLabel: projectLabelFor(basename(dirname(filePath))),
    cwd,
    gitBranch,
    model,
    startedAt,
    lastMessageAt,
    messageCount: state.messageCount,
    turns: state.turns,
    truncated: state.truncated,
  };
}
