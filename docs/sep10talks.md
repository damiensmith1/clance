---
title: Sep 10 talks — widget vision, SDK vs CLI, multimodal spike
tags: [clance, design, discussion]
status: draft
---

# Sep 10 talks

Notes from a design conversation about the widget's future: whether to bring
the Agent SDK back (for Quick Ask, or for the whole widget), what "understand
the screen and act on it" actually requires, and a live spike that closed one
of the open questions in `design.md`. This doc is a conversation record, not
a spec — durable decisions from it should eventually get folded into
`design.md`/`requirements.md` proper.

## The vision (restated)

Widgets that run real Claude instances that:
- Fully understand the context they're looking at on screen (not just a
  filename hint — actual visual understanding)
- Insert text into other apps
- Click things, move files around folders, and show you what they did

This is more ambitious than the current `design.md` describes (a terminal
embedding a CLI session, screenshot-path-as-context, `insert_text` only) —
it's closer to a computer-use agent than a coding assistant widget. The
conclusion of this conversation: **the vision holds up.** Most of the hard
infrastructure decisions already made in `design.md` turn out to be the
right ones for this bigger vision too, not obstacles to it.

## What's already built (unchanged by this conversation)

- Terminal-embedding architecture: every widget session is a real `claude`
  CLI child process (pty + xterm.js), not a custom chat UI. See
  `design.md`'s "Terminal-embedding architecture" section.
- `insert_text` MCP tool: a local MCP-over-HTTP server the CLI process calls
  itself to type text into whatever app was frontmost, via clipboard +
  simulated Cmd+V (`nut-js`). Proven template for adding more tools.
- Context injection: screenshot path + frontmost window title + any
  highlighted selection, handed to the CLI either invisibly
  (`--append-system-prompt`, new sessions only) or as visible typed input
  (resumed/attached sessions).
- Background-agent model: every session is `claude --bg`, attach-only from
  the widget's point of view — switching/closing tabs doesn't kill the
  underlying process.
- **The separate "Continue a Conversation" picker popup is deprecated** —
  folded into the regular widget (the "Open in…" dropdown now covers
  resuming an existing session). `design.md` still describes this as two
  separate hotkeys/modes in a couple of places and needs a correction pass.

## Resolved today: multimodal image input, without the SDK

**Question going in:** the current design hands the model a *path* to a
screenshot (`~/.clance/screenshots/...`), which the model may or may not
`Read()`. Is there a way to hand it a *real* image content block instead,
without switching the whole widget to the Agent SDK?

**Spike performed live** (see full transcript above in the conversation this
doc summarizes): copied a real screenshot to the macOS clipboard, opened a
`claude` session inside a pty with every byte to its stdin logged
(`script -q ... claude`), and sent a `Ctrl+V` via System Events.

