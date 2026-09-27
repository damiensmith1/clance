import { createHash, randomBytes } from "crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeSync,
  chmodSync,
  existsSync,
  type FSWatcher,
} from "fs";
import { basename, dirname, join, sep } from "path";
import type { WebContents } from "electron";
import {
  git,
  findRepoRoot,
  getStatus,
  isDirectory,
  languageOf,
  looksBinary,
  containedFile,
  knownToHistory,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
} from "./git";
import { isWritable } from "./roots";

// A file tab's document: the text an editor works on, what it was at the last
// commit (for the Diff view and the gutter marks), and what a save needs to
// write it back byte-for-byte the way it was — line endings, a byte-order
// mark. Reading, saving and watching live together because the three share
// one idea of "the version on disk": the content hash a document was loaded
// at is what a save checks before it overwrites anything.
//
// Every path arrives from the renderer. Reads are contained in the root the
// tab names (as file tabs always were); writes must also land somewhere
// roots.ts allows. Nothing here runs a shell.

/** Editable up to here; larger text opens read-only. */
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
/** Shown at all up to here. */
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export type DocOpen =
  | {
      kind: "text";
      root: string;
      path: string;
      language: string;
      /** The file as text, BOM removed and line endings normalised to `\n`. */
      text: string;
      /**
       * The committed text to compare against: "" for a file git doesn't have
       * yet (all of it is new), null where there's nothing to compare with —
       * outside a repository, or a file git ignores.
       */
      head: string | null;
      eol: "\n" | "\r\n";
      bom: boolean;
      /** sha1 of the bytes on disk — the version a save expects to replace. */
      hash: string;
      bytes: number;
      /** Why it can't be edited, or null. */
      readOnly: string | null;
      /** An SVG's rendered form, drawn as an image. */
      preview: string | null;
    }
  | { kind: "image"; root: string; path: string; dataUrl: string; bytes: number }
  | { kind: "none"; root: string; path: string; bytes: number | null; reason: string }
  | {
      kind: "missing";
      root: string;
      path: string;
      /** The last committed text, when git has it, shown read-only. */
      head: string | null;
      reason: string;
    };

function sha1(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function decode(buffer: Buffer): { text: string; eol: "\n" | "\r\n"; bom: boolean } {
  const bom = buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM);
  const raw = (bom ? buffer.subarray(3) : buffer).toString("utf8");
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length;
  // A file is CRLF when most of its line breaks are; a stray \r\n in an LF
  // file shouldn't flip every line on save.
  const eol = crlf > 0 && crlf * 2 >= lf ? "\r\n" : "\n";
  return { text: raw.replace(/\r\n/g, "\n"), eol, bom };
}

function normalise(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");
}

