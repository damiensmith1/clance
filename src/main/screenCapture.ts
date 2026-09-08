import { desktopCapturer, screen } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

const MAX_DIMENSION = 1568; // Claude's recommended max image edge — larger wastes tokens.
const SCREENSHOTS_DIR = join(SESSION_CWD, "screenshots");

/**
 * Screenshot of the display nearest the cursor (where the popup opens),
 * captured fresh for this call — never cached or taken ambiently.
 * Returns undefined if Screen Recording permission hasn't been granted
 * (macOS returns an empty/black thumbnail rather than throwing).
 */
export async function captureActiveDisplay(): Promise<string | undefined> {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const scale = Math.min(
    1,
    MAX_DIMENSION / Math.max(display.size.width, display.size.height)
  );

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });

  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    return undefined;
  }

  return source.thumbnail.toPNG().toString("base64");
}

/**
 * Captures the active display and writes it to a PNG file under the
 * terminal's cwd, so it can be attached to a fresh Claude CLI session by
 * path. Returns undefined if capture failed (see captureActiveDisplay).
 */
export async function captureAndSaveActiveDisplay(): Promise<string | undefined> {
  const base64 = await captureActiveDisplay();
  if (!base64) return undefined;

  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filePath = join(SCREENSHOTS_DIR, `clance-${Date.now()}.png`);
  writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}
