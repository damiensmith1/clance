import { dialog, shell, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { SESSION_CWD } from "./paths";

// Saved lode canvases: a lode tab's canvas, named and kept as a file, to
// open again later (a system design built for studying, say). A file holds
// lode's own layout for the canvas (its cards by symbol, notes, groups,
// arrows, other folders, the view) and the project it reads; the code isn't
// in it, so a canvas opened later shows the code as it is then.
//
// They live in ~/.clance/canvases/, the list Clance shows and opens from;
// the window only reads and writes files there. Export writes a copy
// anywhere else (a repository, say), through the save dialog; that copy
// isn't one of Clance's saved canvases.

export const CANVAS_DIR = join(SESSION_CWD, "canvases");
const EXT = ".lode.json";

interface CanvasFile {
  lode: 1;
  name: string;
  root: string;
  savedAt: string;
  layout: unknown;
}

export interface CanvasEntry {
  path: string;
  name: string;
  root: string;
  savedAt: string;
}

const nameOf = (path: string) => basename(path).replace(/\.lode\.json$|\.json$/, "");

function canvasPaths(): string[] {
  try {
    return readdirSync(CANVAS_DIR)
      .filter((f) => f.endsWith(EXT))
      .map((f) => join(CANVAS_DIR, f));
  } catch {
    return []; // none saved yet
  }
}

function parse(path: string): CanvasFile | null {
  try {
    const file = JSON.parse(readFileSync(path, "utf8"));
    return file?.lode === 1 && typeof file.root === "string" ? file : null;
  } catch {
    return null;
  }
}

/** Every saved canvas, the most recently saved first. */
export function listCanvases(): CanvasEntry[] {
  return canvasPaths()
    .flatMap((path) => {
      const file = parse(path);
      return file ? [{ path, name: file.name || nameOf(path), root: file.root, savedAt: file.savedAt }] : [];
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** A saved canvas's file, if it's one on the list. */
export function readCanvas(path: unknown): CanvasFile | null {
  if (typeof path !== "string" || !canvasPaths().includes(path)) return null;
  return parse(path);
}

function write(path: string, name: string, root: string, layout: unknown): CanvasEntry {
  const file: CanvasFile = { lode: 1, name, root, savedAt: new Date().toISOString(), layout };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
  return { path, name, root, savedAt: file.savedAt };
}

const cleanName = (name: unknown) => (typeof name === "string" ? name.trim().replace(/[\/\\:]+/g, "-").replace(/^\.+/, "").slice(0, 80) : "");

/** Save over a canvas already saved (one on the list). */
export function saveCanvas(path: unknown, root: unknown, layout: unknown): CanvasEntry | null {
  if (typeof path !== "string" || typeof root !== "string" || !canvasPaths().includes(path)) return null;
  return write(path, parse(path)?.name || nameOf(path), root, layout);
}

/** Save a canvas for the first time, under a name (its file named for it,
 *  made unique). */
export function createCanvas(name: unknown, root: unknown, layout: unknown): CanvasEntry | null {
  const clean = cleanName(name);
  if (!clean || typeof root !== "string") return null;
  let path = join(CANVAS_DIR, `${clean}${EXT}`);
  for (let n = 2; existsSync(path); n++) path = join(CANVAS_DIR, `${clean} ${n}${EXT}`);
  return write(path, clean, root, layout);
}

/** Export a copy of a canvas wherever the person picks (the save dialog).
 *  The copy isn't one of Clance's saved canvases. Its path, or null if they
 *  cancel. */
export async function exportCanvas(win: BrowserWindow | null, name: unknown, root: unknown, layout: unknown): Promise<string | null> {
  if (typeof root !== "string") return null;
  const options = { title: "Export canvas", defaultPath: `${cleanName(name) || "canvas"}${EXT}`, filters: [{ name: "lode canvas", extensions: ["json"] }] };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  const path = result.filePath.endsWith(".json") ? result.filePath : `${result.filePath}${EXT}`;
  write(path, cleanName(name) || nameOf(path), root, layout);
  return path;
}

/** Delete a saved canvas: to the Trash, so it can be got back. */
export async function deleteCanvas(path: unknown): Promise<boolean> {
  if (typeof path !== "string" || !canvasPaths().includes(path)) return false;
  await shell.trashItem(path);
  return true;
}
