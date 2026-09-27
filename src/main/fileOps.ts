import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "path";
import { shell } from "electron";
import { isDirectory } from "./git";
import { isWritable } from "./roots";

// The Files tree's write side: create, rename, move, duplicate, move to the
// Trash, and copy in from Finder. Every call names a folder (the tree's root)
// and paths relative to it; each is resolved and checked here — contained in
// the folder after resolving links, and inside somewhere roots.ts allows
// writing — before anything touches the disk. An entry that is itself a link
// is acted on as a link (renamed, moved, trashed), never followed.

export type OpResult = { ok: true; path: string } | { ok: false; error: string };

function validRelative(rel: unknown): rel is string {
  return typeof rel === "string" && !rel.startsWith("/") && !rel.split("/").includes("..");
}

/** A single path component a person typed. */
function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0") &&
    name.length <= 255
  );
}

function realRootOf(root: unknown): string | null {
  if (!isDirectory(root)) return null;
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

function inside(realRoot: string, full: string): boolean {
  return full === realRoot || full.startsWith(realRoot + sep);
}

/**
 * The absolute path of an existing entry, with only its *parent* resolved:
 * the entry itself may be a link, and acting on it must act on the link.
 */
async function existingEntry(realRoot: string, rel: string): Promise<string | null> {
  if (!validRelative(rel) || !rel) return null;
  const joined = join(realRoot, rel);
  let parent: string;
  try {
    parent = realpathSync(dirname(joined));
    lstatSync(join(parent, basename(joined)));
  } catch {
    return null;
  }
  const full = join(parent, basename(joined));
  if (!inside(realRoot, parent) || full === realRoot) return null;
  return (await isWritable(parent)) ? full : null;
}

/** A directory inside the root that may be written into. "" is the root. */
async function writableDirectory(realRoot: string, rel: string): Promise<string | null> {
  if (!validRelative(rel)) return null;
  let dir: string;
  try {
    dir = rel ? realpathSync(join(realRoot, rel)) : realRoot;
  } catch {
    return null;
  }
  if (!inside(realRoot, dir) || !isDirectory(dir)) return null;
  return (await isWritable(dir)) ? dir : null;
}

function relativeTo(realRoot: string, full: string): string {
  return relative(realRoot, full).split(sep).join("/");
}

const DENIED: OpResult = { ok: false, error: "Clance can't write there" };

export async function createEntry(root: unknown, parentRel: unknown, name: unknown, kind: unknown): Promise<OpResult> {
  const realRoot = realRootOf(root);
  if (!realRoot || !validName(name)) return { ok: false, error: "That name can't be used" };
  const dir = await writableDirectory(realRoot, typeof parentRel === "string" ? parentRel : "");
  if (!dir) return DENIED;
  const target = join(dir, name);
  if (existsSync(target)) return { ok: false, error: `“${name}” already exists` };
  try {
    if (kind === "folder") mkdirSync(target);
    else writeFileSync(target, "", { flag: "wx" });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not create it" };
  }
  return { ok: true, path: relativeTo(realRoot, target) };
}

export async function renameEntry(root: unknown, rel: unknown, name: unknown): Promise<OpResult> {
  const realRoot = realRootOf(root);
  if (!realRoot || !validName(name) || typeof rel !== "string") return { ok: false, error: "That name can't be used" };
  const source = await existingEntry(realRoot, rel);
  if (!source) return DENIED;
  const target = join(dirname(source), name);
  if (target === source) return { ok: true, path: rel };
  // A case-only rename on a case-insensitive disk "exists" already.
  const caseOnly = target.toLowerCase() === source.toLowerCase();
  if (existsSync(target) && !caseOnly) return { ok: false, error: `“${name}” already exists` };
  try {
    renameSync(source, target);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not rename it" };
  }
  return { ok: true, path: relativeTo(realRoot, target) };
}

export async function moveEntry(root: unknown, rel: unknown, destRel: unknown): Promise<OpResult> {
  const realRoot = realRootOf(root);
  if (!realRoot || typeof rel !== "string" || typeof destRel !== "string") return DENIED;
  const source = await existingEntry(realRoot, rel);
  const dir = await writableDirectory(realRoot, destRel);
  if (!source || !dir) return DENIED;
  if (dir === source || dir.startsWith(source + sep)) return { ok: false, error: "A folder can't move inside itself" };
  const target = join(dir, basename(source));
  if (target === source) return { ok: true, path: rel };
  if (existsSync(target)) return { ok: false, error: `“${basename(source)}” already exists there` };
  try {
    renameSync(source, target);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not move it" };
  }
  return { ok: true, path: relativeTo(realRoot, target) };
}

/** `name copy.ext`, then `name copy 2.ext`, as Finder names duplicates. */
function copyName(dir: string, name: string, suffix: string): string {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const plainExt = ext && ext !== name ? ext : "";
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} ${suffix}${n === 1 ? "" : ` ${n}`}${plainExt}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem} ${suffix} ${Date.now()}${plainExt}`;
}

/** `name 2.ext`, then `name 3.ext` — Finder's Keep Both. */
function keepBothName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const plainExt = ext && ext !== name ? ext : "";
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} ${n}${plainExt}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem} ${Date.now()}${plainExt}`;
}

