import { copyFileSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { SESSION_CWD } from "./paths";

const DROPPED_FILES_DIR = join(SESSION_CWD, "dropped-files");

/**
 * Copies a dropped file into Clance's own storage immediately, since a
 * file dragged from macOS system UI (e.g. the screenshot thumbnail) is
 * often only a "file promise" — a transient staging copy Chromium's drag
 * handling never resolves into a permanent file, and can vanish shortly
 * after the drop. Copying eagerly, before the CLI ever tries to read the
 * path, is the only way to beat that race. Returns undefined if the
 * source was already gone by the time we got to it.
 */
export function copyDroppedFile(sourcePath: string): string | undefined {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return undefined;

  try {
    mkdirSync(DROPPED_FILES_DIR, { recursive: true });
    const destPath = join(DROPPED_FILES_DIR, `${Date.now()}-${basename(sourcePath)}`);
    copyFileSync(sourcePath, destPath);
    return destPath;
  } catch {
    return undefined;
  }
}
