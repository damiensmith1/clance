import { realpathSync } from "fs";
import { open, stat } from "fs/promises";
import { dirname, sep } from "path";
import type { WebContents } from "electron";
import { listAgents, type AgentSession } from "./agentSessions";
import { findSessionFilePath, listSessions, titleForSessionId } from "./chatHistory";
import { getDefaultDirectory, readConfig } from "./config";
import {
  baseBranch,
  findRepoRoot,
  git,
  inProgressOperation,
  isDirectory,
  listBranchStates,
  listWorktrees,
  mergeBase,
  rangeFiles,
  watchRepo,
  type BranchState,
  type DiffRange,
} from "./git";

// The Work tab's model: every repository the user works in, every checkout
// of each (its own folder and its linked worktrees), every local branch, and
// every running Claude session — joined up, so the renderer can show "what is
// changing, where, and who's doing it" without asking git a question per row.
// See docs/design.md's "Work".
//
// Nothing here listens inside a session. What changed comes from git, by
// looking at the files on disk, which holds however the files were edited.
// Who changed it comes from where a session runs and, for a session that
// edits files outside its own folder, from its transcript, which the CLI
// already writes and Clance only reads.

/** How long a repository's state is trusted without its watcher saying anything. */
const REPO_STALE_MS = 60_000;
/** How long the repositories found through session history are reused. */
const DISCOVERY_STALE_MS = 60_000;
/** Sessions this recent count towards which repositories to show. */
const RECENT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A branch committed to this recently is current work; older ones are kept
 * to the Repos view (and aren't diffed until asked), or a repository with
 * years of branches would bury what's happening now.
 */
const RECENT_BRANCH_MS = 14 * 24 * 60 * 60 * 1000;
/** How long after a session runs `git commit` a commit can still be its. */
const COMMIT_WINDOW_MS = 10 * 60 * 1000;
/** Read from a transcript per pass; a long one is caught up over several. */
const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;
/** What a session's last message is cut to. */
const REPORT_MAX_CHARS = 600;

export type WorkSessionState = "working" | "needs" | "failed" | "done" | "idle";

export type WorkSession = {
  sessionId: string;
  agentId: string;
  title: string;
  state: WorkSessionState;
  cwd: string | null;
  startedAt: number | null;
  /** The checkouts it runs in or has edited files in. */
  checkouts: string[];
  /** Its most recent message, in its own words. */
  lastReport: string | null;
};

export type CheckoutState = {
  path: string;
  branch: string | null;
  /** Short sha. */
  head: string | null;
  /** The repository's own folder, as opposed to a linked worktree. */
  main: boolean;
  /** HEAD → working tree, untracked files included. */
  uncommitted: Totals;
  /** A merge or rebase stopped halfway. */
  operation: string | null;
};

export type Totals = { files: number; insertions: number; deletions: number };

export type RepoState = {
  root: string;
  name: string;
  base: string | null;
  checkouts: CheckoutState[];
  branches: BranchState[];
};

export type WorkGroup = "needs" | "review" | "working" | "open" | "branches" | "shipped" | "quiet";

export type WorkItem = {
  /** `co:<path>`, `br:<root>:<branch>` or `s:<sessionId>`. */
  id: string;
  kind: "checkout" | "branch" | "conversation";
  group: WorkGroup;
  root: string | null;
  repo: string | null;
  base: string | null;
  branch: string | null;
  /** The folder it's checked out in; null for a branch checked out nowhere. */
  checkout: string | null;
  main: boolean;
  sessionIds: string[];
  /** Everything this work changed: the range and what's in it (null: not counted, an old branch). */
  range: DiffRange | null;
  total: Totals | null;
  /** Where the commits worth listing start (exclusive) and end. */
  commits: { from: string | null; to: string } | null;
  uncommitted: Totals | null;
  operation: string | null;
  branchState: BranchState | null;
};

export type WorkSnapshot = { repos: RepoState[]; sessions: WorkSession[]; items: WorkItem[] };

const EMPTY: Totals = { files: 0, insertions: 0, deletions: 0 };

function totals(files: { insertions: number; deletions: number }[] | null): Totals {
  if (!files) return EMPTY;
  return files.reduce<Totals>(
    (sum, file) => ({ files: sum.files + 1, insertions: sum.insertions + file.insertions, deletions: sum.deletions + file.deletions }),
    EMPTY
  );
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

// ---- reading transcripts -------------------------------------------------------
//
// A session's transcript is read from where the last read stopped, so a
// running session costs only what it has written since. What's kept is what
// the Work tab needs from it: the files it edited (by its edit tools — an
// edit made through a shell command doesn't appear, which is why git, not
// this, is the record of what changed), the commits it reported making, where
// it ran, and its last message.

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const GIT_COMMIT = /\bgit\b[^\n|;&]*\bcommit\b/;
const COMMIT_LINE = /^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/gm;

export type SessionCommit = { sha: string; branch: string; subject: string };

type TranscriptMemory = {
  path: string;
  offset: number;
  /** A line cut off at the end of the last read. */
  carry: string;
  edits: Set<string>;
  commits: SessionCommit[];
  /** When it ran a `git commit`, and where — matched against the repository's log later. */
  commitCalls: { at: number; cwd: string | null }[];
  cwd: string | null;
  lastReport: string | null;
};

const transcripts = new Map<string, TranscriptMemory>();

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .join("\n");
}

function takeLine(memory: TranscriptMemory, line: string): void {
  // Most lines are neither an edit, a command's output nor a message worth
  // keeping; skipping the parse for them is most of the cost.
  if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('"type":"assistant"') && !memory.cwd) return;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!memory.cwd && typeof entry.cwd === "string" && entry.cwd) memory.cwd = entry.cwd;
  const message = entry.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? (message!.content as Record<string, unknown>[]) : [];

  if (entry.type === "assistant") {
    let text = "";
    for (const block of content) {
      if (block?.type === "tool_use" && EDIT_TOOLS.has(String(block.name))) {
        const input = (block.input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
        const file = input.file_path ?? input.notebook_path;
        if (typeof file === "string" && file.startsWith("/")) memory.edits.add(file);
      } else if (block?.type === "tool_use" && block.name === "Bash") {
        const command = (block.input as { command?: unknown } | undefined)?.command;
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (typeof command === "string" && GIT_COMMIT.test(command) && !Number.isNaN(at)) {
          memory.commitCalls.push({ at, cwd: typeof entry.cwd === "string" ? entry.cwd : null });
        }
      } else if (block?.type === "text" && typeof block.text === "string" && !entry.isSidechain) {
        text += block.text;
      }
    }
    if (text.trim()) memory.lastReport = text.trim().slice(0, REPORT_MAX_CHARS);
    return;
  }

  if (entry.type === "user") {
    const outputs: string[] = [];
    for (const block of content) if (block?.type === "tool_result") outputs.push(textOf(block.content));
    const result = entry.toolUseResult as { stdout?: unknown } | undefined;
    if (typeof result?.stdout === "string") outputs.push(result.stdout);
    for (const output of outputs) {
      for (const match of output.matchAll(COMMIT_LINE)) {
        const [, branch, sha, subject] = match;
        if (!memory.commits.some((c) => sha.startsWith(c.sha) || c.sha.startsWith(sha))) {
          memory.commits.push({ sha, branch, subject });
        }
      }
    }
  }
}

