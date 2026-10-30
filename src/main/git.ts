import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { watch, statSync, readFileSync, realpathSync, appendFileSync, mkdirSync, FSWatcher } from "fs";
import { isAbsolute, join, sep } from "path";
import { getLoginShellPath } from "./ptyManager";

const execFileAsync = promisify(execFile);

// Everything the Changes pane knows about git. Clance runs the `git` binary
// rather than linking a library: git is already on every machine that has a
// repo to look at, and a native addon would be a second thing to rebuild for
// Electron (the same reasoning that picked node:sqlite for dictation).
//
// Every argument here arrives from the renderer, so repo roots are re-derived
// with `rev-parse` rather than trusted, and file paths are checked against the
// status listing before they reach a command. Nothing is ever interpolated
// into a shell — execFile takes an argv, so a path with a space or a quote in
// it can't become an argument.
//
// A leading dash still can, though: argv keeps a path whole, but git reads an
// element beginning with `-` as an option wherever one is allowed. A file
// really can be named `--output=/somewhere`, git reports that name in
// `status`, and `git diff <rev> --output=/somewhere` writes the diff there.
// So every path handed to git is preceded by a `--` separator, including in
// the blob-versus-worktree form a rename uses. Being in the status listing is
// not enough on its own: the listing is where such a name comes from.

/** Diffs bigger than this are described rather than rendered. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** An untracked file larger than this isn't line-counted for the list. */
const MAX_UNTRACKED_COUNT_BYTES = 2 * 1024 * 1024;
/** How long the watcher waits for a burst of writes to settle. */
const WATCH_DEBOUNCE_MS = 300;
/** Fallback interval when a filesystem watch can't be established. */
const WATCH_POLL_MS = 4000;

export type GitFile = {
  /** Repo-relative, as git prints it. */
  path: string;
  /** Where it came from, for a rename. */
  from: string | null;
  /** The staged half of the porcelain XY code (" " when nothing is staged). */
  index: string;
  /** The unstaged half. */
  worktree: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
  /** Staged *and* changed again since — a commit now wouldn't take everything. */
  partiallyStaged: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
};

export type GitStatus = {
  root: string;
  /** null when HEAD is detached. */
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** A merge/rebase/cherry-pick is in progress — commit isn't a plain commit. */
  operation: string | null;
};

async function gitEnv(): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    PATH: await getLoginShellPath(),
    // A push that needs a password must fail rather than block a main-process
    // subprocess forever waiting on a tty nobody can type into. With a
    // keychain or SSH-agent credential helper it never gets this far.
    GIT_TERMINAL_PROMPT: "0",
    // Stops git from opening an editor or pager for anything.
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
  };
}

type GitRun = { stdout: string; stderr: string; code: number };

/**
 * Runs git in `cwd`. Rejects only on a failure to *launch* — a non-zero exit
 * comes back as `code`, because several of the commands here exit non-zero as
 * part of their normal contract (`diff --no-index` returns 1 when the files
 * differ, which is every time it's called).
 */
export async function git(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES): Promise<GitRun> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      env: await gitEnv(),
      maxBuffer,
      encoding: "utf8",
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: unknown; message?: string };
    // A real spawn failure (git missing) has no numeric code.
    if (typeof err.code !== "number") {
      return { stdout: "", stderr: err.message ?? "git could not be run", code: -1 };
    }
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
  }
}

export function isDirectory(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The repository containing `dir`, or null. Also the gate every other call in
 * this file goes through: a renderer hands over a directory, and what comes
 * back is git's own answer for where the repo actually starts, so no later
 * command runs anywhere the user didn't point at.
 */
export async function findRepoRoot(dir: unknown): Promise<string | null> {
  if (!isDirectory(dir)) return null;
  const { stdout, code } = await git(dir, ["rev-parse", "--show-toplevel"], 64 * 1024);
  if (code !== 0) return null;
  const root = stdout.trim();
  return isDirectory(root) ? root : null;
}

// ---- status ----------------------------------------------------------------

function classify(index: string, worktree: string): GitFile["status"] {
  if (index === "?" ) return "untracked";
  if (index === "u") return "conflicted";
  if (worktree === "D" || index === "D") return "deleted";
  if (index === "A") return "added";
  if (index === "R" || index === "C") return "renamed";
  return "modified";
}

/**
 * `--porcelain=v2 -z`, which is the only status format with a stable
 * machine-readable shape *and* the branch/ahead/behind header. NUL-separated
 * because a filename may contain anything at all, newlines included; the
 * line-based format quotes those instead, and unquoting is a second parser to
 * get wrong.
 */
function parsePorcelain(raw: string): Omit<GitStatus, "root" | "operation"> {
  const fields = raw.split("\0");
  const files: GitFile[] = [];
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;

    if (field.startsWith("# branch.oid ")) {
      const oid = field.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid.slice(0, 7);
    } else if (field.startsWith("# branch.head ")) {
      const name = field.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
    } else if (field.startsWith("# branch.upstream ")) {
      upstream = field.slice("# branch.upstream ".length);
    } else if (field.startsWith("# branch.ab ")) {
      const match = field.slice("# branch.ab ".length).match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (field.startsWith("1 ") || field.startsWith("2 ")) {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const renamed = field.startsWith("2 ");
      const parts = field.split(" ");
      const xy = parts[1] ?? "  ";
      const pathStart = renamed ? 9 : 8;
      const path = parts.slice(pathStart).join(" ");
      // A rename's source is its own NUL-terminated field, so it's consumed
      // here rather than found by splitting the record.
      const from = renamed ? fields[++i] ?? null : null;
      const index = xy[0] ?? " ";
      const worktree = xy[1] ?? " ";
      files.push({
        path,
        from,
        index,
        worktree,
        status: classify(index, worktree),
        staged: index !== ".",
        partiallyStaged: index !== "." && worktree !== ".",
        insertions: 0,
        deletions: 0,
        binary: false,
      });
    } else if (field.startsWith("u ")) {
      const parts = field.split(" ");
      files.push({
        path: parts.slice(10).join(" "),
        from: null,
        index: "u",
        worktree: "u",
        status: "conflicted",
        staged: false,
        partiallyStaged: false,
        insertions: 0,
        deletions: 0,
        binary: false,
      });
    } else if (field.startsWith("? ")) {
      files.push({
        path: field.slice(2),
        from: null,
        index: "?",
        worktree: "?",
        status: "untracked",
        staged: false,
        partiallyStaged: false,
        insertions: 0,
        deletions: 0,
        binary: false,
      });
    }
  }

  return { branch, head, upstream, ahead, behind, files };
}

type LineCounts = { insertions: number; deletions: number; binary: boolean };

/** `--numstat -z` for one side of the diff, as path → counts. */
async function numstat(root: string, cached: boolean): Promise<Map<string, LineCounts>> {
  const args = ["--no-optional-locks", "diff", "--numstat", "-z"];
  if (cached) args.push("--cached");
  const { stdout, code } = await git(root, args);
  return code === 0 ? parseNumstat(stdout) : new Map();
}

function parseNumstat(stdout: string): Map<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  // -z output is "ins\tdel\tpath\0", except for a rename, which is
  // "ins\tdel\t\0old\0new\0" — the tab-terminated empty path signals that the
  // two names follow as their own fields.
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const parts = field.split("\t");
    if (parts.length < 3) continue;
    const [ins, del] = parts;
    let path = parts.slice(2).join("\t");
    if (path === "") {
      i += 1; // old name, which the status listing already carries as `from`
      path = fields[++i] ?? "";
    }
    if (!path) continue;
    counts.set(path, {
      insertions: ins === "-" ? 0 : Number(ins),
      deletions: del === "-" ? 0 : Number(del),
      binary: ins === "-" && del === "-",
    });
  }
  return counts;
}

