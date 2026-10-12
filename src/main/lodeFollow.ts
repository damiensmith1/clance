import { readFileSync, statSync, watch, type FSWatcher } from "fs";
import { dirname, join } from "path";
import { listAgents } from "./agentSessions";
import { git } from "./git";
import { canvasRequest } from "./lode";

// A lode tab following a Claude session (its toolbar's Follow picker;
// Ask Claude's session is followed from the start). The session's hooks
// (followHooks.ts) post here, through the local tools server's /hook, and
// this hands the window what happened ("follow", Shell.js's canvas handler,
// sections/lodeCanvases.js):
//
//   edit    the files (and lines) it just wrote: the canvas shows them as
//           cards and moves to them
//   prompt  a prompt was sent: if a canvas follows the session, what the
//           window answers is added to the prompt (explain on the canvas)
//   stop    the turn ended: the canvas fits everything
//
// What it wrote comes from the session itself, not git, so it works in any
// folder: Edit and Write say the file and the text (so the line); for
// Bash (sed, scripts, generators), a watch on the session's folder during
// the turn catches the files written, reported after each command. A file
// outside the canvas's project (a worktree, another repo) comes with its
// folder: its repository's root, or the session's folder.
//
// Lode tabs know sessions by their agent id (`claude attach <id>`); hooks
// say the conversation's session id, so the two are matched through the
// agent list.

const agentIds = new Map<string, { agent: string; cwd?: string }>(); // session id → agent

async function agentFor(sessionId: string): Promise<{ agent: string; cwd?: string } | null> {
  const known = agentIds.get(sessionId);
  if (known) return known;
  const agents = await listAgents().catch(() => []);
  for (const a of agents) agentIds.set(a.sessionId, { agent: a.id, cwd: a.cwd });
  return agentIds.get(sessionId) ?? null;
}

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; new_string?: string; edits?: { new_string?: string }[] };
}

type Edit = { file: string; line: number | null; folder: string };

// A session's turn: what's been shown (a file at a modification time), and
// the watch on its folder with what it saw written.
interface Turn {
  shown: Map<string, number>;
  watcher?: FSWatcher;
  written: Set<string>;
  idle?: NodeJS.Timeout;
}
const turns = new Map<string, Turn>();
const MAX_FILES = 12; // per report
const MAX_WATCHED = 8; // files one command may write and still be shown
const TURN_IDLE_MS = 15 * 60_000; // a turn whose Stop never came

// Writes nobody reads as code: dependencies, build output, caches, git.
const IGNORED = /\/(\.git|node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|coverage|\.venv|__pycache__|tmp)\/|\/\.claude\/(?!worktrees\/)|(\.DS_Store|~|\.swp|\.tmp)$/;

// A file's folder: its repository's root (a worktree's own), else the
// session's folder if it's in it, else its directory.
const folders = new Map<string, string>();
async function folderFor(file: string, cwd: string | undefined): Promise<string> {
  const dir = dirname(file);
  const known = folders.get(dir);
  if (known) return known;
  const top = (await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => null))?.stdout.trim();
  const folder = top || (cwd && file.startsWith(`${cwd}/`) ? cwd : dir);
  folders.set(dir, folder);
  return folder;
}

function startTurn(sessionId: string, cwd: string | undefined): Turn {
  endTurn(sessionId);
  const turn: Turn = { shown: new Map(), written: new Set() };
  turns.set(sessionId, turn);
  if (cwd) {
    void folderFor(join(cwd, "_"), cwd).then((root) => {
      if (turns.get(sessionId) !== turn) return;
      try {
        turn.watcher = watch(root, { recursive: true }, (_event, name) => {
          const file = name && join(root, name.toString());
          if (file && !IGNORED.test(file)) turn.written.add(file);
        });
        turn.watcher.on("error", () => turn.watcher?.close());
      } catch {
        // Can't watch it: Edit and Write still come through.
      }
    });
  }
  turn.idle = setTimeout(() => endTurn(sessionId), TURN_IDLE_MS);
  return turn;
}