/** Catches up on a session's transcript and returns what's known of it, or null when it has none. */
export async function readTranscript(sessionId: string): Promise<TranscriptMemory | null> {
  const path = await findSessionFilePath(sessionId);
  if (!path) return null;
  let memory = transcripts.get(sessionId);
  if (!memory || memory.path !== path) {
    memory = { path, offset: 0, carry: "", edits: new Set(), commits: [], commitCalls: [], cwd: null, lastReport: null };
    transcripts.set(sessionId, memory);
  }
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return memory;
  }
  // Shorter than where the last read stopped: rewritten, so start again.
  if (size < memory.offset) {
    Object.assign(memory, { offset: 0, carry: "", edits: new Set(), commits: [], commitCalls: [], cwd: null, lastReport: null });
  }
  if (size === memory.offset) return memory;
  const handle = await open(path, "r");
  try {
    while (memory.offset < size) {
      const length = Math.min(TRANSCRIPT_CHUNK_BYTES, size - memory.offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, memory.offset);
      if (bytesRead === 0) break;
      memory.offset += bytesRead;
      const lines = (memory.carry + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      memory.carry = lines.pop() ?? "";
      for (const line of lines) if (line) takeLine(memory, line);
    }
  } finally {
    await handle.close();
  }
  return memory;
}