/** Lines in an untracked file, which no diff covers until it's added. */
function untrackedInsertions(root: string, path: string): { insertions: number; binary: boolean } {
  try {
    const full = join(root, path);
    const size = statSync(full).size;
    if (size > MAX_UNTRACKED_COUNT_BYTES) return { insertions: 0, binary: false };
    const buffer = readFileSync(full);
    // A NUL byte in the first 8 kB is how git itself guesses "binary".
    if (buffer.subarray(0, 8192).includes(0)) return { insertions: 0, binary: true };
    const text = buffer.toString("utf8");
    if (text === "") return { insertions: 0, binary: false };
    return { insertions: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), binary: false };
  } catch {
    return { insertions: 0, binary: false };
  }
}

/**
 * The checkout's own git directory. In the repository's main folder that's
 * `.git`; in a linked worktree `.git` is a file naming a directory under the
 * main one's `.git/worktrees/`, which is where its HEAD and in-progress
 * operations live.
 */
function gitDirOf(root: string): string {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
      if (pointer) return isAbsolute(pointer) ? pointer : join(root, pointer);
    }
  } catch {
    // No .git at all: the caller finds nothing there either.
  }
  return dotGit;
}

/** Whether a merge, rebase or cherry-pick is half-finished. */
export function inProgressOperation(root: string): string | null {
  const gitDir = gitDirOf(root);
  const marks: [string, string][] = [
    ["MERGE_HEAD", "merging"],
    ["rebase-merge", "rebasing"],
    ["rebase-apply", "rebasing"],
    ["CHERRY_PICK_HEAD", "cherry-picking"],
    ["REVERT_HEAD", "reverting"],
    ["BISECT_LOG", "bisecting"],
  ];
  for (const [file, label] of marks) {
    try {
      statSync(join(gitDir, file));
      return label;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * The whole state of a repo in one call. `--no-optional-locks` throughout, so
 * reading status never takes `index.lock` out from under an agent that's
 * running git in the same repo at the same time.
 */
export async function getStatus(dir: unknown): Promise<GitStatus | null> {
  const root = await findRepoRoot(dir);
  if (!root) return null;

  const [statusRun, unstaged, staged] = await Promise.all([
    git(root, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"]),
    numstat(root, false),
    numstat(root, true),
  ]);
  if (statusRun.code !== 0) return null;

  const parsed = parsePorcelain(statusRun.stdout);
  for (const file of parsed.files) {
    if (file.status === "untracked") {
      const { insertions, binary } = untrackedInsertions(root, file.path);
      file.insertions = insertions;
      file.binary = binary;
      continue;
    }
    // The counts a reader wants are HEAD → working tree, which is what the
    // diff below the list shows. Summing the two halves is close enough for
    // a file that's partly staged, and exact for every file that isn't.
    const a = unstaged.get(file.path);
    const b = staged.get(file.path);
    file.insertions = (a?.insertions ?? 0) + (b?.insertions ?? 0);
    file.deletions = (a?.deletions ?? 0) + (b?.deletions ?? 0);
    file.binary = Boolean(a?.binary || b?.binary);
  }

  parsed.files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, ...parsed, operation: inProgressOperation(root) };
}

// ---- actions ---------------------------------------------------------------

/** Keeps only the paths git is currently reporting, so no other file is touched. */
async function knownPaths(root: string, paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const status = await getStatus(root);
  if (!status) return [];
  const known = new Set(status.files.map((f) => f.path));
  // A rename's old name has to go too, or staging it leaves a phantom delete.
  for (const file of status.files) if (file.from) known.add(file.from);
  return paths.filter((p): p is string => typeof p === "string" && known.has(p));
}

export type GitActionResult = { ok: boolean; error: string | null };

function failed(run: GitRun, fallback: string): GitActionResult {
  return { ok: false, error: run.stderr.trim() || run.stdout.trim() || fallback };
}

export async function stageFiles(dir: unknown, paths: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const safe = await knownPaths(root, paths);
  if (safe.length === 0) return { ok: false, error: "Nothing to stage" };
  // `add -A --` covers a deletion as well as a change, which plain `add`
  // wouldn't, so the checkbox means the same thing for every kind of row.
  const run = await git(root, ["add", "-A", "--", ...safe]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not stage");
}

export async function unstageFiles(dir: unknown, paths: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const safe = await knownPaths(root, paths);
  if (safe.length === 0) return { ok: false, error: "Nothing to unstage" };
  const status = await getStatus(root);
  // Before the first commit there's no HEAD to reset against, and `restore
  // --staged` on a repo with no commits fails; `rm --cached` is the same
  // undo there.
  const run = status?.head
    ? await git(root, ["restore", "--staged", "--", ...safe])
    : await git(root, ["rm", "--cached", "-r", "--", ...safe]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not unstage");
}

/**
 * Throws away a file's uncommitted changes. The one destructive thing in the
 * pane, and the only one behind a confirmation in the UI — an untracked file
 * is deleted outright, so it isn't recoverable from git afterwards.
 */
export async function discardFiles(dir: unknown, paths: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const status = await getStatus(root);
  if (!status) return { ok: false, error: "Not a git repository" };
  const known = new Map(status.files.map((f) => [f.path, f]));
  const safe = (Array.isArray(paths) ? paths : []).filter(
    (p): p is string => typeof p === "string" && known.has(p)
  );
  if (safe.length === 0) return { ok: false, error: "Nothing to discard" };

  const untracked = safe.filter((p) => known.get(p)?.status === "untracked");
  const tracked = safe.filter((p) => known.get(p)?.status !== "untracked");

  if (tracked.length > 0) {
    const run = await git(root, ["restore", "--staged", "--worktree", "--", ...tracked]);
    if (run.code !== 0) return failed(run, "Could not discard");
  }
  if (untracked.length > 0) {
    const run = await git(root, ["clean", "-fd", "--", ...untracked]);
    if (run.code !== 0) return failed(run, "Could not remove untracked files");
  }
  return { ok: true, error: null };
}

export async function commit(dir: unknown, message: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  if (typeof message !== "string" || !message.trim()) {
    return { ok: false, error: "A commit needs a message" };
  }
  // `-m` and nothing else: no `-a`, so what's committed is exactly what the
  // file list showed as staged, and no `--amend`, so nothing already pushed
  // can be rewritten from here.
  const run = await git(root, ["commit", "-m", message.trim()]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not commit");
}

export async function push(dir: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const status = await getStatus(root);
  if (!status) return { ok: false, error: "Not a git repository" };
  // A branch with no upstream is the common case for a branch an agent just
  // made, so this sets one rather than failing with git's advice block.
  const args = status.upstream || !status.branch
    ? ["push"]
    : ["push", "--set-upstream", "origin", status.branch];
  const run = await git(root, args);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not push");
}

export async function pull(dir: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  // --ff-only: a pull that would need a merge commit is a decision, not a
  // button. It fails with git's own message, and the session next door can
  // do the merge.
  const run = await git(root, ["pull", "--ff-only"]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not pull");
}

export async function fetch(dir: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const run = await git(root, ["fetch", "--prune"]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not fetch");
}

// ---- watching --------------------------------------------------------------

// Paths inside .git that mean the repo actually moved. Everything else in
// there is churn — lock files, loose objects, packs — and a commit writes
// hundreds of them.
const GIT_DIR_SIGNALS =
  /^(HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index|packed-refs|refs[\\/]|worktrees[\\/][^\\/]+[\\/](HEAD|index)$)/;

function isNoise(relPath: string): boolean {
  if (!relPath) return false;
  const parts = relPath.split(sep);
  if (parts[0] === ".git") return !GIT_DIR_SIGNALS.test(parts.slice(1).join(sep));
  // Dependency and build trees churn constantly and are almost always
  // ignored anyway; a status run triggered by one is pure cost.
  return parts.includes("node_modules") || parts.includes(".DS_Store");
}

type RepoWatch = {
  watchers: FSWatcher[];
  poll: NodeJS.Timeout | null;
  debounce: NodeJS.Timeout | null;
  listeners: Set<() => void>;
};

const watches = new Map<string, RepoWatch>();

/**
 * Calls `onChange` when the repo moves — a file written, an index staged, a
 * commit made. This is what makes the pane a live view of an agent at work
 * rather than something the user has to refresh.
 *
 * macOS backs a recursive watch with FSEvents, so one watcher covers a whole
 * worktree cheaply. Events are debounced, because a single `npm install` or a
 * commit emits thousands, and filtered, because most of them say nothing.
 */
export function watchRepo(root: string, onChange: () => void): () => void {
  let entry = watches.get(root);

  if (!entry) {
    const created: RepoWatch = { watchers: [], poll: null, debounce: null, listeners: new Set() };
    const notify = () => {
      if (created.debounce) clearTimeout(created.debounce);
      created.debounce = setTimeout(() => {
        created.debounce = null;
        for (const listener of created.listeners) listener();
      }, WATCH_DEBOUNCE_MS);
    };

    try {
      created.watchers.push(
        watch(root, { recursive: true }, (_event, filename) => {
          if (typeof filename === "string" && isNoise(filename)) return;
          notify();
        })
      );
    } catch {
      // A watch can fail on a network mount or past the descriptor limit.
      // Polling is slower but keeps the pane honest rather than silently
      // frozen on a stale listing.
      created.poll = setInterval(notify, WATCH_POLL_MS);
    }

    watches.set(root, created);
    entry = created;
  }

  entry.listeners.add(onChange);
  return () => {
    const current = watches.get(root);
    if (!current) return;
    current.listeners.delete(onChange);
    if (current.listeners.size > 0) return;
    for (const watcher of current.watchers) watcher.close();
    if (current.poll) clearInterval(current.poll);
    if (current.debounce) clearTimeout(current.debounce);
    watches.delete(root);
  };
}

/** Drops every watch. Called when the main window goes away. */
export function stopAllRepoWatches(): void {
  for (const [, entry] of watches) {
    for (const watcher of entry.watchers) watcher.close();
    if (entry.poll) clearInterval(entry.poll);
    if (entry.debounce) clearTimeout(entry.debounce);
  }
  watches.clear();
}

// ---- the repo switcher's list ----------------------------------------------

export type RepoChoice = { root: string; name: string };

/**
 * Turns a list of candidate directories — the default session directory, the
 * recent ones, and wherever the running agents are working — into the distinct
 * repositories among them, most interesting first. The switcher needs no
 * configuration of its own because Clance already knows where the user works.
 */
export async function listRepos(candidates: unknown): Promise<RepoChoice[]> {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const repos: RepoChoice[] = [];
  // Sequential rather than parallel: the list is short, and a `rev-parse` per
  // candidate all at once is a burst of subprocesses for no gain.
  for (const dir of candidates) {
    const root = await findRepoRoot(dir);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    repos.push({ root, name: root.split(sep).filter(Boolean).pop() ?? root });
  }
  return repos;
}

// ---- files (shared with documents.ts and files.ts) --------------------------

export function languageOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    // Dotfiles and extensionless files are mostly shell or config.
    return /^(Dockerfile|Makefile)$/i.test(name) ? name.toLowerCase() : "txt";
  }
  return name.slice(dot + 1).toLowerCase();
}

export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * git with something on stdin. `execFile` has no way to write to a child, so
 * this one spawns directly; everything else about it matches `git` above —
 * the same environment, the same "a non-zero exit is a result, not a throw".
 */
function gitWithInput(cwd: string, args: string[], input: string, maxBuffer: number): Promise<GitRun> {
  return new Promise(async (resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["--no-pager", ...args], { cwd, env: await gitEnv() });
    } catch (error) {
      resolve({ stdout: "", stderr: error instanceof Error ? error.message : "git could not be run", code: -1 });
      return;
    }
    let stdout = "";
    let stderr = "";
    let over = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > maxBuffer) {
        over = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ stdout: "", stderr: error.message, code: -1 }));
    child.on("close", (code) =>
      resolve(over ? { stdout: "", stderr: "too much output", code: -1 } : { stdout, stderr, code: code ?? -1 })
    );
    // A closed stdin on a child that has already exited is an EPIPE, not a
    // problem worth failing the read over.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** How many paths go to one `check-ignore`. A directory can hold thousands. */
const CHECK_IGNORE_CHUNK = 500;

/**
 * An absolute path for `path` inside `root`, or null if it escapes.
 *
 * Inside a repository `ls-files` is the authority on what belongs, and git
 * will not name a path outside the tree, so containment comes free. A folder
 * chosen in the Files explorer has no such authority, so it is checked here —
 * and checked *after* resolving symbolic links rather than before, because a
 * link sitting inside the folder and pointing at ~/.ssh/id_rsa passes every
 * test that can be made on the path as text.
 */
export function containedFile(root: unknown, path: unknown): string | null {
  if (!isDirectory(root) || typeof path !== "string" || !path) return null;
  if (path.startsWith("/") || path.split("/").includes("..")) return null;
  try {
    const realRoot = realpathSync(root);
    const full = realpathSync(join(realRoot, path));
    if (full !== realRoot && !full.startsWith(realRoot + sep)) return null;
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/**
 * Which of `paths` (absolute) git is ignoring, for the Files tree.
 *
 * The paths go in over stdin rather than as arguments: `-z` is what keeps a
 * newline inside a filename from splitting one path into two, and git only
 * accepts it with `--stdin`. A directory can hold thousands of entries, which
 * would be a long argv anyway.
 *
 * Exit 1 means nothing matched, which is an answer. Anything else is a
 * failure, and it returns null rather than an empty set — "git could not
 * tell" and "nothing is ignored" look identical to a caller that can't tell
 * them apart, and the second one quietly puts node_modules on screen.
 */
export async function checkIgnore(root: string, paths: string[]): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set();
  const ignored = new Set<string>();
  for (let i = 0; i < paths.length; i += CHECK_IGNORE_CHUNK) {
    const chunk = paths.slice(i, i + CHECK_IGNORE_CHUNK);
    const run = await gitWithInput(
      root,
      ["--no-optional-locks", "check-ignore", "-z", "--stdin"],
      chunk.join("\0"),
      4 * 1024 * 1024
    );
    if (run.code === 1) continue;
    if (run.code !== 0) return null;
    for (const entry of run.stdout.split("\0")) if (entry) ignored.add(entry);
  }
  return ignored;
}

/** Extensions the image reader claims, and the type each is drawn as. */
export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/**
 * The image ceiling. Limits belong to a kind of file: 16 MB of text is a
 * pathological file, while 16 MB of camera output is a Tuesday.
 */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * Every file in the repo, for the open-by-name palette. Tracked files plus
 * untracked ones git isn't ignoring — so a file an agent created a minute ago
 * can be opened by name like any other.
 */
export async function listFiles(dir: unknown): Promise<string[]> {
  const root = await findRepoRoot(dir);
  if (!root) return [];
  const run = await git(root, [
    "--no-optional-locks",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (run.code !== 0) return [];
  const seen = new Set(run.stdout.split("\0").filter(Boolean));
  return [...seen].sort();
}

// ---- history and the remote -------------------------------------------------

export type GitCommit = {
  short: string;
  subject: string;
  /** ISO 8601, for the relative time the pane prints. */
  date: string;
  author: string;
};

/**
 * The last few commits, for the Changes pane's history strip. Status, not a
 * history browser: it answers "did that land" and "what just happened here",
 * which is the pane's own question asked about the commits instead of the
 * working tree.
 *
 * Fields are separated by US (0x1f) rather than NUL, because `-z` already
 * spends NUL on the record separator.
 */
export async function listCommits(dir: unknown, limit = 10): Promise<GitCommit[]> {
  const root = await findRepoRoot(dir);
  if (!root) return [];
  const count = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 10;
  const run = await git(root, [
    "--no-optional-locks",
    "log",
    `-n${count}`,
    "-z",
    "--format=%h%x1f%s%x1f%aI%x1f%an",
  ]);
  // A repo with no commits yet exits non-zero ("does not have any commits
  // yet"), which is an empty history rather than a failure.
  if (run.code !== 0) return [];
  return run.stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [short, subject, date, author] = record.split("\x1f");
      return { short: short ?? "", subject: subject ?? "", date: date ?? "", author: author ?? "" };
    })
    .filter((commit) => commit.short);
}

/**
 * A browsable https URL for the repo's remote, or null.
 *
 * Deliberately strict. A remote URL is repository content — `.git/config`
 * travels with a clone — so it is not something to hand to a browser as it
 * stands. Only http(s), ssh and git remotes convert; anything else (a local
 * path, a helper scheme) gets no button. Credentials are dropped rather than
 * carried across: an https remote can embed a token, and opening that in a
 * browser would write the token into history.
 */
function webUrlFromRemote(raw: string): { url: string; host: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // scp-like syntax has no scheme: git@github.com:owner/repo.git. The host
  // has to look like one — a dot and nothing but hostname characters — or
  // this shape swallows any `scheme:rest` string and turns it into a URL:
  // `javascript:alert(1)` parsed as host "javascript", path "alert(1)".
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const scp = hasScheme ? null : trimmed.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+\.[A-Za-z0-9-]+):(?!\/)(\S+)$/);
  const candidate = scp ? `https://${scp[1]}/${scp[2]}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;

  // Rebuilt rather than mutated: the URL protocol setter won't move a
  // non-special scheme like ssh: to https:, and rebuilding drops any
  // username and password with it.
  const scheme = parsed.protocol === "http:" ? "http" : "https";
  const port = parsed.port ? `:${parsed.port}` : "";
  const path = parsed.pathname.replace(/\.git\/?$/, "").replace(/^\/+/, "");
  if (!path) return null;
  return { url: `${scheme}://${parsed.hostname}${port}/${path}`, host: parsed.hostname };
}

/** Where "open the remote" would go, or null when there's nowhere to go. */
export async function getRemote(dir: unknown): Promise<{ url: string; host: string } | null> {
  const root = await findRepoRoot(dir);
  if (!root) return null;
  const run = await git(root, ["--no-optional-locks", "remote", "get-url", "origin"], 64 * 1024);
  if (run.code !== 0 || !run.stdout.trim()) return null;
  return webUrlFromRemote(run.stdout);
}

// ---- branches ---------------------------------------------------------------

export type GitBranch = {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** ISO 8601 of the branch tip's commit, which is what the list sorts by. */
  date: string;
  subject: string;
  current: boolean;
};

/** Branches beyond this aren't listed; a repo with more has a search problem, not a list problem. */
const MAX_BRANCHES = 200;

/**
 * Local branches, most recently committed to first.
 *
 * Read-only on purpose: the pane shows where the branches are and what they're
 * ahead or behind by, and leaves checking one out to a terminal or the session
 * next door. A checkout with a dirty tree either refuses or carries the changes
 * across, and that's a decision rather than a button.
 *
 * Newline-separated records are safe here in a way they aren't for paths: git's
 * own ref-name rules forbid control characters, so a branch name can't contain
 * one. Fields use US (0x1f) for the same reason `listCommits` does.
 */
export async function listBranches(dir: unknown): Promise<GitBranch[]> {
  const root = await findRepoRoot(dir);
  if (!root) return [];
  const run = await git(root, [
    "--no-optional-locks",
    "for-each-ref",
    "refs/heads",
    "--sort=-committerdate",
    `--count=${MAX_BRANCHES}`,
    "--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:iso8601)%1f%(HEAD)%1f%(contents:subject)",
  ]);
  if (run.code !== 0) return [];

  return run.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, track, date, head, subject] = line.split("\x1f");
      // `%(upstream:track)` prints "[ahead 2, behind 1]", "[gone]" or nothing.
      const ahead = Number(track?.match(/ahead (\d+)/)?.[1] ?? 0);
      const behind = Number(track?.match(/behind (\d+)/)?.[1] ?? 0);
      return {
        name: name ?? "",
        upstream: upstream || null,
        ahead,
        behind,
        date: date ?? "",
        subject: subject ?? "",
        current: head === "*",
      };
    })
    .filter((branch) => branch.name);
}

