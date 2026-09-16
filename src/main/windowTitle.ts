// Window titles come from other applications, and some of them embed
// pictographic characters that are UI state rather than part of the name —
// Chrome appends a speaker to a tab that's playing audio, so its window
// title arrives as "New Tab 🔊". Stored verbatim, that leaks another app's
// transient indicator into Clance's own dictation history.
//
// Lives in its own module so both the capture path (frontApp.ts) and the
// migration that cleans up already-stored titles (dictationStore.ts) can
// share one definition, without either importing the other.

// Pictographic ranges only. Deliberately narrow: window titles legitimately
// contain accented Latin, CJK, Cyrillic and typographic punctuation, none of
// which should be touched. Also strips the emoji modifiers — variation
// selector-16, zero-width joiner, skin-tone modifiers — that would otherwise
// be left behind as invisible debris once the base glyph is gone.
const PICTOGRAPHIC =
  // eslint-disable-next-line no-misleading-character-class
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{24C2}\u{203C}\u{2049}]/gu;

/**
 * Strips emoji from a window title and tidies what's left behind.
 *
 * Returns undefined when nothing usable remains, so a title that was
 * *only* an emoji is recorded as "no target app" rather than an empty
 * string that would render as a stray separator.
 */
export function sanitizeWindowTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;

  const cleaned = title
    .replace(PICTOGRAPHIC, "")
    // Removing a glyph mid-string leaves doubled spaces.
    .replace(/\s{2,}/g, " ")
    // And removing a trailing glyph can leave a dangling separator, e.g.
    // "Gmail — 🔊" becoming "Gmail —".
    .replace(/[\s–—|·\-–—]+$/u, "")
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}