function validRelative(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

/**
 * The committed text of `path`. "" when git knows nothing of it yet (so all of
 * it reads as new), null when it's ignored — ignored files have nothing to be
 * compared with.
 */
async function headText(repo: string, path: string): Promise<string | null> {
  const shown = await git(repo, ["--no-optional-locks", "show", `HEAD:${path}`], MAX_TEXT_BYTES);
  if (shown.code === 0) return normalise(shown.stdout);
  // A staged rename: the file's history is under its old name.
  const status = await getStatus(repo);
  const renamed = status?.files.find((file) => file.path === path && file.from);
  if (renamed?.from) {
    const old = await git(repo, ["--no-optional-locks", "show", `HEAD:${renamed.from}`], MAX_TEXT_BYTES);
    if (old.code === 0) return normalise(old.stdout);
  }
  const untracked = await git(
    repo,
    ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z", "--", path],
    64 * 1024
  );
  if (untracked.code === 0 && untracked.stdout.length > 0) return "";
  // Not untracked-and-visible and not in HEAD: either ignored, or tracked in a
  // repository with no commits yet — which is all new.
  const tracked = await git(repo, ["--no-optional-locks", "ls-files", "--cached", "-z", "--", path], 64 * 1024);
  return tracked.code === 0 && tracked.stdout.length > 0 ? "" : null;
}

/**
 * Reads a document for a file tab. One place a path is checked for reading.
 * `asText` opens a file the reader would otherwise refuse as binary, read-only
 * (the fallback's Open as Text).
 */
export async function readDocument(dir: unknown, path: unknown, asText?: unknown): Promise<DocOpen | null> {
  if (!isDirectory(dir) || !validRelative(path)) return null;
  const repo = await findRepoRoot(dir);
  const root = repo ?? dir;
  const full = containedFile(root, path);

  if (!full) {
    // Not on disk. A file a session deleted, or one that isn't on this
    // branch, still has something to show: what git last had.
    if (!repo) return null;
    const shown = await git(repo, ["--no-optional-locks", "show", `HEAD:${path}`], MAX_TEXT_BYTES);
    if (shown.code === 0) {
      return { kind: "missing", root, path, head: normalise(shown.stdout), reason: "Deleted — this is the last committed version" };
    }
    if (await knownToHistory(repo, path)) return { kind: "missing", root, path, head: null, reason: "Not on this branch" };
    return null;
  }

  let bytes: number;
  try {
    bytes = statSync(full).size;
  } catch {
    return null;
  }
  const language = languageOf(path);
  const mime = IMAGE_TYPES[language];

  if (mime && language !== "svg" && asText !== true) {
    if (bytes > MAX_IMAGE_BYTES) return { kind: "none", root, path, bytes, reason: "Image is too large to show" };
    try {
      const buffer = readFileSync(full);
      return { kind: "image", root, path, dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, bytes };
    } catch {
      return null;
    }
  }

  if (bytes > MAX_TEXT_BYTES) return { kind: "none", root, path, bytes, reason: "File is too large to open" };
  let buffer: Buffer;
  try {
    buffer = readFileSync(full);
  } catch {
    return { kind: "none", root, path, bytes, reason: "File could not be read" };
  }
  const binary = looksBinary(buffer);
  if (binary && asText !== true) return { kind: "none", root, path, bytes, reason: "Not a text file" };

  const { text, eol, bom } = decode(buffer);
  return {
    kind: "text",
    root,
    path,
    language,
    text,
    head: repo ? await headText(repo, path) : null,
    eol,
    bom,
    hash: sha1(buffer),
    bytes,
    readOnly: binary
      ? "Not a text file — shown as text, read-only"
      : bytes > MAX_EDIT_BYTES
        ? "Too large to edit — shown read-only"
        : null,
    preview: language === "svg" ? `data:image/svg+xml;base64,${buffer.toString("base64")}` : null,
  };
}

export type SaveResult =
  | { ok: true; hash: string }
  | { ok: false; conflict: true; diskText: string; diskHash: string }
  | { ok: false; conflict: false; error: string };

/**
 * Where `path` inside `root` would be written: the real path of the file if
 * it exists (writing through a link to its target, never replacing the link),
 * else of its parent directory joined with the name. Null if that escapes the
 * root or the writable roots.
 */
async function writeTarget(root: string, path: string): Promise<string | null> {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const joined = join(realRoot, path);
  let target: string;
  try {
    target = existsSync(joined) ? realpathSync(joined) : join(realpathSync(dirname(joined)), basename(joined));
  } catch {
    return null;
  }
  if (target !== realRoot && !target.startsWith(realRoot + sep)) return null;
  if (!(await isWritable(target))) return null;
  return target;
}

/** Writes bytes so a reader sees the old file or the new one, never half. */
function writeAtomically(target: string, bytes: Buffer): void {
  let mode: number | null = null;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {
    mode = null;
  }
  const temp = join(dirname(target), `.${basename(target)}.clance-${randomBytes(4).toString("hex")}`);
  const fd = openSync(temp, "w", mode ?? 0o644);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (mode !== null) chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

/**
 * Saves `text` over `path`. Refuses — returning what's on disk instead — if
 * the file changed since `baseHash` was read, unless `force`: a save never
 * silently overwrites a version the person hasn't seen. A missing file is
 * simply written, which is how a file deleted under an open tab comes back.
 */
export async function saveDocument(
  root: unknown,
  path: unknown,
  text: unknown,
  options: { eol?: unknown; bom?: unknown; baseHash?: unknown; force?: unknown }
): Promise<SaveResult> {
  if (!isDirectory(root) || !validRelative(path) || typeof text !== "string") {
    return { ok: false, conflict: false, error: "Can't save here" };
  }
  const target = await writeTarget(root, path);
  if (!target) return { ok: false, conflict: false, error: "Clance can't write to this folder" };

  if (existsSync(target) && options.force !== true) {
    let current: Buffer;
    try {
      current = readFileSync(target);
    } catch {
      return { ok: false, conflict: false, error: "The file on disk could not be read" };
    }
    const diskHash = sha1(current);
    if (typeof options.baseHash === "string" && diskHash !== options.baseHash) {
      return { ok: false, conflict: true, diskText: decode(current).text, diskHash };
    }
  }

  const eol = options.eol === "\r\n" ? "\r\n" : "\n";
  const body = Buffer.from(eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text, "utf8");
  const bytes = options.bom === true ? Buffer.concat([BOM, body]) : body;
  try {
    writeAtomically(target, bytes);
  } catch (error) {
    return { ok: false, conflict: false, error: error instanceof Error ? error.message : "Could not save" };
  }
  return { ok: true, hash: sha1(bytes) };
}

// ---- watching ---------------------------------------------------------------
//
// One watcher per open document's *directory*, not per file: editors and
// agents alike often save by writing a temp file and renaming it over the
// original, which a per-file watcher loses track of after the first save.
// A repository's own `.git` directory is watched too (not recursively), so a
// commit or checkout — which changes the committed text a Diff is against —
// reaches every open document in that repository.

const DEBOUNCE_MS = 120;

type DocWatch = { watcher: FSWatcher | null; docs: Map<string, Set<WebContents>>; timer: NodeJS.Timeout | null; pending: Set<string> };

const dirWatches = new Map<string, DocWatch>();
const gitWatches = new Map<string, { watcher: FSWatcher | null; roots: Map<string, Set<WebContents>>; timer: NodeJS.Timeout | null }>();

function send(sender: WebContents, channel: string, payload: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload);
}

function gitDirOf(repo: string): string | null {
  const dotGit = join(repo, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    // A worktree: `.git` is a file pointing at the real git directory.
    const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
    return pointer ? pointer[1] : null;
  } catch {
    return null;
  }
}

/** Starts telling `sender` when `path` in `root` changes on disk. */
export async function watchDocument(sender: WebContents, root: unknown, path: unknown): Promise<void> {
  if (!isDirectory(root) || !validRelative(path)) return;
  const full = join(root, path);
  const dir = dirname(full);
  const key = `${root}\0${path}`;

  let entry = dirWatches.get(dir);
  if (!entry) {
    const created: DocWatch = { watcher: null, docs: new Map(), timer: null, pending: new Set() };
    try {
      created.watcher = watch(dir, (_event, filename) => {
        const changed = filename ? [...created.docs.keys()].filter((k) => basename(k.split("\0")[1]) === filename) : [...created.docs.keys()];
        changed.forEach((k) => created.pending.add(k));
        if (created.timer) clearTimeout(created.timer);
        created.timer = setTimeout(() => {
          for (const k of created.pending) {
            const [docRoot, docPath] = k.split("\0");
            for (const s of created.docs.get(k) ?? []) send(s, "doc:changed", { root: docRoot, path: docPath });
          }
          created.pending.clear();
        }, DEBOUNCE_MS);
      });
      created.watcher.on("error", () => {});
    } catch {
      created.watcher = null;
    }
    entry = created;
    dirWatches.set(dir, entry);
  }
  const senders = entry.docs.get(key) ?? new Set<WebContents>();
  senders.add(sender);
  entry.docs.set(key, senders);

  const repo = await findRepoRoot(root);
  if (repo) {
    let g = gitWatches.get(repo);
    if (!g) {
      const created: { watcher: FSWatcher | null; roots: Map<string, Set<WebContents>>; timer: NodeJS.Timeout | null } = {
        watcher: null,
        roots: new Map(),
        timer: null,
      };
      const gitDir = gitDirOf(repo);
      if (gitDir) {
        try {
          created.watcher = watch(gitDir, (_event, filename) => {
            // Lock files come and go on every git command; only a finished
            // change to what HEAD points at, or the index, matters.
            if (filename && (filename.endsWith(".lock") || !/^(HEAD|ORIG_HEAD|index|packed-refs|FETCH_HEAD)$/.test(filename))) return;
            if (created.timer) clearTimeout(created.timer);
            created.timer = setTimeout(() => {
              for (const [docRoot, set] of created.roots) for (const s of set) send(s, "doc:head-changed", { root: docRoot });
            }, 300);
          });
          created.watcher.on("error", () => {});
        } catch {
          created.watcher = null;
        }
      }
      g = created;
      gitWatches.set(repo, g);
    }
    const set = g.roots.get(root) ?? new Set<WebContents>();
    set.add(sender);
    g.roots.set(root, set);
  }

  sender.once("destroyed", () => unwatchAll(sender));
}

/** Stops telling `sender` about `path`, closing watchers nobody needs. */
export function unwatchDocument(sender: WebContents, root: unknown, path: unknown): void {
  if (typeof root !== "string" || typeof path !== "string") return;
  const key = `${root}\0${path}`;
  const dir = dirname(join(root, path));
  const entry = dirWatches.get(dir);
  if (!entry) return;
  entry.docs.get(key)?.delete(sender);
  if (entry.docs.get(key)?.size === 0) entry.docs.delete(key);
  if (entry.docs.size === 0) {
    entry.watcher?.close();
    if (entry.timer) clearTimeout(entry.timer);
    dirWatches.delete(dir);
  }
  pruneGitWatches();
}

function unwatchAll(sender: WebContents): void {
  for (const [dir, entry] of dirWatches) {
    for (const [key, set] of entry.docs) {
      set.delete(sender);
      if (set.size === 0) entry.docs.delete(key);
    }
    if (entry.docs.size === 0) {
      entry.watcher?.close();
      dirWatches.delete(dir);
    }
  }
  for (const g of gitWatches.values()) for (const set of g.roots.values()) set.delete(sender);
  pruneGitWatches();
}

/** A repository's `.git` watch lives while any open document is inside it. */
function pruneGitWatches(): void {
  const openRoots = new Set<string>();
  for (const entry of dirWatches.values()) for (const key of entry.docs.keys()) openRoots.add(key.split("\0")[0]);
  for (const [repo, g] of gitWatches) {
    for (const [root, set] of g.roots) if (set.size === 0 || !openRoots.has(root)) g.roots.delete(root);
    if (g.roots.size === 0) {
      g.watcher?.close();
      if (g.timer) clearTimeout(g.timer);
      gitWatches.delete(repo);
    }
  }
}

/** A contained file's absolute path, for Reveal and Open in Default App. */
export function resolveContained(root: unknown, path: unknown): string | null {
  return containedFile(root, path);
}
