// Turns dropped file paths into a bracketed-paste payload so a terminal's
// CLI input receives them as literal, unsubmitted text at the cursor —
// the same technique popup.js already uses to inject context text.
export function filePathsToPastePayload(paths) {
  const text = paths
    .map((path) => (/\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path))
    .join(" ");
  // eslint-disable-next-line no-control-regex
  const sanitized = text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
  return `\x1b[200~${sanitized}\x1b[201~`;
}