/**
 * Whether git has ever known this path on any ref — the difference between a
 * file that is merely not on the branch you're standing on and one that is
 * genuinely gone. Only asked when the path isn't in the current tree, so it
 * never costs anything in the normal case.
 */
export async function knownToHistory(root: string, path: string): Promise<boolean> {
  const run = await git(
    root,
    ["--no-optional-locks", "rev-list", "--all", "--max-count=1", "--", path],
    64 * 1024
  );
  return run.code === 0 && run.stdout.trim().length > 0;
}

// ---- worktrees, branches and ranges (the Work tab; see docs/design.md's "Work") ----

export type Worktree = {
  path: string;
  /** Full sha, or null before the first commit. */
  head: string | null;
  /** null when detached. */
  branch: string | null;
  /** The repository's own folder, as opposed to a linked worktree. */
  main: boolean;
  locked: boolean;
};

/**
 * Every checkout of the repository: its own folder first, then each linked
 * worktree. `--porcelain -z` records are fields separated by NUL and ended by
 * an empty one. A worktree whose folder has gone (prunable) or a bare entry
 * isn't a checkout anyone can look at, so neither is listed.
 */
export async function listWorktrees(root: string): Promise<Worktree[]> {
  const run = await git(root, ["--no-optional-locks", "worktree", "list", "--porcelain", "-z"]);
  if (run.code !== 0) return [];
  const trees: (Worktree & { skip: boolean })[] = [];
  let current: (Worktree & { skip: boolean }) | null = null;
  for (const field of run.stdout.split("\0")) {
    if (field === "") {
      if (current) trees.push(current);
      current = null;
    } else if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), head: null, branch: null, main: trees.length === 0, locked: false, skip: false };
    } else if (!current) {
      continue;
    } else if (field.startsWith("HEAD ")) {
      const sha = field.slice("HEAD ".length);
      current.head = /^0+$/.test(sha) ? null : sha;
    } else if (field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (field.startsWith("locked")) {
      current.locked = true;
    } else if (field === "bare" || field.startsWith("prunable")) {
      current.skip = true;
    }
  }
  if (current) trees.push(current);
  return trees.filter((tree) => !tree.skip && isDirectory(tree.path)).map(({ skip: _skip, ...tree }) => tree);
}

