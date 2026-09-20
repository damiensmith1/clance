import { readdirSync, realpathSync, statSync, type Dirent } from "fs";
import { isAbsolute, join, relative, sep } from "path";
import { checkIgnore, findRepoRoot } from "./git";

// The Files explorer's side of the main process: listing a folder one level
// at a time, and turning a click in that tree into the (root, path) pair a
// file tab opens with.
//
// Files browses *any* folder, not only a repository, which is the whole point
// of it — and also what makes containment this module's problem. Inside a
// repository git will not name a path outside the tree, so a file tab could
// never escape one. Here there is no such authority, so every path that
// arrives from the renderer is resolved and checked against the chosen
// folder before anything reads it.
//
// Nothing here walks a folder tree. A listing reads one directory, because a
// tree over a large folder shouldn't cost anything while nobody is looking at
// the parts of it that are still collapsed.

export type FolderChoice = { root: string; name: string };

export type DirEntry = {
  name: string;
  /** Relative to the chosen folder, with `/` separators. */
  path: string;
  directory: boolean;
  /** A symbolic link. Named, never walked into — see `listDirectory`. */
  symlink: boolean;
  /** Ignored by git. Only ever true inside a repository. */
  ignored: boolean;
};

export type DirListing = {
  /** The directory listed, relative to the chosen folder. "" is the folder. */
  path: string;
  entries: DirEntry[];
  /** The OS's own words when a directory can't be read, rather than an empty list. */
  error: string | null;
  /**
   * Set when this is a repository but git couldn't say what it ignores. The
   * listing then holds everything, node_modules included, and the tree says
   * so — silently showing it all looks identical to a folder that really has
   * nothing ignored in it.
   */
  ignoreUnknown: boolean;
};

function isDirectory(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The absolute, symlink-resolved path of `rel` inside `root`, or null if it
 * escapes. Resolving first and checking second is the only order that holds:
 * a link inside the folder pointing somewhere else entirely passes every test
 * that can be made on the path as text.
 */
function contained(root: unknown, rel: unknown): string | null {
  if (!isDirectory(root) || typeof rel !== "string") return null;
  if (rel.startsWith("/") || rel.split("/").includes("..")) return null;
  try {
    const realRoot = realpathSync(root);
    const full = rel ? realpathSync(join(realRoot, rel)) : realRoot;
    if (full !== realRoot && !full.startsWith(realRoot + sep)) return null;
    return full;
  } catch {
    return null;
  }
}

/**
 * The folders worth offering in the switcher. The same places the Changes
 * switcher draws on — where new sessions open, where the user has recently
 * opened one, where the agents are working — minus the repository test, since
 * this one browses anything.
 */
export function listFolders(candidates: unknown): FolderChoice[] {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const folders: FolderChoice[] = [];
  for (const dir of candidates) {
    if (!isDirectory(dir)) continue;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    folders.push({ root: real, name: real.split(sep).filter(Boolean).pop() ?? real });
  }
  return folders;
}

/** A chosen folder, resolved — or null if it isn't a folder any more. */
export function resolveFolder(dir: unknown): string | null {
  if (!isDirectory(dir)) return null;
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * One level of `rel` inside `root`. Directories first, then files, each by
 * name — the order a person reads a folder in, not the order the filesystem
 * hands them over.
 *
 * Symbolic links are listed and never walked into. That keeps the tree inside
 * the folder without a second containment argument, and keeps a link that
 * points back at its own ancestor from becoming an infinite tree.
 */
export async function listDirectory(root: unknown, rel: unknown, showIgnored: unknown): Promise<DirListing | null> {
  const folder = resolveFolder(root);
  if (!folder) return null;
  const path = typeof rel === "string" ? rel : "";
  const full = contained(folder, path);
  if (!full || !isDirectory(full)) return null;

  let raw: Dirent[];
  try {
    raw = readdirSync(full, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Folder could not be read";
    return { path, entries: [], error: message, ignoreUnknown: false };
  }

  const entries: DirEntry[] = [];
  for (const dirent of raw) {
    // git's own directory, which is machinery rather than content.
    if (dirent.name === ".git") continue;
    entries.push({
      name: dirent.name,
      path: path ? `${path}/${dirent.name}` : dirent.name,
      // A link is reported as a link, not as whatever it points at: readdir
      // doesn't follow one, and neither does the tree.
      directory: dirent.isDirectory(),
      symlink: dirent.isSymbolicLink(),
      ignored: false,
    });
  }

  // Inside a repository, mark what git is ignoring. A tree whose first screen
  // is node_modules is useless, so the renderer hides these unless asked —
  // and this is the same set ⌘P already searches, so the two can't disagree
  // about what is in the project.
  let ignoreUnknown = false;
  const repoRoot = await findRepoRoot(full);
  if (repoRoot) {
    const ignored = await checkIgnore(
      repoRoot,
      entries.map((entry) => join(full, entry.name))
    );
    if (ignored === null) {
      ignoreUnknown = true;
    } else {
      for (const entry of entries) {
        if (ignored.has(join(full, entry.name))) entry.ignored = true;
      }
    }
  }

  const visible = showIgnored === true || ignoreUnknown ? entries : entries.filter((entry) => !entry.ignored);
  visible.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { path, entries: visible, error: null, ignoreUnknown };
}

/** Whether a folder is inside a repository, for the header's branch line. */
export async function folderRepo(root: unknown): Promise<string | null> {
  const folder = resolveFolder(root);
  return folder ? findRepoRoot(folder) : null;
}

/**
 * The (root, path) a file tab opens with, given a click in the tree.
 *
 * A file inside a repository resolves against the *repository* rather than
 * the chosen folder, so a file opened from Files and the same file opened
 * from Changes are one tab rather than two — and so it arrives with its
 * changes marked in place, whichever side it was reached from.
 */
export async function resolveFile(root: unknown, rel: unknown): Promise<{ root: string; path: string } | null> {
  const folder = resolveFolder(root);
  if (!folder) return null;
  const full = contained(folder, rel);
  if (!full) return null;
  try {
    if (!statSync(full).isFile()) return null;
  } catch {
    return null;
  }

  const repoRoot = await findRepoRoot(full.slice(0, full.lastIndexOf(sep)) || sep);
  if (repoRoot) {
    try {
      const realRepo = realpathSync(repoRoot);
      if (full === realRepo || full.startsWith(realRepo + sep)) {
        return { root: repoRoot, path: relative(realRepo, full).split(sep).join("/") };
      }
    } catch {
      // Fall through to the folder-relative answer.
    }
  }
  return { root: folder, path: relative(folder, full).split(sep).join("/") };
}
