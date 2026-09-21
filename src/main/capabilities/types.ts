// What every capability answers with.
//
// Capabilities are the bottom layer: the things Clance can actually do to
// the Mac, with no opinion about who asked. The MCP server (a Claude Code
// session calling a tool) and the assistant (⌥A, deciding what a spoken
// command meant) both call the same functions and render this same result
// their own way — the session gets MCP content blocks, the assistant gets a
// line in the HUD. See docs/design.md §"Assistant".
//
// `text` is written for a person to read: it names what happened, or why it
// didn't, in the app's own terms. It's the same prose either caller shows,
// which is why the failure text says what was looked for and where rather
// than just "failed".
export type Outcome =
  | { ok: true; text: string }
  | { ok: true; image: { data: string; mimeType: string } }
  | { ok: false; text: string };

export function ok(text: string): Outcome {
  return { ok: true, text };
}

export function fail(text: string): Outcome {
  return { ok: false, text };
}

export function image(data: string, mimeType: string): Outcome {
  return { ok: true, image: { data, mimeType } };
}

// Whether an Outcome carries a screenshot rather than words. Narrowing on a
// property rather than a `kind` tag keeps the common case — reading `.text`
// off a result you already know succeeded — free of ceremony.
export function isImage(outcome: Outcome): outcome is { ok: true; image: { data: string; mimeType: string } } {
  return "image" in outcome;
}