// ---- repositories -----------------------------------------------------------

type RangeMemory = { range: DiffRange | null; total: Totals | null; commits: WorkItem["commits"] };
type RepoMemory = { state: RepoState; ranges: Map<string, RangeMemory>; dirty: boolean; at: number };

const repoMemory = new Map<string, RepoMemory>();
const repoBuilds = new Map<string, Promise<RepoMemory | null>>();
/** When each repository's watcher last fired, so a change during a rebuild isn't lost. */
const changedAt = new Map<string, number>();

async function buildRepo(root: string): Promise<RepoMemory | null> {
  const trees = await listWorktrees(root);
  if (trees.length === 0) return null;
  const home = trees.find((tree) => tree.main)?.path ?? root;
  const base = await baseBranch(home);
  const [branches, checkouts] = await Promise.all([
    listBranchStates(home, base),
    Promise.all(
      trees.map(async (tree): Promise<CheckoutState> => {
        const uncommitted = tree.head ? await rangeFiles(tree.path, { from: "HEAD", to: null }) : null;
        return {
          path: tree.path,
          branch: tree.branch,
          head: tree.head ? tree.head.slice(0, 7) : null,
          main: tree.main,
          uncommitted: totals(uncommitted),
          operation: inProgressOperation(tree.path),
        };
      })
    ),
  ]);

  // The range each checkout and branch is judged by, and its totals. Read
  // here, once per change to the repository, rather than per look.
  const ranges = new Map<string, RangeMemory>();
  const byName = new Map(branches.map((branch) => [branch.name, branch]));
  await Promise.all([
    ...checkouts.map(async (checkout) => {
      if (!checkout.head) return;
      const branch = checkout.branch ? byName.get(checkout.branch) : undefined;
      let from: string | null = null;
      if (branch && !branch.isBase && base) from = await mergeBase(checkout.path, `refs/heads/${base}`, "HEAD");
      else if (branch?.upstream && !branch.upstreamGone) from = await mergeBase(checkout.path, branch.upstream, "HEAD");
      const range: DiffRange = { from: from ?? "HEAD", to: null };
      const files = from ? await rangeFiles(checkout.path, range) : null;
      ranges.set(`co:${checkout.path}`, {
        range,
        total: files ? totals(files) : checkout.uncommitted,
        commits: from ? { from, to: "HEAD" } : null,
      });
    }),
    ...branches
      .filter((branch) => !checkouts.some((checkout) => checkout.branch === branch.name))
      .map(async (branch) => {
        const tip = `refs/heads/${branch.name}`;
        if (!base || branch.isBase || branch.ahead === 0) {
          ranges.set(`br:${home}:${branch.name}`, { range: null, total: EMPTY, commits: { from: null, to: tip } });
          return;
        }
        const from = await mergeBase(home, `refs/heads/${base}`, tip);
        const range: DiffRange = { from, to: tip };
        // Diffing every old branch of a big repository costs seconds; an
        // old one is counted when it's looked at.
        const recent = Date.now() - Date.parse(branch.date) < RECENT_BRANCH_MS;
        ranges.set(`br:${home}:${branch.name}`, {
          range: from ? range : null,
          total: from && recent ? totals(await rangeFiles(home, range)) : null,
          commits: { from: from, to: tip },
        });
      }),
  ]);

  return {
    state: { root: home, name: home.split(sep).filter(Boolean).pop() ?? home, base, checkouts, branches },
    ranges,
    dirty: false,
    at: Date.now(),
  };
}

/** A repository's state, rebuilt only when its watcher has seen something or it's gone stale. */
async function repo(root: string): Promise<RepoMemory | null> {
  const known = repoMemory.get(root);
  if (known && !known.dirty && Date.now() - known.at < REPO_STALE_MS) return known;
  const inFlight = repoBuilds.get(root);
  if (inFlight) return inFlight;
  const started = Date.now();
  const build = buildRepo(root)
    .catch(() => null)
    .then((built) => {
      if (built) {
        // Something moved while this was reading: what it read may be stale.
        built.dirty = (changedAt.get(root) ?? 0) >= started;
        repoMemory.set(root, built);
      } else repoMemory.delete(root);
      return built;
    })
    .finally(() => repoBuilds.delete(root));
  repoBuilds.set(root, build);
  return build;
}

