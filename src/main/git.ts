import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { watch, statSync, readFileSync, realpathSync, FSWatcher } from "fs";
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
/** Lines shown for one file before the view says the rest is hidden. */
const MAX_DIFF_LINES = 4000;
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

export type DiffLine = {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type FileDiff = {
  path: string;
  lines: DiffLine[];
  binary: boolean;
  /** Set when the file was too big to render, with the reason to show. */
  omitted: string | null;
  truncated: boolean;
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
async function git(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES): Promise<GitRun> {
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

function isDirectory(path: unknown): path is string {
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

/** `--numstat -z` for one side of the diff, as path → counts. */
async function numstat(root: string, cached: boolean): Promise<Map<string, { insertions: number; deletions: number; binary: boolean }>> {
  const counts = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  const args = ["--no-optional-locks", "diff", "--numstat", "-z"];
  if (cached) args.push("--cached");
  const { stdout, code } = await git(root, args);
  if (code !== 0) return counts;

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

/** Whether a merge, rebase or cherry-pick is half-finished. */
function inProgressOperation(root: string): string | null {
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
      statSync(join(root, ".git", file));
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

// ---- diffs -----------------------------------------------------------------

function parseUnifiedDiff(patch: string, maxLines = MAX_DIFF_LINES): { lines: DiffLine[]; truncated: boolean } {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let truncated = false;
  let inHeader = true;

  for (const raw of patch.split("\n")) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    // A patch ends with a newline, so splitting it leaves one empty field
    // that is not a line of the file. A real empty context line is " ",
    // which survives this check and becomes "" only after the slice below.
    if (raw === "") continue;
    if (raw.startsWith("@@")) {
      const match = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      inHeader = false;
      lines.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
      continue;
    }
    // A file header. Everything up to the next hunk belongs to it, and the
    // pane shows that from the status row instead. Tracked rather than
    // assumed to be only at the top: a patch can cover more than one file,
    // and a header parsed as content shows up as garbled context lines.
    if (raw.startsWith("diff --git ")) {
      inHeader = true;
      continue;
    }
    if (inHeader) continue;
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" — real, but not a line of the file.
      continue;
    } else {
      lines.push({ kind: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return { lines, truncated };
}

/**
 * One file's diff, always HEAD → working tree — "what has changed since the
 * last commit", which is the question the pane exists to answer. Staging is a
 * separate, file-level decision about what the next commit takes, so the view
 * doesn't split into staged and unstaged halves.
 */
export async function getFileDiff(dir: unknown, path: unknown): Promise<FileDiff | null> {
  const root = await findRepoRoot(dir);
  if (!root || typeof path !== "string" || !path) return null;

  // The path must be one git itself is currently reporting — not merely
  // inside the repo — so this can't be pointed at an arbitrary file.
  const status = await getStatus(root);
  const file = status?.files.find((f) => f.path === path);
  if (!file) return null;

  const empty = { path, binary: false, truncated: false };
  if (file.binary) return { ...empty, lines: [], omitted: "Binary file", binary: true };

  let run: GitRun;
  if (file.status === "untracked") {
    const full = join(root, path);
    try {
      if (statSync(full).size > MAX_DIFF_BYTES) {
        return { ...empty, lines: [], omitted: "File is too large to show" };
      }
    } catch {
      return { ...empty, lines: [], omitted: "File is gone" };
    }
    // An untracked file has nothing in HEAD to diff against, so it's compared
    // with an empty one. This exits 1 by design when they differ.
    run = await git(root, ["diff", "--no-index", "--", "/dev/null", full]);
    if (run.code > 1) return { ...empty, lines: [], omitted: run.stderr.trim() || "Could not read the file" };
  } else {
    if (file.from && status?.head) {
      // Rename detection is off once a pathspec limits the diff, so asking
      // for both names gives a delete and an add rather than one moved file.
      // Comparing the old blob with the file where it now lives says the
      // thing a reader wants: what changed in it on the way.
      run = await git(root, ["--no-optional-locks", "diff", `HEAD:${file.from}`, "--", path]);
    } else {
      const against = status?.head ? ["HEAD"] : [];
      run = await git(root, ["--no-optional-locks", "diff", ...against, "--", path]);
    }
    if (run.code !== 0) {
      const reason = run.stderr.includes("maxBuffer") ? "Diff is too large to show" : run.stderr.trim();
      return { ...empty, lines: [], omitted: reason || "Could not read the diff" };
    }
  }

  if (run.stdout.length > MAX_DIFF_BYTES) {
    return { ...empty, lines: [], omitted: "Diff is too large to show" };
  }
  const { lines, truncated } = parseUnifiedDiff(run.stdout);
  if (lines.length === 0) {
    return { ...empty, lines: [], omitted: "No textual changes" };
  }
  return { path, lines, binary: false, omitted: null, truncated };
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
const GIT_DIR_SIGNALS = /^(HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index|refs[\\/])/;

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

// ---- whole files -----------------------------------------------------------

/** A file view stops here rather than handing the renderer something it can't draw. */
const MAX_FILE_LINES = 20000;
/** Full-context diffs are much larger than hunk diffs, so they get their own ceiling. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export type FileView = {
  path: string;
  /** For the highlighter — the extension, lowercased, with no dot. */
  language: string;
  /**
   * A second way of showing this same text, if it has one. The tab offers
   * Rendered / Raw when it's set; null means the text is the only view there
   * is. A capability the reader declares, not something every file has.
   */
  renders: "markdown" | null;
  /** The whole file, with deleted lines put back where they were. */
  lines: DiffLine[];
  /** Whether this file differs from the last commit at all. */
  changed: boolean;
  binary: boolean;
  omitted: string | null;
  truncated: boolean;
};

function languageOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    // Dotfiles and extensionless files are mostly shell or config.
    return /^(Dockerfile|Makefile)$/i.test(name) ? name.toLowerCase() : "txt";
  }
  return name.slice(dot + 1).toLowerCase();
}

function looksBinary(buffer: Buffer): boolean {
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

/** Every line of a plain file, as context — nothing about it changed. */
function readWholeFile(root: string, path: string, kind: DiffLine["kind"]): Omit<FileView, "path" | "language" | "changed" | "renders"> {
  return readWholeFileAt(join(root, path), kind);
}

/**
 * The same read, given an absolute path that has already been checked. Files
 * reached through the Files explorer may sit outside any repository, where
 * there is no `ls-files` to vouch for them, so containment is the caller's
 * job (see `containedFile`) and this only reads.
 */
function readWholeFileAt(full: string, kind: DiffLine["kind"]): Omit<FileView, "path" | "language" | "changed" | "renders"> {
  let buffer: Buffer;
  try {
    if (statSync(full).size > MAX_FILE_BYTES) {
      return { lines: [], binary: false, omitted: "File is too large to show", truncated: false };
    }
    buffer = readFileSync(full);
  } catch {
    return { lines: [], binary: false, omitted: "File could not be read", truncated: false };
  }
  if (looksBinary(buffer)) return { lines: [], binary: true, omitted: "Binary file", truncated: false };

  const text = buffer.toString("utf8");
  const raw = text.split("\n");
  // A file ending in a newline splits into a trailing "" that isn't a line.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const truncated = raw.length > MAX_FILE_LINES;
  const kept = truncated ? raw.slice(0, MAX_FILE_LINES) : raw;
  const lines: DiffLine[] = kept.map((line, index) => ({
    kind,
    text: line,
    oldLine: kind === "add" ? null : index + 1,
    newLine: kind === "del" ? null : index + 1,
  }));
  return { lines, binary: false, omitted: null, truncated };
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
function containedFile(root: unknown, path: unknown): string | null {
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

/** A file read from a folder that isn't a repository: all context, no diff. */
function readPlainFileView(dir: unknown, path: unknown): FileView | null {
  const full = containedFile(dir, path);
  if (full === null || typeof path !== "string") return null;
  const language = languageOf(path);
  return { path, language, renders: rendersAs(language), changed: false, ...readWholeFileAt(full, "context") };
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

/**
 * What a file tab is handed. A file is drawn by a *reader* chosen from its
 * path, and text is the first one rather than the shape of the feature: an
 * image has no lines, no diff, and nothing to say about a 20,000-line
 * ceiling. A reader returns its own payload and the tab draws whichever it
 * got, so adding one later means writing a reader rather than reworking file
 * tabs.
 *
 * "No reader" isn't a failure — it's the fallback, and it says what it can
 * about the file rather than apologising for it. Readers are added to this
 * union in the codebase; nothing here is loaded from a user's disk.
 *
 * A reader never executes what it reads. File content is data: it is drawn,
 * never turned into markup. SVG and HTML both carry script, and Files browses
 * any folder on the machine.
 */
export type FileOpen =
  | { reader: "text"; view: FileView }
  | {
      reader: "image";
      path: string;
      /** A data URL. An image is *drawn*, never injected as markup — an
       *  `<img>` can't run the script an SVG is allowed to carry. */
      dataUrl: string;
      /** SVG has a text source worth reading; a PNG doesn't. */
      source: string | null;
      bytes: number;
    }
  | { reader: "none"; path: string; bytes: number | null; reason: string };

/** Which extensions have a rendered view as well as a raw one. */
function rendersAs(language: string): "markdown" | null {
  return language === "md" || language === "markdown" || language === "mdown" || language === "mkd"
    ? "markdown"
    : null;
}

/** Extensions the image reader claims, and the type each is drawn as. */
const IMAGE_TYPES: Record<string, string> = {
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
 * The image reader's own ceiling. Limits belong to a reader: 20,000 lines
 * means nothing to a photograph, and 16 MB of text is a pathological file
 * while 16 MB of camera output is a Tuesday.
 */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

async function readImage(dir: unknown, path: string, mime: string): Promise<FileOpen | null> {
  const root = (await findRepoRoot(dir)) ?? (isDirectory(dir) ? dir : null);
  if (!root) return null;
  const full = containedFile(root, path);
  if (!full) return null;
  try {
    const bytes = statSync(full).size;
    if (bytes > MAX_IMAGE_BYTES) {
      return { reader: "none", path, bytes, reason: "Image is too large to show" };
    }
    const buffer = readFileSync(full);
    return {
      reader: "image",
      path,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      source: mime === "image/svg+xml" ? buffer.toString("utf8") : null,
      bytes,
    };
  } catch {
    return null;
  }
}

/** Picks the reader for a file and reads it. One place a path is checked. */
export async function openFileView(dir: unknown, path: unknown): Promise<FileOpen | null> {
  // The reader is chosen from the path, before anything tries to read the
  // file as text — an image read as text is 20,000 lines of noise.
  if (typeof path === "string") {
    const mime = IMAGE_TYPES[languageOf(path)];
    // An "image" that won't read as one falls through and is treated like
    // any other file rather than reported as missing.
    if (mime) {
      const image = await readImage(dir, path, mime);
      if (image) return image;
    }
  }
  const view = await getFileView(dir, path);
  if (!view) return null;
  if (!view.binary) return { reader: "text", view };
  const root = (await findRepoRoot(dir)) ?? (isDirectory(dir) ? dir : null);
  let bytes: number | null = null;
  if (root) {
    try {
      bytes = statSync(join(root, view.path)).size;
    } catch {
      bytes = null;
    }
  }
  return { reader: "none", path: view.path, bytes, reason: "No reader for this kind of file" };
}

/**
 * A whole file, with its changes in place — what a file tab shows. The tab's
 * "show diff" toggle is a rendering choice over this one payload: hiding the
 * deleted lines leaves exactly the working-tree file, so both views come from
 * a single read and can't disagree with each other.
 *
 * The trick is `-U` with a context size larger than any real file, which makes
 * git emit the entire file as one hunk instead of islands around each change.
 */
export async function getFileView(dir: unknown, path: unknown): Promise<FileView | null> {
  const root = await findRepoRoot(dir);
  // Not a repository. There is no diff to show and no `ls-files` to say what
  // belongs here, so the file is read straight from disk and the tab gets a
  // view that is all context — which is what makes its Diff / Clean toggle
  // disappear rather than appear with one working side.
  if (!root) return readPlainFileView(dir, path);
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("..")) return null;

  const status = await getStatus(root);
  const file = status?.files.find((f) => f.path === path);
  const language = languageOf(path);
  const base = { path, language, renders: rendersAs(language) };

  // Not in the status listing: an ordinary file nobody has touched. It still
  // has to be inside the repo, which `ls-files` is the authority on.
  if (!file) {
    const known = await git(root, ["--no-optional-locks", "ls-files", "--error-unmatch", "-z", "--", path], 64 * 1024);
    if (known.code !== 0) {
      // Not in this tree. A file tab open across a branch switch lands here,
      // and "isn't in this repository any more" would be a lie — the file is
      // fine, it just doesn't exist on the branch now checked out.
      if (await knownToHistory(root, path)) {
        return { ...base, changed: false, lines: [], binary: false, omitted: "Not on this branch", truncated: false };
      }
      return null;
    }
    return { ...base, changed: false, ...readWholeFile(root, path, "context") };
  }

  if (file.binary) return { ...base, changed: true, lines: [], binary: true, omitted: "Binary file", truncated: false };

  // A file with nothing behind it in HEAD is all addition; a deleted one is
  // all removal, and its content only exists in the last commit.
  if (file.status === "untracked" || !status?.head) {
    return { ...base, changed: true, ...readWholeFile(root, path, "add") };
  }
  if (file.status === "deleted") {
    const run = await git(root, ["--no-optional-locks", "show", `HEAD:${path}`], MAX_FILE_BYTES);
    if (run.code !== 0) return { ...base, changed: true, lines: [], binary: false, omitted: "Deleted file", truncated: false };
    const raw = run.stdout.split("\n");
    if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
    const truncated = raw.length > MAX_FILE_LINES;
    const kept = truncated ? raw.slice(0, MAX_FILE_LINES) : raw;
    return {
      ...base,
      changed: true,
      lines: kept.map((text, index) => ({ kind: "del" as const, text, oldLine: index + 1, newLine: null })),
      binary: false,
      omitted: null,
      truncated,
    };
  }

  const args = file.from
    ? ["--no-optional-locks", "diff", `-U${MAX_FILE_LINES}`, `HEAD:${file.from}`, "--", path]
    : ["--no-optional-locks", "diff", `-U${MAX_FILE_LINES}`, "HEAD", "--", path];
  const run = await git(root, args, MAX_FILE_BYTES);
  if (run.code !== 0) {
    return { ...base, changed: true, lines: [], binary: false, omitted: run.stderr.trim() || "Could not read the file", truncated: false };
  }
  const { lines, truncated } = parseUnifiedDiff(run.stdout, MAX_FILE_LINES);
  // git reports the file as changed but the diff came back empty — a mode
  // change, say. The file itself is still worth showing.
  if (lines.length === 0) return { ...base, changed: false, ...readWholeFile(root, path, "context") };
  return { ...base, changed: true, lines, binary: false, omitted: null, truncated };
}

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
async function knownToHistory(root: string, path: string): Promise<boolean> {
  const run = await git(
    root,
    ["--no-optional-locks", "rev-list", "--all", "--max-count=1", "--", path],
    64 * 1024
  );
  return run.code === 0 && run.stdout.trim().length > 0;
}
