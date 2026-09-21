// The transcript buffer.
//
// Streaming transcription emits a partial every few hundred milliseconds
// and revises what it already said, so deciding on every partial would be
// jittery and wasteful. This exposes a **stable prefix**: the longest
// leading run of the transcript that hasn't changed for a while. Only
// stable prefixes are decided on.
//
// When a decision fires an action, the buffer takes a **commit point**: the
// consumed prefix is dropped and whatever follows carries forward. That is
// what makes one ⌥A press hold a conversation — the user never stops
// talking, and each finished command clears itself out of the way.
//
// Streaming partials are step 5 of the build order and don't exist yet, so
// today this is fed one whole utterance at a time and every prefix is
// stable the moment it arrives. The shape is here so that changing the
// speech engine doesn't change anything above it.

/** How long a prefix must stay unchanged before it counts as settled. */
const STABILITY_MS = 200;

export class TranscriptBuffer {
  private text = "";
  private stableAt = 0;
  private lastChangeAt = 0;

  /** A revised transcript from the recogniser. Replaces, never appends. */
  update(text: string, now = Date.now()): void {
    const next = text.trimStart();
    if (next === this.text) return;
    // Everything the two versions still agree on is settled; the revision
    // only ever reaches back as far as they diverge.
    this.stableAt = commonPrefixLength(this.text, next);
    this.text = next;
    this.lastChangeAt = now;
  }

  /** A whole utterance, already final — today's stop-then-transcribe path. */
  final(text: string, now = Date.now()): void {
    this.text = text.trim();
    this.stableAt = this.text.length;
    this.lastChangeAt = now - STABILITY_MS;
  }

  /**
   * The part that has held still long enough to decide on, trimmed to a
   * word boundary so a decider is never handed half a word.
   */
  stablePrefix(now = Date.now()): string {
    if (!this.text) return "";
    const settled =
      now - this.lastChangeAt >= STABILITY_MS ? this.text.length : Math.min(this.stableAt, this.text.length);
    if (settled <= 0) return "";
    const slice = this.text.slice(0, settled);
    if (settled >= this.text.length) return slice.trim();
    const boundary = slice.lastIndexOf(" ");
    return boundary > 0 ? slice.slice(0, boundary).trim() : "";
  }

  /** Everything heard so far, stable or not. For the HUD only. */
  heard(): string {
    return this.text;
  }

  /**
   * A command has been acted on: drop what it consumed and carry the rest
   * forward, so the next thing the user says starts from a clean buffer.
   */
  commit(consumed: string): void {
    const index = this.text.toLowerCase().indexOf(consumed.trim().toLowerCase());
    const after = index >= 0 ? this.text.slice(index + consumed.trim().length) : "";
    this.text = after.trimStart();
    this.stableAt = 0;
    this.lastChangeAt = Date.now();
  }

  /** Throw away an unfinished phrase rather than guessing at it. */
  clear(): void {
    this.text = "";
    this.stableAt = 0;
    this.lastChangeAt = Date.now();
  }

  /** How long the buffer has held something nobody has acted on. */
  idleFor(now = Date.now()): number {
    return this.text ? now - this.lastChangeAt : 0;
  }

  get empty(): boolean {
    return this.text.length === 0;
  }
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}