// ---- which repositories ------------------------------------------------------
//
// No list to maintain: the repositories are wherever the user works — the
// default session folder, the folders sessions were recently started in, the
// repos the Changes pane was pointed at, wherever running sessions are and
// whatever they've edited, and the folders of sessions from the last few days.

let historyFolders: { at: number; dirs: string[] } | null = null;

async function recentSessionFolders(): Promise<string[]> {
  if (historyFolders && Date.now() - historyFolders.at < DISCOVERY_STALE_MS) return historyFolders.dirs;
  const since = Date.now() - RECENT_SESSION_MS;
  const sessions = await listSessions().catch(() => []);
  const dirs = [...new Set(sessions.filter((s) => !s.automated && !s.archived && Date.parse(s.lastModified) > since && s.cwd).map((s) => s.cwd as string))];
  historyFolders = { at: Date.now(), dirs };
  return dirs;
}

const rootOfDir = new Map<string, string | null>();
const checkoutOfDir = new Map<string, string | null>();

/** The checkout a folder is in — a linked worktree's own folder, not its repository's. */
async function checkoutOf(dir: string): Promise<string | null> {
  if (!checkoutOfDir.has(dir)) checkoutOfDir.set(dir, await findRepoRoot(dir));
  return checkoutOfDir.get(dir) ?? null;
}

/** The repository a folder is in, remembered: the same few folders are asked about on every refresh. */
async function repoOf(dir: string): Promise<string | null> {
  if (rootOfDir.has(dir)) return rootOfDir.get(dir) ?? null;
  const top = await findRepoRoot(dir);
  // A linked worktree's toplevel is the worktree; the repository is its main checkout.
  const trees = top ? await listWorktrees(top) : [];
  const root = trees.find((tree) => tree.main)?.path ?? top;
  rootOfDir.set(dir, root);
  return root;
}

// ---- sessions --------------------------------------------------------------

function sessionState(agent: AgentSession): WorkSessionState {
  switch (agent.state) {
    case "working":
      return "working";
    case "blocked":
      return "needs";
    case "failed":
      return "failed";
    case "done":
      return "done";
    default:
      return agent.status === "busy" ? "working" : "idle";
  }
}

/**
 * Whether a running agent is a session to show. Set by index.ts to the same
 * test the old Sessions list used: pool spares, and widget sessions nobody
 * has typed into yet, are processes rather than conversations.
 */
let isShownAgent: (agent: AgentSession) => Promise<boolean> = async () => true;

export function setShownAgentTest(test: (agent: AgentSession) => Promise<boolean>): void {
  isShownAgent = test;
}

async function liveSessions(): Promise<{ agent: AgentSession; transcript: TranscriptMemory | null; title: string }[]> {
  const running = (await listAgents().catch(() => [])).filter((agent) => agent.pid && agent.sessionId);
  const shown = await Promise.all(running.map((agent) => isShownAgent(agent).catch(() => true)));
  const agents = running.filter((_, index) => shown[index]);
  return Promise.all(
    agents.map(async (agent) => ({
      agent,
      transcript: await readTranscript(agent.sessionId).catch(() => null),
      title: (await titleForSessionId(agent.sessionId).catch(() => null)) ?? agent.name ?? agent.sessionId,
    }))
  );
}

// ---- the snapshot -----------------------------------------------------------

/**
 * Which group an item is in: what the user has to do about it, most urgent
 * first. "quiet" is everything with nothing to do — shown in the Repos view
 * only. A branch counts as current for this RECENT_BRANCH_MS after its last
 * commit; a linked worktree is current however old, since it sits on disk
 * until it's cleaned up.
 */
function groupFor(
  kind: WorkItem["kind"],
  sessions: WorkSession[],
  { changed, merged, ahead, linked, recent }: { changed: boolean; merged: boolean; ahead: number; linked: boolean; recent: boolean }
): WorkGroup {
  if (sessions.some((s) => s.state === "needs" || s.state === "failed")) return "needs";
  if (sessions.some((s) => s.state === "working")) return "working";
  if (changed && (recent || linked || kind === "checkout")) return "review";
  if (sessions.length > 0) return "open";
  if (kind === "checkout" && linked && merged) return "shipped";
  if (kind === "branch" && recent) return merged ? "shipped" : ahead > 0 ? "branches" : "quiet";
  return "quiet";
}