**Finding:** the CLI reads the OS clipboard directly, out-of-band — it isn't
parsing image bytes out of the pty stream at all. Evidence:
- The CLI prints its own status text ("Image in clipboard · ctrl+v to
  paste", then "Pasting…") — that's Claude Code polling the clipboard and
  telling the user about it.
- Only a single `Ctrl+V` byte (`0x16`) crossed the pty for the whole
  operation — nowhere near enough data to contain an inlined ~1MB base64
  image.
- Confirmed genuine (not a hallucinated placeholder): asked Claude "what
  does this screenshot show, briefly?" immediately after pasting, and it
  correctly described the actual on-screen content (a Google search results
  page about Claude Code multimodal support).

**What this means for Clance:** the mechanism is simpler than the existing
text-context injection, not more complex:
1. Write the screenshot PNG to the OS clipboard (same
   write-clipboard/act/restore pattern `frontApp.ts` already uses for
   `insert_text`).
2. Write a single `0x16` byte directly into the pty via the existing
   `ptyManager.ts` write path — no bracketed-paste wrapper needed, no
   keystroke simulation, no `nut-js` even.
3. The CLI ingests it as a real `[Image #1]` block on its own.

Works identically for new and resumed/attached sessions — unlike the
current text-context split (invisible-for-new vs. visible-typed-for-resumed,
driven by the `--system-prompt-snapshot` limitation), this doesn't depend on
which kind of session it is.

**One caveat, untested:** a first-run/never-configured `claude` install may
have interstitial prompts (we hit a "Teach auto mode about your
environment?" dialog mid-spike) that could block this path on a fresh
machine. Worth checking before relying on it unconditionally.

**Action item:** replace the screenshot-path-as-text approach in
`design.md`'s "Context injection" section with this, once implemented.

## What multimodal does *not* solve: real-time duplex streaming

Raised near the end: "a completely native, zero-read, real-time duplex
streaming pipeline (raw mic/video frames streaming continuously)." This is a
different axis entirely from the paste spike above:

- What we proved: a *static* snapshot (one screenshot) can ride into a
  session as a real content block — a discrete, turn-based hand-off.
- Real-time duplex: a *continuous* channel, frames flowing both directions
  as they happen, not a message with attachments.

The CLI has no mode for this at any layer we found (`--print`,
`--input-format stream-json`, the interactive pty are all turn-based:
send a message, get a response, repeat). If this is ever wanted, it
genuinely requires bypassing the CLI and building directly against
Anthropic's API/SDK with real streaming infrastructure — there's no
CLI-level shortcut, unlike the image case.

**Unresolved/unverified:** whether Anthropic's API even offers true
real-time duplex audio/video streaming today (vs. turn-based content blocks
with token-level output streaming only). Don't treat this as a live option
until that's actually confirmed against current API docs — it may not be on
the table at all right now, independent of the CLI-vs-SDK question.

**Scope note:** this is bigger than what's in `requirements.md`'s existing
"Dictation" open question, which is about local speech-to-text (voice → text
→ normal turn), not a live voice/video conversation with the model. Treat as
a separate, later requirements-level conversation if it's actually wanted.

## The SDK question: where it was, where it landed

### Original framing (too broad)
"Bring the SDK back" — for a scoped `Quick Ask` hotkey, or possibly to power
the whole widget.

### Case for SDK-for-Quick-Ask only
- Structural advantage the CLI can't match: genuinely invisible context (you
  build the message payload yourself — a system/context block that's never
  rendered as "text in an input box" at all).
- Real cost: a second runtime to maintain — own auth path, tool wiring,
  model defaults, drift risk from the CLI's behavior.
- Resumability: don't hand-write CLI-compatible JSONL — **escalate**
  instead: seed a brand-new real `claude --bg` session with the quick-ask
  transcript when it needs to become a real conversation, and let the CLI
  write its own file. Never have Clance write into `~/.claude/projects/**`
  itself — `design.md`'s own unresolved open question ("need to inspect a
  real session file to confirm event/message structure before writing
  compatible transcripts") is exactly the risk this avoids, and the original
  terminal-embedding pivot was specifically about *not* owning that format.

### Case against SDK-for-the-whole-widget
- This is functionally the bet that already lost once. The custom chat UI
  wasn't reverted because of implementation quality — it lost because the
  CLI's own rendering (streaming, tool-call display, permission prompts,
  slash commands) is strictly better than any reimplementation. Moving the
  whole widget to the SDK reopens exactly that problem.
- Loses the background-agent model (`claude --bg`, daemon-supervised,
  attachable from multiple windows) — a `query()` call isn't a persistent
  externally-supervised process.
- **Permission prompts are the big one.** The CLI-terminal path gets
  "Allow / Deny / Always allow" prompts for free, for *any* tool — including
  brand-new custom MCP tools you wire in later (see computer-use section
  below). The SDK gives you none of that: your own code is the harness, and
  for every tool call you'd have to build the equivalent approval UI
  yourself — real UI, real state machine, exactly the `proposeText`
  accept/reject flow that was already built once and ripped out.

### Where "faster boot" landed
Initial idea: pre-warm a pool of spare `claude --bg` processes to fix
latency instead of touching the backend. **Rebutted:** a pre-warmed spare
can't have fresh context baked in — you'd still have to either bake context
in at spawn (too late for a pre-warmed spare) or type it visibly once
attached. So pooling solves latency but not the actual reason speed
mattered (fast *and* invisible-context together). The SDK's speed advantage
is real and doesn't have a cheaper substitute for the invisible-context
case specifically.

### Where the toggle landed
Low-cost, because attach-to-existing-session is already fully built:
- "Open existing" → attach to a real background agent (unchanged, full
  terminal, full tool access, permission prompts included)