/**
 * The branch work is measured against: the one origin/HEAD names, else main,
 * else master, else whatever the repository's folder has checked out.
 */
export async function baseBranch(root: string): Promise<string | null> {
  const remote = await git(root, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 64 * 1024);
  const fromRemote = remote.code === 0 ? remote.stdout.trim().replace(/^origin\//, "") : "";
  for (const name of [fromRemote, "main", "master"].filter(Boolean)) {
    const run = await git(root, ["--no-optional-locks", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], 64 * 1024);
    if (run.code === 0) return name;
  }
  const head = await git(root, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], 64 * 1024);
  return head.code === 0 ? head.stdout.trim() || null : null;
}

export type BranchState = {
  name: string;
  /** Short sha of the tip. */
  sha: string;
  subject: string;
  /** ISO 8601 of the tip's commit. */
  date: string;
  upstream: string | null;
  /** It had an upstream that's been deleted — usually after a merge. */
  upstreamGone: boolean;
  /** Commits here and not on the upstream, and the other way round. */
  unpushed: number;
  unpulled: number;
  /** Against the base branch: commits only here, and commits it's missing. 0 for the base itself. */
  ahead: number;
  behind: number;
  isBase: boolean;
};

/** Branches compared against the base, newest first; past this a repo has a search problem. */
const MAX_COMPARED_BRANCHES = 40;