function endTurn(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turn.watcher?.close();
  clearTimeout(turn.idle);
  turns.delete(sessionId);
}

const mtimeOf = (file: string) => {
  try {
    const s = statSync(file);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
};

// An Edit's or Write's file, and where the text it wrote starts.
function toolEdits(input: HookInput): { file: string; line: number | null }[] {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) return [];
  if (input.tool_name !== "Edit" && input.tool_name !== "MultiEdit") return [{ file, line: null }];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const pieces = input.tool_name === "MultiEdit" ? (input.tool_input?.edits ?? []).map((e) => e.new_string) : [input.tool_input?.new_string];
  const lines = new Set<number | null>();
  for (const piece of pieces) {
    const at = piece ? text.indexOf(piece) : -1;
    lines.add(at < 0 ? null : text.slice(0, at).split("\n").length);
  }
  return [...lines].map((line) => ({ file, line }));
}

// What this tool call wrote that hasn't been shown at its current version.
async function editsNow(input: HookInput, turn: Turn, cwd: string | undefined): Promise<Edit[]> {
  const found = new Map<string, number | null>();
  const fresh = (file: string) => {
    const mtime = mtimeOf(file);
    if (mtime === null || turn.shown.get(file) === mtime) return false;
    turn.shown.set(file, mtime);
    return true;
  };
  for (const e of toolEdits(input)) if (found.has(e.file) || fresh(e.file)) found.set(e.file, found.get(e.file) ?? e.line);
  // What the watch saw. Many files from one command is a checkout, an
  // install or a generator (a worktree being made writes the whole
  // project), not code being worked on: passed over, not shown.
  const watched = [...turn.written].filter((file) => !found.has(file));
  turn.written.clear();
  if (watched.length > MAX_WATCHED) {
    for (const file of watched) turn.shown.set(file, mtimeOf(file) ?? 0);
    log(`${input.tool_name ?? "a command"} wrote ${watched.length} files at once: not shown`);
  } else for (const file of watched) if (fresh(file)) found.set(file, null);
  const edits = [...found].slice(0, MAX_FILES);
  return Promise.all(edits.map(async ([file, line]) => ({ file, line, folder: await folderFor(file, cwd) })));
}

const log = (message: string) => console.log(`[follow ${new Date().toISOString()}] ${message}`);

/** A session's hook: what to print back (only a prompt's context). */
export async function handleFollowHook(body: string): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(body);
  } catch {
    return "";
  }
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  if (!sessionId || (event !== "PostToolUse" && event !== "UserPromptSubmit" && event !== "Stop")) return "";
  const found = await agentFor(sessionId);
  if (!found) return void log(`${event}: no session ${sessionId} in the agent list`), "";
  // Where the session works: a canvas only follows one in its own project.
  const { agent, cwd } = found;
  const here = input.cwd ?? cwd;
  if (event === "UserPromptSubmit") {
    startTurn(sessionId, here);
    const answer = (await canvasRequest("follow", { agent, cwd, event: "prompt" }).catch(() => null)) as { context?: string } | null;
    log(`prompt from ${agent}: ${answer?.context ? "followed" : "not followed"}`);
    return answer?.context ?? "";
  }
  // A tool ran or the turn ended: what it wrote goes to the canvas (the
  // session needn't wait), then, at the end, the canvas fits.
  const turn = turns.get(sessionId) ?? startTurn(sessionId, here);
  void (async () => {
    if (event === "Stop") await new Promise((r) => setTimeout(r, 300)); // the last writes' events
    const edits = await editsNow(input, turn, here);
    if (edits.length) {
      const report = await canvasRequest("follow", { agent, cwd, event: "edit", edits }).catch((error: Error) => ({ error: error.message }));
      log(`${input.tool_name} wrote ${edits.map((e) => `${e.file}${e.line ? `:${e.line}` : ""}`).join(", ")} → ${JSON.stringify(report)}`);
    }
    if (event === "Stop") {
      endTurn(sessionId);
      await canvasRequest("follow", { agent, cwd, event: "stop" });
    }
  })().catch(() => {});
  return "";
}
