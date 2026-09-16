---
title: Requirements
tags: [clance, requirements]
status: draft
---

# Requirements

## Scope for v1

**In scope:**

- macOS only, Apple Silicon
- Electron + Node.js
- Global hotkey opens a popup widget
- Free-text goal input (open-ended, not fixed actions like "Rewrite"/"Explain")
- Dictation — speak instead of typing, anywhere in macOS, not just into
  Clance (local speech-to-text; see `docs/dictation.md`)
- No screen content — window title, selection, or screenshot — is captured
  or described to the model automatically at invocation anymore (revisited
  2026-09-14; see §"Screen context capture"). Instead, every popup session
  gets a static system prompt (baked in invisibly at mint time) telling it
  about its on-demand `look_at_screen`/`read_selection`/`list_open_windows`
  tools (see `docs/design.md` §"Local tools server") and when to reach for
  them, offloading "what's actually on screen right now" entirely to the
  model calling a tool when it needs to know — rather than front-loading a
  snapshot that's often irrelevant and immediately stale. `Cmd+Shift+R`
  still explicitly re-captures everything, screenshot included,
  mid-conversation (see `docs/design.md` §"Context injection"). When a
  screenshot rides in (via that refresh, or a `look_at_screen` tool call),
  it reaches the CLI as a real image content block via clipboard + pty
  injection (refresh) or a normal MCP tool result (the tool call) — not an
  SDK call and not a path it has to `Read()`.
- The real Claude Code CLI, embedded as a terminal (`node-pty` + `xterm.js`)
  and run as a real child process, handles all reasoning/looping/UI
  rendering — **supersedes the original Claude Agent SDK plan**, see
  `docs/design.md` §"Terminal-embedding architecture" for why
- ~~Two response modes: **type it out** (inject text into the focused app)
  and **talk back** (respond conversationally in the popup, no
  injection)~~ — **removed.** There is no more app-mediated
  propose/accept/reject text-injection flow; a Clance-launched session is
  just a normal terminal-based Claude Code session
- Multi-turn conversations *within one open* — the popup keeps context
  turn-to-turn while it's open, but every hotkey-open starts a brand new
  conversation (see §"Multi-turn conversations" — this reverses the
  originally-planned "reopen continues last session" behavior)
- In-app chat history view (all past conversations, browsable, resumable)
- Session storage compatible with Claude Code CLI's format, so a session
  started in this app can be resumed via `claude` in the terminal, and
  vice versa
- A pluggable extensibility layer (skills, tools, MCP servers, hooks,
  subagents — see §4.8) — now met almost incidentally, since every
  Clance-launched session is a real CLI process reading `~/.claude/`
  conventions natively; Clance's own toggle UI over this is a real gap,
  see §"Extensibility layer"
