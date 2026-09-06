import { desktopCapturer, screen } from "electron";

const MAX_DIMENSION = 1568; // Claude's recommended max image edge — larger wastes tokens.

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
