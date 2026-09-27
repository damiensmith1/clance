// File-type handlers: how a kind of file is shown and edited. The main
// process decides how a file may be *read* (documents.ts — text, image bytes,
// or nothing); a handler decides how that is *shown* and whether it can be
// edited, and which views it offers.
//
// Adding a file type is adding a module here. Each handler:
//   id           a name
//   match(buffer) a score; the highest wins. Text matches any readable text
//                 at 1, the fallback everything at 0.
//   views        [{ id, label, render }] — `render` is a component taking
//                 { buffer, onOpenFile }. `source` views are the editor.
//   defaultView  which view a tab opens on
//   Actions      optional component for the tab header ({ buffer })
//
// Handlers are code in the app, never loaded from disk: they run in a page
// that can reach the terminal bridge. See docs/design.md's "File-type handlers".

import text from "./text.js";
import markdown from "./markdown.js";
import svg from "./svg.js";
import env from "./env.js";
import image from "./image.js";
import missing from "./missing.js";
import fallback from "./fallback.js";

const HANDLERS = [markdown, svg, env, text, image, missing, fallback];

export function pickHandler(buffer) {
  let best = fallback;
  let bestScore = -1;
  for (const handler of HANDLERS) {
    const score = handler.match(buffer);
    if (score > bestScore) {
      best = handler;
      bestScore = score;
    }
  }
  return best;
}