/**
 * Local branches with where each stands: against its upstream (what
 * `%(upstream:track)` says) and against the base branch (one `rev-list
 * --left-right --count` each, so capped). A branch with nothing ahead of the
 * base is merged into it: every commit on it is already there.
 */
export async function listBranchStates(root: string, base: string | null): Promise<BranchState[]> {
  const run = await git(root, [
    "--no-optional-locks",
    "for-each-ref",
    "refs/heads",
    "--sort=-committerdate",
    `--count=${MAX_COMPARED_BRANCHES}`,
    "--format=%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:iso8601-strict)%1f%(contents:subject)",
  ]);
  if (run.code !== 0) return [];
  const branches = run.stdout
    .split("\n")
    .filter(Boolean)
    .map((line): BranchState => {
      const [name = "", sha = "", upstream = "", track = "", date = "", subject = ""] = line.split("\x1f");
      return {
        name,
        sha,
        subject,
        date,
        upstream: upstream || null,
        upstreamGone: track.includes("gone"),
        unpushed: Number(track.match(/ahead (\d+)/)?.[1] ?? 0),
        unpulled: Number(track.match(/behind (\d+)/)?.[1] ?? 0),
        ahead: 0,
        behind: 0,
        isBase: name === base,
      };
    })
    .filter((branch) => branch.name);

  if (base) {
    await Promise.all(
      branches
        .filter((branch) => !branch.isBase)
        .map(async (branch) => {
          const counts = await git(root, [
            "--no-optional-locks",
            "rev-list",
            "--left-right",
            "--count",
            `refs/heads/${base}...refs/heads/${branch.name}`,
          ], 64 * 1024);
          const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
          branch.behind = behind || 0;
          branch.ahead = ahead || 0;
        })
    );
  }
  return branches;
}