export async function duplicateEntry(root: unknown, rel: unknown): Promise<OpResult> {
  const realRoot = realRootOf(root);
  if (!realRoot || typeof rel !== "string") return DENIED;
  const source = await existingEntry(realRoot, rel);
  if (!source) return DENIED;
  const target = join(dirname(source), copyName(dirname(source), basename(source), "copy"));
  try {
    cpSync(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not duplicate it" };
  }
  return { ok: true, path: relativeTo(realRoot, target) };
}

/** To the macOS Trash — recoverable, never a straight delete. */
export async function trashEntry(root: unknown, rel: unknown): Promise<OpResult> {
  const realRoot = realRootOf(root);
  if (!realRoot || typeof rel !== "string") return DENIED;
  const source = await existingEntry(realRoot, rel);
  if (!source) return DENIED;
  try {
    await shell.trashItem(source);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not move it to the Trash" };
  }
  return { ok: true, path: rel };
}

export type CopyInResult =
  | { ok: true; paths: string[] }
  | { ok: false; conflicts: string[] }
  | { ok: false; error: string };

/**
 * Files dropped from Finder, copied into a folder of the tree. A source may be
 * anywhere (it's only read); the destination may not. With `onConflict`
 * "ask", nothing is copied if any name is taken — the names come back so the
 * tree can ask Replace / Keep Both / Cancel, as Finder does.
 */
export async function copyIn(root: unknown, destRel: unknown, sources: unknown, onConflict: unknown): Promise<CopyInResult> {
  const realRoot = realRootOf(root);
  if (!realRoot || typeof destRel !== "string" || !Array.isArray(sources)) return { ok: false, error: "Can't copy there" };
  const dir = await writableDirectory(realRoot, destRel);
  if (!dir) return { ok: false, error: "Clance can't write there" };
  const files = sources.filter((s): s is string => typeof s === "string" && isAbsolute(s) && existsSync(s));
  if (onConflict === "ask") {
    const taken = files.map((s) => basename(s)).filter((name) => existsSync(join(dir, name)));
    if (taken.length > 0) return { ok: false, conflicts: taken };
  }
  const copied: string[] = [];
  for (const source of files) {
    let name = basename(source);
    const existing = join(dir, name);
    if (existsSync(existing)) {
      if (onConflict === "replace") {
        if (existing === source) continue;
        try {
          await shell.trashItem(existing);
        } catch {
          return { ok: false, error: `Couldn't replace “${name}”` };
        }
      } else {
        name = keepBothName(dir, name);
      }
    }
    try {
      cpSync(source, join(dir, name), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : `Couldn't copy “${name}”` };
    }
    copied.push(relativeTo(realRoot, join(dir, name)));
  }
  return { ok: true, paths: copied };
}