let snapshotInFlight: Promise<WorkSnapshot> | null = null;
let lastSnapshot: WorkSnapshot | null = null;
let lastJson = "";

function rebuild(): Promise<WorkSnapshot> {
  if (!snapshotInFlight) {
    snapshotInFlight = buildSnapshot()
      .then((next) => {
        const json = JSON.stringify(next);
        const changed = json !== lastJson;
        lastSnapshot = next;
        lastJson = json;
        // Whoever was answered from the last one asks again.
        if (changed) for (const contents of subscribers) if (!contents.isDestroyed()) contents.send("work:changed", null);
        return next;
      })
      .finally(() => {
        snapshotInFlight = null;
      });
  }
  return snapshotInFlight;
}

/**
 * Everything the Work tab shows. Answered from the last snapshot at once
 * when there is one, with a fresh one built behind it — subscribers are
 * told if it differs — so the tab never waits on git. Only the very first
 * call waits; `prewarmWork` makes that happen before anyone looks.
 */
export function workSnapshot(): Promise<WorkSnapshot> {
  const building = rebuild();
  return lastSnapshot ? Promise.resolve(lastSnapshot) : building;
}

/** Builds the first snapshot ahead of time, so opening the Work tab doesn't wait for it. */
export function prewarmWork(): void {
  rebuild().catch(() => {});
}

async function buildSnapshot(): Promise<WorkSnapshot> {
  const config = readConfig();
  const live = await liveSessions();

  const candidates = new Set<string>([getDefaultDirectory(), ...config.recentRepos, ...config.recentDirectories]);
  for (const { agent, transcript } of live) {
    if (agent.cwd) candidates.add(agent.cwd);
    for (const file of transcript?.edits ?? []) {
      const dir = dirname(file);
      if (isDirectory(dir)) candidates.add(dir);
    }
  }
  for (const dir of await recentSessionFolders()) candidates.add(dir);

  const roots = new Set<string>();
  for (const dir of candidates) {
    if (!isDirectory(dir)) continue;
    const root = await repoOf(dir);
    if (root) roots.add(root);
  }
  const repos = (await Promise.all([...roots].map(repo))).filter((r): r is RepoMemory => r !== null);
  watchRepos(repos.map((r) => r.state));

  // Every checkout of every repository, deepest first, so a path is matched
  // to the innermost one (a worktree under .claude/worktrees is inside its
  // repository's own folder too).
  const checkoutPaths = repos
    .flatMap((r) => r.state.checkouts.map((c) => ({ path: c.path, real: real(c.path) })))
    .sort((a, b) => b.real.length - a.real.length);
  const checkoutFor = (path: string): string | null => {
    const target = real(path);
    return checkoutPaths.find((c) => within(target, c.real))?.path ?? null;
  };

  const sessions: WorkSession[] = live.map(({ agent, transcript, title }) => {
    const places = new Set<string>();
    const home = agent.cwd ? checkoutFor(agent.cwd) : null;
    if (home) places.add(home);
    for (const file of transcript?.edits ?? []) {
      const place = checkoutFor(file);
      if (place) places.add(place);
    }
    return {
      sessionId: agent.sessionId,
      agentId: agent.id,
      title,
      state: sessionState(agent),
      cwd: agent.cwd ?? null,
      startedAt: agent.startedAt ?? null,
      checkouts: [...places],
      lastReport: transcript?.lastReport ?? null,
    };
  });

  const items: WorkItem[] = [];
  for (const { state, ranges } of repos) {
    const byName = new Map(state.branches.map((branch) => [branch.name, branch]));
    for (const checkout of state.checkouts) {
      const id = `co:${checkout.path}`;
      const branch = checkout.branch ? byName.get(checkout.branch) ?? null : null;
      const here = sessions.filter((s) => s.checkouts.includes(checkout.path));
      const known = ranges.get(id);
      const committed = branch ? (branch.isBase ? branch.unpushed : branch.ahead) : 0;
      const changed = checkout.uncommitted.files > 0 || committed > 0;
      items.push({
        id,
        kind: "checkout",
        group: groupFor("checkout", here, {
          changed,
          merged: Boolean(branch && !branch.isBase && branch.ahead === 0),
          ahead: branch?.ahead ?? 0,
          linked: !checkout.main,
          recent: true,
        }),
        root: state.root,
        repo: state.name,
        base: state.base,
        branch: checkout.branch,
        checkout: checkout.path,
        main: checkout.main,
        sessionIds: here.map((s) => s.sessionId),
        range: known?.range ?? null,
        total: known?.total ?? checkout.uncommitted,
        commits: known?.commits ?? null,
        uncommitted: checkout.uncommitted,
        operation: checkout.operation,
        branchState: branch,
      });
    }
    for (const branch of state.branches) {
      if (state.checkouts.some((checkout) => checkout.branch === branch.name)) continue;
      const id = `br:${state.root}:${branch.name}`;
      const known = ranges.get(id);
      items.push({
        id,
        kind: "branch",
        group: groupFor("branch", [], {
          changed: false,
          merged: !branch.isBase && branch.ahead === 0,
          ahead: branch.ahead,
          linked: false,
          recent: Date.now() - Date.parse(branch.date) < RECENT_BRANCH_MS,
        }),
        root: state.root,
        repo: state.name,
        base: state.base,
        branch: branch.name,
        checkout: null,
        main: false,
        sessionIds: [],
        range: known?.range ?? null,
        total: known ? known.total : EMPTY,
        commits: known?.commits ?? null,
        uncommitted: null,
        operation: null,
        branchState: branch,
      });
    }
  }
  for (const session of sessions.filter((s) => s.checkouts.length === 0)) {
    items.push({
      id: `s:${session.sessionId}`,
      kind: "conversation",
      group: groupFor("conversation", [session], { changed: false, merged: false, ahead: 0, linked: false, recent: true }),
      root: null,
      repo: null,
      base: null,
      branch: null,
      checkout: null,
      main: false,
      sessionIds: [session.sessionId],
      range: null,
      total: EMPTY,
      commits: null,
      uncommitted: null,
      operation: null,
      branchState: null,
    });
  }

  return { repos: repos.map((r) => r.state), sessions, items };
}