/**
 * A commit named by the renderer, as its full sha — or null if it isn't one.
 * `--end-of-options` and the leading-dash check keep a "revision" from being
 * read as an option; `^{commit}` keeps it from being a tree or a blob.
 */
async function verifyCommit(root: string, rev: unknown): Promise<string | null> {
  if (typeof rev !== "string" || !rev || rev.startsWith("-") || rev.length > 200) return null;
  const run = await git(root, ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], 64 * 1024);
  return run.code === 0 ? run.stdout.trim() || null : null;
}

export async function mergeBase(root: string, a: string, b: string): Promise<string | null> {
  const run = await git(root, ["--no-optional-locks", "merge-base", "--end-of-options", a, b], 64 * 1024);
  return run.code === 0 ? run.stdout.trim() || null : null;
}

/** The empty tree's id, the "before" of a repository's first commit. Asked for, since it differs between sha-1 and sha-256 repos. */
async function emptyTree(root: string): Promise<string | null> {
  const run = await git(root, ["hash-object", "-t", "tree", "/dev/null"], 64 * 1024);
  return run.code === 0 ? run.stdout.trim() || null : null;
}

/**
 * What a diff compares. `from` is a commit, or null for nothing at all (a
 * repository's first commit); `to` is a commit, or null for the checkout's
 * files as they are now, untracked ones included.
 */
export type DiffRange = { from: string | null; to: string | null };

type ResolvedRange = { from: string; to: string | null };

async function resolveRange(root: string, range: unknown): Promise<ResolvedRange | null> {
  if (!range || typeof range !== "object") return null;
  const { from, to } = range as { from?: unknown; to?: unknown };
  const fromSha = from === null ? await emptyTree(root) : await verifyCommit(root, from);
  if (!fromSha) return null;
  if (to === null || to === undefined) return { from: fromSha, to: null };
  const toSha = await verifyCommit(root, to);
  return toSha ? { from: fromSha, to: toSha } : null;
}

export type RangeFile = {
  path: string;
  /** The old name, for a rename. */
  from: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  insertions: number;
  deletions: number;
  binary: boolean;
};

function rangeStatus(code: string): RangeFile["status"] {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R") || code.startsWith("C")) return "renamed";
  return "modified";
}

