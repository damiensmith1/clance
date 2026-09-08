import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

// Persisted shape mirrors src/mainWindow/state/layoutStore.js's pane tree —
// kept untyped here (just JSON passthrough) since the renderer owns the
// shape and this module only needs to read/write it verbatim.
const LAYOUT_PATH = join(SESSION_CWD, "window-layout.json");

export function readWindowLayout(): unknown | null {
  try {
    return JSON.parse(readFileSync(LAYOUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeWindowLayout(layout: unknown): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2), "utf8");
}