// ---- a past session, for History ----------------------------------------------

export type DetailCommit = { sha: string; short: string; subject: string; date: string; parent: string | null };

export type SessionDetail = {
  sessionId: string;
  cwd: string | null;
  lastReport: string | null;
  /** What it touched, by repository: files it edited, and commits it made. */
  repos: {
    root: string;
    name: string;
    files: { path: string; uncommitted: boolean }[];
    commits: DetailCommit[];
  }[];
  /** Edited files in no repository (its memory, notes): counted, not listed. */
  elsewhere: number;
};

const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

/**
 * The commits a session made in one repository. Two sources: a `[branch
 * sha] subject` line in a command's output names one exactly; and since an
 * agent often commits quietly (`-q`) and prints something else, any commit
 * the repository's log has from within COMMIT_WINDOW_MS of a `git commit` the
 * session ran counts too.
 */
async function sessionCommits(root: string, transcript: TranscriptMemory): Promise<DetailCommit[]> {
  const found = new Map<string, DetailCommit>();
  const format = "--format=%H%x1f%h%x1f%s%x1f%aI%x1f%P%x1f%ct";
  const take = (stdout: string, keep: (seconds: number) => boolean) => {
    for (const record of stdout.split("\0").filter(Boolean)) {
      const [sha = "", short = "", subject = "", date = "", parents = "", seconds = "0"] = record.split("\x1f");
      if (sha && keep(Number(seconds))) {
        found.set(sha, { sha, short, subject, date, parent: parents.split(" ").filter(Boolean)[0] ?? null });
      }
    }
  };
  for (const named of transcript.commits) {
    const run = await git(root, ["--no-optional-locks", "log", "-n1", "-z", format, "--end-of-options", `${named.sha}^{commit}`], 64 * 1024);
    if (run.code === 0) take(run.stdout, () => true);
  }
  const calls = transcript.commitCalls;
  if (calls.length > 0) {
    const first = Math.min(...calls.map((c) => c.at));
    const last = Math.max(...calls.map((c) => c.at)) + COMMIT_WINDOW_MS;
    const run = await git(root, [
      "--no-optional-locks",
      "log",
      "--all",
      "-z",
      format,
      `--since=@${Math.floor(first / 1000) - 5}`,
      `--until=@${Math.ceil(last / 1000)}`,
    ]);
    if (run.code === 0) {
      take(run.stdout, (seconds) => calls.some((call) => seconds * 1000 >= call.at - 5000 && seconds * 1000 <= call.at + COMMIT_WINDOW_MS));
    }
  }
  return [...found.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export async function sessionDetail(sessionId: unknown): Promise<SessionDetail | null> {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const transcript = await readTranscript(sessionId);
  if (!transcript) return null;
  const byRoot = new Map<string, Set<string>>();
  const ensure = (root: string) => {
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    return byRoot.get(root)!;
  };
  // By checkout rather than repository: a file edited in a worktree is a
  // path in that worktree, and its uncommitted state is that worktree's.
  let elsewhere = 0;
  for (const file of transcript.edits) {
    const dir = dirname(file);
    const root = isDirectory(dir) ? await checkoutOf(dir) : null;
    if (!root || !within(file, root)) {
      elsewhere += 1;
      continue;
    }
    ensure(root).add(file.slice(root.length + 1));
  }
  // Where it ran, and where it ran its commits, count even with no edits there.
  for (const dir of [transcript.cwd, ...transcript.commitCalls.map((call) => call.cwd)]) {
    const root = dir && isDirectory(dir) ? await checkoutOf(dir) : null;
    if (root) ensure(root);
  }

  const repos = await Promise.all(
    [...byRoot].map(async ([root, files]) => {
      const uncommitted = new Set((await rangeFiles(root, { from: "HEAD", to: null }))?.map((f) => f.path) ?? []);
      return {
        root,
        name: root.split(sep).filter(Boolean).pop() ?? root,
        files: [...files].sort().map((path) => ({ path, uncommitted: uncommitted.has(path) })),
        commits: await sessionCommits(root, transcript),
      };
    })
  );
  return {
    sessionId,
    cwd: transcript.cwd,
    lastReport: transcript.lastReport,
    repos: repos.filter((r) => r.files.length > 0 || r.commits.length > 0),
    elsewhere,
  };
}

// ---- watching ---------------------------------------------------------------
//
// One watch per repository folder, plus one per worktree that lives outside
// it, held while any window is showing the Work tab. A change marks the
// repository for rebuilding and tells the windows, which ask again.

const subscribers = new Set<WebContents>();
const watched = new Map<string, () => void>();

function notify(root: string): void {
  changedAt.set(root, Date.now());
  const memory = repoMemory.get(root);
  if (memory) memory.dirty = true;
  for (const contents of subscribers) {
    if (!contents.isDestroyed()) contents.send("work:changed", root);
  }
}

function watchRepos(repos: RepoState[]): void {
  if (subscribers.size === 0) return;
  const wanted = new Map<string, string>();
  for (const state of repos) {
    wanted.set(state.root, state.root);
    for (const checkout of state.checkouts) {
      if (!within(checkout.path, state.root)) wanted.set(checkout.path, state.root);
    }
  }
  for (const [path, stop] of watched) {
    if (!wanted.has(path)) {
      stop();
      watched.delete(path);
    }
  }
  for (const [path, root] of wanted) {
    if (!watched.has(path)) watched.set(path, watchRepo(path, () => notify(root)));
  }
}

function stopWatching(): void {
  for (const stop of watched.values()) stop();
  watched.clear();
  // Nothing was watching while nobody looked, so nothing cached can be trusted.
  for (const memory of repoMemory.values()) memory.dirty = true;
}

export function subscribeWork(contents: WebContents): void {
  if (subscribers.has(contents)) return;
  subscribers.add(contents);
  contents.once("destroyed", () => unsubscribeWork(contents));
  workSnapshot().catch(() => {});
}

export function unsubscribeWork(contents: WebContents): void {
  subscribers.delete(contents);
  if (subscribers.size === 0) stopWatching();
}

/** After an action: the repository changed, whether or not a watcher noticed yet. */
export async function invalidateRepo(dir: unknown): Promise<void> {
  if (typeof dir !== "string" || !isDirectory(dir)) return;
  const root = await repoOf(dir);
  if (root) notify(root);
}