async function filesInRange(root: string, range: ResolvedRange): Promise<RangeFile[]> {
  const revs = range.to ? [range.from, range.to] : [range.from];
  const [names, counts, untracked] = await Promise.all([
    git(root, ["--no-optional-locks", "diff", "-M", "--name-status", "-z", "--end-of-options", ...revs]),
    git(root, ["--no-optional-locks", "diff", "-M", "--numstat", "-z", "--end-of-options", ...revs]),
    range.to
      ? Promise.resolve(null)
      : git(root, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (names.code !== 0) return [];
  const lines = parseNumstat(counts.stdout);
  const files: RangeFile[] = [];
  const fields = names.stdout.split("\0");
  for (let i = 0; i < fields.length; ) {
    const code = fields[i];
    if (!code) {
      i += 1;
      continue;
    }
    const moved = code.startsWith("R") || code.startsWith("C");
    const from = moved ? fields[i + 1] ?? null : null;
    const path = moved ? fields[i + 2] ?? "" : fields[i + 1] ?? "";
    i += moved ? 3 : 2;
    if (!path) continue;
    const count = lines.get(path);
    files.push({
      path,
      from,
      status: rangeStatus(code),
      insertions: count?.insertions ?? 0,
      deletions: count?.deletions ?? 0,
      binary: count?.binary ?? false,
    });
  }
  // A path ending in "/" is a folder git won't look inside because it holds
  // a repository of its own — typically a worktree under .claude/worktrees,
  // which is a checkout, not a change.
  const newFiles = untracked?.code === 0 ? untracked.stdout.split("\0").filter((p) => p && !p.endsWith("/")) : [];
  for (const path of newFiles) {
    const { insertions, binary } = untrackedInsertions(root, path);
    files.push({ path, from: null, status: "untracked", insertions, deletions: 0, binary });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The files a range changes, with line counts. Null when `dir` isn't a repository or the range doesn't resolve. */
export async function rangeFiles(dir: unknown, range: unknown): Promise<RangeFile[] | null> {
  const root = await findRepoRoot(dir);
  if (!root) return null;
  const resolved = await resolveRange(root, range);
  return resolved ? filesInRange(root, resolved) : null;
}

export type RangeCommit = {
  sha: string;
  short: string;
  subject: string;
  /** ISO 8601. */
  date: string;
  author: string;
  /** The first parent, which a commit's own diff is taken against; null for a first commit. */
  parent: string | null;
};

/**
 * Commits in `to` and not in `from` (`from..to`), newest first, or the last
 * few of `to` when `from` is null.
 */
export async function rangeCommits(dir: unknown, from: unknown, to: unknown, limit = 50): Promise<RangeCommit[]> {
  const root = await findRepoRoot(dir);
  if (!root) return [];
  const toSha = await verifyCommit(root, to);
  if (!toSha) return [];
  const fromSha = from === null || from === undefined ? null : await verifyCommit(root, from);
  if (from && !fromSha) return [];
  const count = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
  const run = await git(root, [
    "--no-optional-locks",
    "log",
    `-n${count}`,
    "-z",
    "--format=%H%x1f%h%x1f%s%x1f%aI%x1f%an%x1f%P",
    "--end-of-options",
    fromSha ? `${fromSha}..${toSha}` : toSha,
  ]);
  if (run.code !== 0) return [];
  return run.stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [sha = "", short = "", subject = "", date = "", author = "", parents = ""] = record.split("\x1f");
      return { sha, short, subject, date, author, parent: parents.split(" ").filter(Boolean)[0] ?? null };
    })
    .filter((commit) => commit.sha);
}

// ---- actions on branches and worktrees ----------------------------------------
//
// Each one re-derives everything it acts on from git itself: the checkout
// from findRepoRoot, a branch from the repository's own list, a worktree from
// `worktree list`. None of them forces anything — a worktree with changes in
// it isn't removed, an unmerged branch isn't deleted, a checkout with changes
// isn't switched — so the worst a click can do is be refused, with git's own
// reason.

async function localBranchNames(root: string): Promise<Set<string>> {
  const run = await git(root, ["--no-optional-locks", "for-each-ref", "refs/heads", "--format=%(refname:short)"]);
  return new Set(run.code === 0 ? run.stdout.split("\n").filter(Boolean) : []);
}

async function knownBranch(root: string, branch: unknown): Promise<string | null> {
  if (typeof branch !== "string" || !branch || branch.startsWith("-")) return null;
  return (await localBranchNames(root)).has(branch) ? branch : null;
}

/**
 * No uncommitted changes and nothing half-finished. Untracked files are
 * listed one by one (`-uall`) so a worktree nested inside the checkout — a
 * folder holding a repository of its own, reported as "dir/" — can be told
 * apart from real new files; collapsed, both read as one untracked folder.
 */
async function isClean(root: string): Promise<boolean> {
  if (inProgressOperation(root)) return false;
  const run = await git(root, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all"]);
  if (run.code !== 0) return false;
  return run.stdout.split("\0").every((entry) => !entry || (entry.startsWith("?? ") && entry.endsWith("/")));
}

/** Linked worktrees that sit inside `root`, relative to it — folders a commit there must never take. */
async function nestedWorktrees(root: string): Promise<string[]> {
  return (await listWorktrees(root))
    .filter((tree) => tree.path !== root && tree.path.startsWith(root + sep))
    .map((tree) => tree.path.slice(root.length + 1));
}

/**
 * Keeps `.claude/worktrees/` out of the repository's untracked files, in its
 * own `info/exclude` (never a committed .gitignore). Without it, every
 * worktree there shows as an untracked folder in the main checkout, and
 * `git add -A` there would commit it as an embedded repository.
 */
async function excludeWorktreeFolder(root: string): Promise<void> {
  const run = await git(root, ["rev-parse", "--git-common-dir"], 64 * 1024);
  if (run.code !== 0) return;
  const common = run.stdout.trim();
  const exclude = join(isAbsolute(common) ? common : join(root, common), "info", "exclude");
  try {
    const current = (() => {
      try {
        return readFileSync(exclude, "utf8");
      } catch {
        return "";
      }
    })();
    if (current.split("\n").some((line) => line.trim() === "/.claude/worktrees/")) return;
    mkdirSync(join(exclude, ".."), { recursive: true });
    appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/.claude/worktrees/\n`);
  } catch {
    // Not fatal: the worktree works either way; commits still skip it.
  }
}

/**
 * Checks `branch` out in a new worktree, under the repository's
 * `.claude/worktrees/` — where Claude Code puts its own — so looking at a
 * branch never moves the folder a session is working in.
 */
export async function addWorktree(dir: unknown, branch: unknown): Promise<GitActionResult & { path: string | null }> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository", path: null };
  const trees = await listWorktrees(root);
  const home = trees.find((tree) => tree.main)?.path ?? root;
  const name = await knownBranch(home, branch);
  if (!name) return { ok: false, error: "No such branch", path: null };
  const already = trees.find((tree) => tree.branch === name);
  if (already) return { ok: true, error: null, path: already.path };
  const folder = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "branch";
  let path = join(home, ".claude", "worktrees", folder);
  for (let n = 2; isDirectory(path); n++) path = join(home, ".claude", "worktrees", `${folder}-${n}`);
  await excludeWorktreeFolder(home);
  const run = await git(home, ["worktree", "add", "--", path, name]);
  return run.code === 0 ? { ok: true, error: null, path } : { ...failed(run, "Could not add the worktree"), path: null };
}

/** Removes a linked worktree. Never the repository's own folder, and never one with changes in it (no --force). */
export async function removeWorktree(dir: unknown, path: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const target = (await listWorktrees(root)).find((tree) => tree.path === path);
  if (!target) return { ok: false, error: "No such worktree" };
  if (target.main) return { ok: false, error: "That's the repository's own folder" };
  const run = await git(root, ["worktree", "remove", "--", target.path]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not remove the worktree");
}

/** `git switch` in a checkout, refused while it has uncommitted changes rather than carrying them across. */
export async function switchBranch(dir: unknown, branch: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const name = await knownBranch(root, branch);
  if (!name) return { ok: false, error: "No such branch" };
  if (!(await isClean(root))) return { ok: false, error: "This checkout has uncommitted changes. Commit or discard them first." };
  const run = await git(root, ["switch", name]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not switch branches");
}

/** `git branch -d`: refuses a branch that isn't merged, and one checked out anywhere. */
export async function deleteBranch(dir: unknown, branch: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const name = await knownBranch(root, branch);
  if (!name) return { ok: false, error: "No such branch" };
  if ((await listWorktrees(root)).some((tree) => tree.branch === name)) {
    return { ok: false, error: "That branch is checked out. Remove its worktree first." };
  }
  const run = await git(root, ["branch", "-d", name]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not delete the branch");
}

/**
 * Merges `branch` into the base branch, in whichever checkout has the base
 * checked out, which must be clean. A merge that stops on conflicts is
 * aborted and reported: resolving them is a session's job, not a button's.
 */
export async function mergeIntoBase(dir: unknown, branch: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const base = await baseBranch(root);
  const name = await knownBranch(root, branch);
  if (!base || !name || name === base) return { ok: false, error: "Nothing to merge" };
  const target = (await listWorktrees(root)).find((tree) => tree.branch === base);
  if (!target) return { ok: false, error: `${base} isn't checked out anywhere to merge into` };
  if (!(await isClean(target.path))) return { ok: false, error: `${base}'s checkout has uncommitted changes` };
  const run = await git(target.path, ["merge", "--no-ff", "--no-edit", name]);
  if (run.code === 0) return { ok: true, error: null };
  await git(target.path, ["merge", "--abort"]);
  return failed(run, "The merge stopped, and was undone");
}

/** `git revert` of one commit in a clean checkout; aborted again if it conflicts. */
export async function revertCommit(dir: unknown, sha: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  const commitSha = await verifyCommit(root, sha);
  if (!commitSha) return { ok: false, error: "No such commit" };
  if (!(await isClean(root))) return { ok: false, error: "This checkout has uncommitted changes. Commit or discard them first." };
  const run = await git(root, ["revert", "--no-edit", commitSha]);
  if (run.code === 0) return { ok: true, error: null };
  await git(root, ["revert", "--abort"]);
  return failed(run, "The revert stopped, and was undone");
}

/** Everything in the checkout, staged and committed in one go — what an agent's finished work usually wants. */
export async function commitAll(dir: unknown, message: unknown): Promise<GitActionResult> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, error: "Not a git repository" };
  if (typeof message !== "string" || !message.trim()) return { ok: false, error: "A commit needs a message" };
  const skip = (await nestedWorktrees(root)).map((rel) => `:(exclude,literal)${rel}`);
  const add = await git(root, ["add", "-A", "--", ".", ...skip]);
  if (add.code !== 0) return failed(add, "Could not stage the changes");
  const run = await git(root, ["commit", "-m", message.trim()]);
  return run.code === 0 ? { ok: true, error: null } : failed(run, "Could not commit");
}

/** Text larger than this isn't shown in a diff tab. */
const MAX_VERSION_BYTES = 4 * 1024 * 1024;

export type FileVersions = {
  path: string;
  /** The old name, for a rename. */
  from: string | null;
  status: RangeFile["status"];
  /** The file before and after the range; "" where it didn't exist. Null when it can't be shown. */
  before: string | null;
  after: string | null;
  /** Why it isn't shown, when it isn't. */
  omitted: string | null;
  insertions: number;
  deletions: number;
};

async function blobText(root: string, rev: string, path: string): Promise<string | null> {
  const run = await git(root, ["--no-optional-locks", "show", `${rev}:${path}`], MAX_VERSION_BYTES);
  return run.code === 0 ? run.stdout : null;
}

/**
 * Both sides of one file across a range, for a diff tab to lay out itself.
 * The path must be one the range itself reports, so this can't be aimed at
 * any other file.
 */
export async function rangeFileVersions(dir: unknown, range: unknown, path: unknown): Promise<FileVersions | null> {
  const root = await findRepoRoot(dir);
  if (!root || typeof path !== "string" || !path) return null;
  const resolved = await resolveRange(root, range);
  if (!resolved) return null;
  const file = (await filesInRange(root, resolved)).find((candidate) => candidate.path === path);
  if (!file) return null;
  const base = { path, from: file.from, status: file.status, insertions: file.insertions, deletions: file.deletions };
  if (file.binary) return { ...base, before: null, after: null, omitted: "Binary file" };

  const beforePath = file.from ?? path;
  const before = file.status === "added" || file.status === "untracked" ? "" : await blobText(root, resolved.from, beforePath);
  let after: string | null;
  if (file.status === "deleted") after = "";
  else if (resolved.to) after = await blobText(root, resolved.to, path);
  else {
    const full = join(root, path);
    try {
      if (statSync(full).size > MAX_VERSION_BYTES) return { ...base, before: null, after: null, omitted: "File is too large to show" };
      const buffer = readFileSync(full);
      if (looksBinary(buffer)) return { ...base, before: null, after: null, omitted: "Binary file" };
      after = buffer.toString("utf8");
    } catch {
      after = "";
    }
  }
  if (before === null || after === null) return { ...base, before: null, after: null, omitted: "Too large to show, or unreadable" };
  return { ...base, before, after, omitted: null };
}