- **Packaged and signed** (supersedes "no notarization/permission-hardening
  yet") — `electron-builder` produces a stable-identity signed `.app`,
  installed to `/Applications` even for dev use, because the raw dev
  Electron binary's TCC permission flakiness made manual-grant-during-dev
  unworkable in practice. Full notarization for real distribution is still
  out of scope.

**Explicitly out of scope for v1:**

- Full notarization for distribution (`npm run dist` produces a signed but
  unnotarized build; notarization — Apple ID/App Store Connect API key,
  `notarytool` — is not wired up)
- Windows/Linux support
- Ambient/background screen watching
- Cloud sync of any kind
- A built-in plugin marketplace/installer UI (the extensibility *mechanism*
  ships in v1; a discoverable marketplace/UI for installing others' plugins
  is later)
- Shipping a large bundled library of first-party skills/tools beyond a
  couple of examples (the point of v1 is that the community can add their own)

## Core user flow

1. User presses global hotkey from anywhere on macOS
2. Small popup widget appears (spotlight-style) with a text input
3. User types or dictates their goal in natural language (e.g. "reply to
   this email politely declining", "summarize what's on my screen", "fill
   this form with my address")
4. The app captures the frontmost window (just enough to know where
   `insert_text` and friends should default to acting, see §"Screen context
   capture") and mints a session — no screenshot, no selection read, no
   description of any of it handed to the model
5. An embedded terminal opens running the real `claude` CLI as a child
   process — the goal isn't sent separately; the user types/talks to the
   CLI directly inside that terminal, same as any Claude Code session
6. A static system prompt, identical every time, rides in invisibly via
   `--append-system-prompt` telling the model about its on-demand
   screen/selection/window tools and when to use them — see
   `docs/design.md` §"Context injection"
7. Claude Code's own CLI handles everything from here: reasoning, tool
   use, rendering, permission prompts. Text injection into other apps (if
   the user wants it) happens however it would in any terminal-based
   Claude Code session — there is no app-level propose/accept flow anymore
8. The CLI itself writes the session transcript (JSONL, its own native
   format) — Clance never writes session files
9. The terminal session persists exactly as long as the user keeps it
   open/running — the popup's one hotkey always opens a fresh
   terminal/session; its "Open in…" dropdown resumes or attaches to an
   existing one instead, in place, without a separate hotkey
10. User can reopen the app's Chats tab to browse any past session
    (Clance's own or any real Claude Code CLI session on the machine) and
    open it as a resumed terminal tab

## Functional requirements

### Hotkey & activation

- Global hotkey listener (Electron `globalShortcut`), works regardless of
  focused app
- Configurable hotkey binding
- Popup appears near cursor or centered (spotlight-style), always-on-top,
  transparent background

### Dictation

- ✅ Implemented 2026-09-16 (Phases 0–2 of `docs/dictation.md`). Global
  shortcut (`⌥D` by default) → non-focusable recording HUD → on-device
  whisper.cpp transcription → pasted at the cursor in whatever app was
  frontmost, with every transcript kept in a SQLite database and browsable,
  searchable, and re-insertable from a new Dictation tab. **Two caveats:**
  hold-to-talk isn't possible with Electron's `globalShortcut` (no key-up
  event) so it's press-to-start/press-to-stop for now, and accuracy has
  only been validated against synthesized speech so far.
- **Scope decided 2026-09-16, and it widened:** dictation is not a
  terminal-input feature. It's a *system-wide* one — a global shortcut
  anywhere in macOS records, transcribes locally, and types the transcript
  into whatever app was already frontmost (Wispr Flow / superwhisper
  shaped), plus a Dictation tab in the main window holding every past
  transcript in an on-disk SQLite database. That sidesteps the question
  this section was parked on ("how does dictation map onto a terminal's
  stdin?") rather than answering it: the transcript is pasted into the
  frontmost app, and Clance's own terminals are just one such app, with
  no special-casing.
- Local speech-to-text remains the plan — no audio sent to any cloud
  service, consistent with the local-first principle. **Engine resolved:**
  whisper.cpp running ggml models, with a model catalog Clance recommends
  from based on detected machine specs and installs on demand. See
  `docs/dictation.md` for why, and for the alternatives rejected.

### File drag-and-drop

- ✅ implemented. Dropping a file (a screenshot, most commonly) onto either
  terminal surface (popup or a main-window terminal tab) resolves its real
  filesystem path (`webUtils.getPathForFile`, exposed from the preload
  scripts — `File#path` no longer exists in the renderer as of this
  Electron version), **copies it immediately into `~/.clance/dropped-files/`
  (`src/main/dropFiles.ts`)**, and pastes the copy's path into the CLI's
  input as unsubmitted bracketed-paste text, the same technique used for
  context injection — the user can add a prompt around it before hitting
  Enter, and the CLI reads the file itself via its own Read tool.
- The eager copy exists because a file dragged from macOS system UI (e.g.
  the floating screenshot thumbnail) is often only a **file promise**
  (`NSFilePromiseProvider`), not a real file — Chromium's HTML5 drag-and-drop
  (all Electron exposes) doesn't implement Apple's promise-resolution
  protocol, so what resolves is a transient staging copy under
  `TemporaryItems/NSIRD_screencaptureui_.../` that can vanish moments after
  the drop. Copying it out immediately, before the CLI ever tries to read
  the original path, is the only mitigation available at this layer — it's
  a race, not a guarantee; if the source is already gone by drop time, the
  copy (and thus the paste) is silently skipped.
- This is the answer to "I'm driving Clance's own development through a
  Clance terminal and can't drag a screenshot to Claude" — no separate
  upload/attachment mechanism, just a real (now Clance-owned) path handed
  to the CLI the same way any typed path would be.
- The popup surface also needed a fix here beyond the drop handler itself:
  it hides on window blur, and starting an OS drag from Finder shifts key
  window focus to Finder first, hiding the popup out from under the drag
  before it could ever land. Blur now waits ~500ms before hiding, cancelled
  by regaining focus or by the renderer reporting an active drag/drop
  (`popup:hold-open` IPC). See `docs/design.md` for the mechanism.

### Screen context capture

- **Revisited 2026-09-14: a plain hotkey-open no longer captures or
  describes any screen content to the model at all.** It used to capture
  the frontmost window's title and any highlighted selection and fold both
  into the request context on every invocation; now the only thing invocation
  still captures is the frontmost window itself (not its title as text, and
  nothing handed to the model) — purely so `insert_text`/`click_at`/
  `activate_app`/`clear_focused_field`/`replace_focused_field` have
  something to default-target when the model doesn't pass an explicit
  `app` (see `docs/design.md` §"Context injection"). Selection and screen
  content are offloaded entirely to the model's own on-demand
  `read_selection`/`look_at_screen`/`list_open_windows` tools (see
  `docs/design.md` §"Local tools server"), called only when actually
  needed rather than front-loaded on every open. A static system prompt,
  identical across every session, tells the model these tools exist and
  when to reach for them — it doesn't (and can't) describe anything
  specific to this particular invocation.
- **`Cmd+Shift+R` mid-conversation is the one remaining path that captures
  and hands over a full snapshot** — frontmost window title, current
  selection, and a screenshot, all at once (see `docs/design.md`
  §"Context injection", "Refreshing context mid-conversation"). This is
  still an explicit, user-triggered action, typed/pasted visibly into the
  terminal so it's part of the conversation the same way anything else the
  user adds is.
  - The screenshot piece of a refresh is saved to `~/.clance/screenshots/`
    and delivered to the CLI as a real image content block (clipboard + a
    `Ctrl+V` byte written into the pty), not a path it has to `Read()`
    itself — this predates and is unrelated to the 2026-09-14 change above
    (see `docs/design.md`'s 2026-09-12 note on why a screenshot was already
    dropped from automatic invocation capture before selection/title were).
  - The widget's "Open in…" dropdown (switching to a *different* existing
    session) types nothing in at all — no fresh capture, and no reuse of
    whatever a refresh or the original mint happened to know, since the
    session being switched to already has its own tools and history; see
    `docs/design.md`'s "Open in… dropdown" section.
- Read-only and on-demand — never persistent/background capture, unchanged
  from the original plan
- Accessibility-tree / focused-element content read is still deferred — a
  model-called `read_selection` tool (simulated copy, not the accessibility
  tree) has been sufficient so far; revisit if it proves insufficient for
  structured-app goals

### Claude Code CLI integration (supersedes "Claude Agent SDK integration")

- ✅ implemented, replacing the originally-planned direct Claude Agent SDK
  embedding. The real `claude` CLI binary runs as a child pty process
  (`node-pty`), rendered via an embedded `xterm.js` terminal — see
  `docs/design.md` §"Terminal-embedding architecture" for why this
  replaced the SDK approach and what it changed.
- All reasoning, tool use, streaming, and rendering is the CLI's own —
  Clance no longer parses SDK message events or renders any response UI of
  its own.
- Screen context reaches the CLI without the SDK: a refresh's screenshot as
  a real image content block (clipboard + pty injection), everything else
  via the model's own on-demand tool calls — see `docs/design.md`
  §"Context injection".

### Response modes (removed — superseded by the terminal pivot)

- ~~**Talk back** / **Type it out**~~ — the old app-mediated
  propose/accept/reject text-injection flow (model-decided, with a custom
  `proposeText` tool and keystroke-injection-on-accept) is gone and stays
  gone. What replaced it: an `insert_text` **MCP tool**, part of the local
  tools server every Clance-minted or -revived session gets (a fresh
  hotkey-open, the main window's "New Chat," or reviving a dormant session
  — see `docs/design.md` §"Local tools server"), that types text into
  whatever app was frontmost when the *popup* specifically was opened (the
  only entry point that captures a frontmost-window target at all — see
  §"Screen context capture" above), or an explicit `app` hint otherwise.
  The model decides when to call it, the same way it decides to call any
  other tool; there's no app-level accept/reject step. A session that's
  already *live* as a background agent can't gain this after the fact
  (see `docs/design.md` §"Local tools server"), and Clance still doesn't
  mediate text delivery for plain talking in the terminal — same as any
  terminal-based Claude Code session.

### Multi-turn conversations

- A terminal session's conversation lifetime is now just the lifetime of
  its underlying `claude` process/session, the same as any terminal-based
  Claude Code usage — there is no separate app-level "conversation state"
  to reason about anymore.
- **One hotkey opens a new session; an in-widget dropdown resumes one.**
  `Option+Space` opens a fresh terminal running a brand-new `claude`
  session (no `--resume`) — there is no separate hotkey for resuming
  anymore (an earlier "Continue a Conversation" hotkey/searchable-picker
  mode was removed in favor of this). Instead, the widget's toolbar has an
  "Open in…" button that opens a small anchored dropdown (search + list,
  not a full mode swap) over the current conversation; picking a session
  from it opens a terminal that resumes (or attaches to, if it's a live
  background agent — see `docs/design.md` §"Attach vs. resume") that
  session in place, with nothing typed into the terminal input on the way
  in — the session picked already has its own tools and history, so there's
  no fresh context to hand it (see `docs/design.md`'s "Open in… dropdown"
  section).
- **A session can also be continued directly from the main window's Chats
  tab** — clicking a session row opens the same kind of resumed/attached
  terminal tab, just without the popup's screen-context capture (there's
  no "just invoked from where" moment when opening from a persistent
  window's session list).
### Session storage (Claude Code-compatible — now trivially true, not app-maintained)

- ✅ Sessions are resumable both directions, but not because Clance writes
  compatible JSONL — **Clance never writes session files at all now.**
  Every session is a real `claude` CLI process, so it writes its own
  transcript in its own native format, in its own location
  (`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`). Compatibility
  is structural, not a format Clance has to keep in sync by hand.
- A Clance-launched session's `cwd` is no longer unconditionally
  `~/.clance/` — see `docs/working-directory-design.md` (implemented): a
  configurable default directory (Settings), a directory picker in the
  widget's "Open in…" dropdown for minting a session elsewhere, and a
  resumed/attached session always inherits its own recorded `cwd` off its
  transcript rather than any Clance-side default. `~/.clance/` remains the
  pseudo-project bucket only for sessions that never had a real project
  directory to use — the fallback, not the rule. The storage path itself
  is still purely a function of the CLI process's own `cwd`, not something
  Clance writes.
- Sessions started in a bare terminal (any real `claude` invocation
  anywhere on the machine) are already visible in Clance's own chat
  history browser — full compatibility, not "in principle."

### In-app chat history

- ✅ implemented. A session list (most recent first, grouped by day, in
  the main window's Chats tab) covering both Clance's own sessions and
  real Claude Code CLI sessions from any project on the machine.
- Click a session to open it as a **resumed/attached terminal tab**, not a
  rendered transcript view — the CLI renders its own history when a
  session resumes. This supersedes the earlier "live chat rendered inside
  a closable tab" design (`ChatDetailSection`), which no longer exists —
  see `docs/design.md` §"Main window Chats tab".
- Since storage is JSONL-based (written by the CLI, not Clance), the
  session-list scan is still a JSONL reader, not a separate SQLite-driven
  index.
- Full details in `docs/superpowers/specs/2026-09-07-chat-history-design.md`
  — note that spec's UI section describes the since-superseded
  `ChatDetailSection`; its data-layer description (`chatHistory.ts`'s
  session listing) is still accurate.
- **Archiving, not deleting.** An "Active"/"Archived" toggle plus a
  per-row archive/restore action lets a session be hidden from the default
  list — see `docs/design.md` §"Session archiving". No permanent-delete
  action exists: the listed sessions include real Claude Code CLI history
  from any project on the machine, not just Clance's own, so deleting the
  underlying transcript file is out of scope for a "clean up my Clance
  sessions" feature.

### Extensibility layer (plugins, skills, MCP, hooks)

Goal, updated for the terminal pivot: the app stays minimal — a shell,
screen capture, context injection, and session launching — while all
*capability* comes from the Claude Code CLI's own extension points, since
every session Clance opens is a real CLI process rather than an app-owned
SDK query.

- **Skills** — ✅ works, but not through anything Clance manages at
  request-time. Every Clance-launched CLI session reads `~/.claude/skills/`
  itself, exactly like any other `claude` invocation — no app-level plumbing
  needed for this to work at all. The Skills & Plugins section's "Skills"
  tab is a **read-only** list of what's installed there (2026-09-14 — see
  "Config surface" below for why it's not a toggle).
- **MCP servers (external)** — ✅ works, and (2026-09-14) Clance's own
  enable/disable toggle for these now has a real effect on a launched
  session, not just on-disk config with nothing reading it.
- **Config surface — resolved for MCP servers and Custom Tools; Skills
  stays read-only by design, not a gap.** This used to be a real bug for
  both Skills and MCP servers: the Skills & Plugins section listed both
  with enable/disable toggles (`src/main/skills.ts`, `src/main/mcpConfig.ts`,
  writing to `~/.clance/mcp.json`'s per-entry `enabled` flag) that wrote
  real config **nothing read when launching a terminal session** — the
  `agent.ts` `query()` call that used to consume it was deleted along with
  the Agent SDK, and nothing replaced it. Fixed 2026-09-14, differently for
  each:
  - **MCP servers:** `mcpConfig.ts`'s `getActiveMcpServers()` (already
    written, previously unused) is now merged into the same `--mcp-config`
    JSON every Clance-minted session already gets for its local tools (see
    `docs/design.md` §"Local tools server") — toggling a server off in
    Settings now genuinely keeps it out of a launched session, the same way
    the Custom Tools toggles already worked.
  - **Skills:** stays **read-only**, on purpose — `claude --help` confirms
    there's no per-skill enable/disable flag, only `--disable-slash-commands`
    (all skills at once). A toggle with no way to actually take effect is
    the exact bug being fixed here, not something to keep in a different
    form, so the per-skill `Toggle` was removed rather than left
    non-functional; managing what's available is done the same way a bare
    `claude` session does it — add/remove a folder under
    `~/.claude/skills/`. `enabledSkills` (config.ts) and `setSkillEnabled`
    (skills.ts) were removed along with it, not just hidden in the UI.
  - **The "Custom Tools" tab's own toggles never had this gap** — each one
    genuinely gated whether the CLI could call that tool at all, checked
    fresh at every mint, since the day it shipped (see
    `docs/design.md` §"Local tools server").
- **Custom tools** — ✅ a first "computer use" tool set: `insert_text`,
  `list_open_windows`, `look_at_screen` (on-demand screenshot, returned as
  a real image), `read_selection`, `activate_app`, `click_at` (fractional
  screen coordinates), and two destructive field-editing tools
  (`clear_focused_field`/`replace_focused_field`) — see `docs/design.md`
  §"Local tools server" for the full list and mechanism. Multi-step
  computer-use (opening apps, clicking around, multi-app workflows) is
  confirmed **not out of scope**, consistent with "Clance stays the
  context provider + session launcher, never the execution engine itself"
  in `docs/background.md` §"Why this exists" — these tools are exactly
  that: Clance still isn't the one deciding *when* to act, only exposing
  the primitive.
  - **Approval tiering, not a Clance-built permission UI**: only read-only
    tools plus `click_at` are pre-authorized via `--allowedTools` (no
    per-call prompt) — `click_at` never redirects to an app the user
    didn't already have on screen. `insert_text`, `activate_app`, and the
    two destructive field-editing tools are deliberately left off that
    list, so the CLI's own native "Allow / Deny / Always allow" prompt
    still gates each of them. See `docs/design.md`'s "Local tools server"
    for why this split, and `docs/sep10talks.md` for the approval-UX
    question it resolves for this tool set specifically (a broader
    multi-step computer-use agent may still need more than this).
  - Precise, semantic targeting ("click *this* input box," not a
    coordinate) still needs the accessibility-tree read this app has
    deferred since the start — `click_at` is coordinate-based (the model
    grounds it visually from a screenshot) as the pragmatic substitute,
    not a replacement for that eventual capability.
  - **Per-tool on/off toggle, in Skills & Plugins' "Custom Tools" tab** —
    unlike approval tier (fixed per tool, not user-configurable), whether
    a tool is offered *at all* is: off means `--disallowedTools` blocks
    the CLI from calling it outright, not merely "requires approval."
    Defaults to all on (opt-out) — these are Clance's own first-party
    tools, not arbitrary third-party skill instructions, so there's no
    "not vetted for this" concern to opt into. Checked fresh at mint time
    (`localToolsServer.ts`'s `listLocalTools()`), same as everything else
    about this tool set.
  - **The server backing these tools is visible in the "MCP Servers" tab
    too, with a live health check** — it's Clance's own infrastructure
    (not something from `~/.clance/mcp.json`), so it's shown separately
    from user-configured servers: running/not-yet-started status, and a
    "Check Health" button that sends a real MCP `initialize` request
    through the exact path a launched session uses, to tell a broken
    server apart from a CLI-config problem when a tool call fails. See
    `docs/design.md` §"Local tools server".
  - **Not just the popup hotkey path** — every real `claude --bg` mint
    gets these tools now (main window "New Chat", reviving a dormant
    session from Chats/"Open in…"), not only a brand-new hotkey-opened
    session. The one CLI-imposed exception: a session that's already
    *live* as a background agent can't gain tools it wasn't minted with —
    `attach` connects to an already-running process and accepts no other
    flags, same limitation `--system-prompt-snapshot` already has (see
    `docs/design.md` §"Local tools server").
- **Hooks** — still not implemented. Deferred, unchanged.
- **Subagents** — still not implemented. Deferred, unchanged.
- **Compatibility goal** — met for Skills and MCP servers in the sense
  that matters most now: a real `claude` session picks them up natively,
  with zero Clance-specific format translation required.

*Example scenario this should support:* a community member wants Clance
sessions to be able to create Obsidian canvases. They write an MCP server
(or a skill) that exposes that capability, drop its config into the
appropriate `~/.claude/` folder, and any Clance-launched terminal session
picks it up automatically — no PR to the core app required, and (unlike
the toggle-managed path above) no Clance-specific wiring needed at all.

### System presence

- Dual presence: a menu-bar (tray) icon for the quick-access popup, plus a
  permanent Dock icon for the full main application window (Chats, Skills
  & Plugins, Settings) — reachable via the Dock icon or the tray's "Open
  Dashboard" item. This replaces the originally-planned tray-only, no-Dock
  behavior.
- The main window uses a tab-based navigation model: a floating top-right
  launcher cluster (not a sidebar — see `docs/design.md`'s "Main
  application window") opens a section (Sessions/Skills & Plugins/
  Settings) or a new plain terminal tab; a past conversation opens from
  the Sessions section itself. Opening something adds a closable tab, and
  each pane's own tab bar is the primary way to switch between what's
  open — panes are independently resizable/splittable, up to four at
  once. Reopening an already-open section activates its existing tab
  rather than duplicating it; there is no longer a user-facing preference
  for this. See `docs/design.md`.
- Cmd+Q now quits the entire app (tray, popup, and main window together),
  via the app menu's Quit role — previously there was no real "app" to
  quit since it ran tray-only. Closing just the main window does not quit
  anything; the tray and popup keep running until Cmd+Q (or Quit from the
  tray menu) is used.
- Launch on login (optional toggle) — implemented as a live-read/live-set
  toggle in Settings using Electron's `app.getLoginItemSettings()` /
  `setLoginItemSettings()`; not duplicated into Clance's own config since
  the OS already persists it
- Minimal resource footprint while idle
- **Packaged as a signed `.app` (supersedes "no notarization, raw dev
  binary" plan)** — `electron-builder` produces a stable-identity, signed
  `Clance.app` (Developer ID or ad-hoc), installed to `/Applications`. Not
  notarized yet (real distribution — `npm run dist` — would need that; dev
  use doesn't). This wasn't optional polish: the raw dev Electron binary
  shared TCC permission grants with every other Electron project on the
  machine and lost them on every rebuild, which made Screen
  Recording/Accessibility grants unusable in practice during development.
  See `docs/design.md` §"Packaging & macOS permissions".

### First-run setup

- The app is fully gated behind a first-run setup wizard — no global
  hotkey, no popup functionality — until three sequential steps are
  satisfied: connecting the user's Claude plan, granting macOS Screen
  Recording + Accessibility permissions, and confirming a keyboard
  shortcut. The main window opens itself automatically on launch whenever
  setup is incomplete, rather than requiring the user find their way to
  the Dock icon or tray item first.
- Connecting a Claude plan requires the `claude` CLI to be installed
  separately (the wizard links to install instructions if it's missing)
  — Clance does not bundle or reimplement Claude's OAuth login itself,
  delegating entirely to `claude auth login`/`claude auth status`.
- The wizard's chosen shortcut binding (and a `shortcutsConfigured` flag)
  persist to `~/.clance/config.json`, a second local config file alongside
  the existing session-id file. Auth and permission status are never
  persisted as a "done" flag — both are re-checked live on every launch
  and every visit to Settings, since either can change outside the app
  (logging out of Claude, revoking a permission in System Settings).
- The same three checks resurface permanently in the Settings section as
  an ongoing status/reconnect panel, not just during first-run setup.

## Non-functional requirements

- Latency: a Clance-launched terminal should show the CLI's first output
  within ~1-2s of the session starting — mechanism changed (terminal boot
  + CLI startup, not an SDK stream-start), but the target is the same
- Privacy: no screen content is captured automatically at all anymore — only
  on an explicit `Cmd+Shift+R` refresh, or the model's own on-demand tool
  call (`look_at_screen`/`read_selection`/`list_open_windows`), both
  user/model-initiated rather than front-loaded on every open. A screenshot
  is saved to disk (`~/.clance/screenshots/`, not held only in memory the
  way the old in-memory base64 approach did) and read by the CLI only if it
  chooses to; only the resulting session transcript (written by the CLI
  itself) persists long-term
- ~~Reliability: failed injection should never lose the model's output
  (always recoverable via clipboard/chat history)~~ — **removed**, no
  app-mediated injection exists to fail; the CLI's own output is always in
  its own transcript/terminal scrollback regardless
- No persistent screen recording or ambient capture of any kind — unchanged
- macOS Apple Silicon only — no Intel Mac support required — unchanged

## Success criteria for v1

- Hotkey reliably opens the popup (an embedded terminal) from any app, any
  time
- Every popup session gets the same static, invisible system prompt at
  mint time telling it about its on-demand screen/selection/window tools
  (`--append-system-prompt`, baked into both fresh mints and pool spares —
  see `docs/design.md` §"Context injection"). No window title, selection,
  or screenshot is captured or described automatically anymore; a
  screenshot rides in only via `Cmd+Shift+R` or the model's own
  `look_at_screen` tool call, as a real image either way
- ~~Text injection works in at least one real target app~~ — **removed**,
  no longer an app-owned feature to validate
- ✅ Dictation implemented 2026-09-16, and scoped wider than this
  criterion assumed (system-wide, not Clance-only) — see
  `docs/dictation.md`. Pending real-voice accuracy validation.
- ✅ A session created via Clance is resumable in a bare `claude`
  terminal, and vice versa — structurally guaranteed now (every session
  is a real CLI process), not just "in a format that could support this"
- ✅ Both new-session and resume/attach flows work reliably: `Option+Space`
  opens a clean new session every time; the widget's "Open in…" dropdown
  resumes or attaches to an existing one without surfacing the CLI's
  "already running as background agent" error to the user (see
  `docs/design.md` §"Attach vs. resume")
- Chat history view accurately shows all past sessions (Clance's own and
  any real CLI session on the machine), opening each as a resumed terminal
  tab
- ⚠️ At least one third-party capability (a skill or MCP server not built
  by the core team) works in a Clance-launched session — **true almost by
  construction now** (any real `claude` session reads `~/.claude/skills/`
  and MCP config natively), but Clance's own Skills & Plugins toggle UI
  does *not* currently gate this (see the Extensibility layer gap above) —
  so this criterion is met at the CLI level, not yet at the
  Clance-config level
- Everything works fully offline except the actual Claude API call
- ~~Graceful fallback (clipboard) when permissions aren't granted or
  injection fails~~ — **removed**, no injection path exists; Screen
  Recording permission being ungranted just means context injection is
  missing the screenshot line (window title still comes through), not a
  failure mode needing a fallback