- "New/quick" → SDK-backed fast path, explicit button, so the *slow* path
  (full real CLI session) is opt-in for when the user is prepared to wait,
  rather than the default.

### Current recommendation (net of the whole discussion)
1. SDK path (Quick Ask) stays scoped to **read-only Q&A + `insert_text`
   only** — no broad tool use, so no permission-prompt UI needs to be
   rebuilt.
2. Escalation = seed a fresh real `claude --bg` session with the transcript;
   never hand-write JSONL.
3. "Open existing" stays exactly as it is today — full CLI attach, full
   tools, native permission prompts.
4. Anything **riskier** (see computer-use below) stays on the CLI-terminal
   backend specifically *because* that's where the free permission system
   lives — don't run high-stakes tool calls (clicking, file moves) through
   the SDK path.

## The bigger ask: computer-use ("click things, move files, show you")

This reframed the SDK conversation — if the widget should eventually do
real, consequential things on the computer (not just text), the backend
choice isn't just an optimization, it's a safety decision.

**Key realization:** this isn't a new architecture problem. It's the same
pattern as `insert_text`, repeated — new local MCP tools
(`click_at(x, y)`, `move_file(src, dest)`, `open_folder(path)`, etc.),
backed by `nut-js` the same way `insert_text` already is, wired in via
`--mcp-config` the same way. Because these run through the real CLI process
(not the SDK), each tool call gets the CLI's existing permission prompt for
free — Anthropic's own hardened approval flow, not something Clance has to
build from scratch for the highest-stakes actions in the whole app.

**What's genuinely unsolved (product work, not engineering):**
- A yes/no prompt per individual click is probably too granular to be
  usable for a multi-step "move these files around" task, but
  auto-approving a click-capable agent is obviously too risky. Needs real
  design — maybe a preview/dry-run of what's about to happen, a narrower
  default tool set that expands deliberately, something in that shape. Not
  designed yet.
- General class of risk is different from anything currently in the app:
  irreversible real-world actions (sending a message, deleting something,
  buying something) triggered by the model's read of a screenshot.

## Where things stand — solved vs. open, one list

**Solved / confirmed today:**
- [x] Real image content blocks can reach an attached CLI session via
  clipboard + `Ctrl+V` pty injection — no SDK needed, no path-guessing.
- [x] The core architecture (CLI-terminal backend, MCP tools as the
  extension point, native permission prompts as the safety net) holds up
  for the full "click things, move files" vision, not just today's
  text/insert_text scope.
- [x] Computer-use-style tools (`click_at`, `move_file`, etc.) are an
  extension of an already-working pattern, not a new subsystem.

**Decided (recommendation, not yet implemented):**
- [ ] Quick Ask hotkey, SDK-backed, scoped to read-only Q&A + `insert_text`
- [ ] Escalation via seed-a-new-real-session, never hand-rolled JSONL
- [ ] Riskier/broader tool use (including any future computer-use tools)
  stays on the CLI-terminal backend, not the SDK

**Genuinely open:**
- [ ] Safety/approval UX for autonomous screen actions (click, file move) —
  no design yet, flagged as real product work
- [ ] Whether Anthropic's API supports true real-time duplex audio/video
  streaming at all today — unverified, don't assume yes
- [ ] Local speech-to-text engine for dictation (pre-existing open question,
  unrelated to the duplex-streaming tangent above — don't conflate them)
- [ ] `design.md` needs a correction pass: the separate picker-popup hotkey
  is deprecated/merged into the main widget, and the multimodal
  context-injection section needs updating with the Ctrl+V finding above
- [ ] Pre-existing open questions from `design.md` untouched by this
  conversation: exact CLI JSONL schema, folder/config conventions for
  skills/tools/MCP, how much of the settings UI ships in v1,
  `src/shared/markdown.js` dead-code cleanup

## Next steps (as of this conversation)

1. Update `design.md`: picker-popup deprecation correction, multimodal
   Ctrl+V mechanism replacing the path-text approach.
2. Spec the escalation trigger for Quick Ask → real session (explicit
   button only, or does the SDK path also detect "this wants tool use" and
   prompt to escalate?).
3. Design the approval UX for computer-use-style tools before building any
   of them — this is the one piece with no shape yet at all.
4. If/when real-time duplex streaming becomes a real ask: separate
   requirements conversation, starting with confirming what Anthropic's API
   actually supports today.
