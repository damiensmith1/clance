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
- Dictation — speak your goal instead of typing it (local speech-to-text)
- Screen content capture at time of invocation (screenshot + frontmost
  window title + any highlighted/selected text; handed to the CLI as
  text/file-path context — not sent as an SDK image content block; see
  §"Screen context capture") as context for the request
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
4. App captures current screen (a screenshot, saved to disk) and the
   frontmost window's title as context
5. An embedded terminal opens running the real `claude` CLI as a child
   process — the goal isn't sent separately; the user types/talks to the
   CLI directly inside that terminal, same as any Claude Code session
6. Context reaches the CLI either invisibly (new sessions, via
   `--append-system-prompt`) or as visible typed terminal input (resumed
   sessions) — see `docs/design.md` §"Context injection" for why the two
   paths differ
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

- ❌ Not implemented. Predates the terminal-embedding pivot — a "populate a
  text input" model doesn't map directly onto a terminal's stdin the way it
  did onto the old custom input field, so this needs a fresh look at how
  dictation should work against an embedded terminal (push-to-talk that
  writes to the pty? a separate always-available field that feeds the pty
  once transcribed?) before implementing. See `docs/design.md`'s open
  questions.
- Local speech-to-text (e.g. Whisper running locally) remains the plan —
  no audio sent to any cloud service, consistent with the local-first
  principle. Engine choice still unresolved (see `docs/design.md`).

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

- On invocation, capture:
  - A screenshot of the active display nearest the cursor, saved to
    `~/.clance/screenshots/` — the CLI is told the file **path**, not
    handed raw image bytes directly, and reads it itself via a normal tool
    call if relevant to what the user asks
  - The frontmost window's title (`@nut-tree-fork/nut-js`) — a lighter
    substitute for the originally-planned accessibility-tree read, not a
    full structured-content dump
  - Whatever text was highlighted/selected in the frontmost app, if any
    (simulated Cmd+C, read back off the clipboard — see `docs/design.md`
    §"Highlighted-selection capture"), folded into the request context with
    an instruction to treat it as the primary subject of the request.
    Captured both when the hotkey opens a brand-new session and when the
    widget's "Open in…" dropdown switches to an existing one; delivered
    invisibly for the former, typed visibly into the terminal for the
    latter — same split as the rest of this section's context.
- Read-only and on-demand — never persistent/background capture, unchanged
  from the original plan
- Accessibility-tree / focused-element content read is still deferred —
  window title (and now selected text, via simulated copy rather than the
  accessibility tree) has been sufficient so far; revisit if it proves
  insufficient for structured-app goals

### Claude Code CLI integration (supersedes "Claude Agent SDK integration")

- ✅ implemented, replacing the originally-planned direct Claude Agent SDK
  embedding. The real `claude` CLI binary runs as a child pty process
  (`node-pty`), rendered via an embedded `xterm.js` terminal — see
  `docs/design.md` §"Terminal-embedding architecture" for why this
  replaced the SDK approach and what it changed.
- All reasoning, tool use, streaming, and rendering is the CLI's own —
  Clance no longer parses SDK message events or renders any response UI of
  its own.
- Screen context (screenshot path + frontmost window title) is handed to
  the CLI as text, not as an SDK image content block — see
  `docs/design.md` §"Context injection".

### Response modes (removed — superseded by the terminal pivot)

- ~~**Talk back** / **Type it out**~~ — the old app-mediated
  propose/accept/reject text-injection flow (model-decided, with a custom
  `proposeText` tool and keystroke-injection-on-accept) is gone and stays
  gone. What replaced it: an `insert_text` **MCP tool**, offered only to
  hotkey-opened ("new session") popup invocations, that types text into
  whatever app was frontmost when the popup opened — see
  `docs/design.md` §"Text-insertion tool (`insert_text`)". The model decides
  when to call it, the same way it decides to call any other tool; there's
  no app-level accept/reject step. For every other flow (a resumed session
  opened via the widget's "Open in…" dropdown, or just talking in the
  terminal), Clance still doesn't mediate text delivery — same as any
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
  session in place, with context typed visibly into the terminal input
  rather than injected invisibly (see `docs/design.md` §"Context injection"
  for why resumed sessions need a different delivery path than new ones).
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
- Clance-launched sessions run with a fixed pseudo-`cwd`
  (`~/.clance/`, see `src/main/paths.ts`), so they land under one stable
  `~/.claude/projects/<encoded ~/.clance>/` bucket — this was decided
  before the terminal pivot and still holds, since the CLI process itself
  (not Clance) is what determines the storage path from its `cwd`.
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
  needed for this to work at all.
- **MCP servers (external)** — ✅ works the same way: a launched session
  reads its own project/user `.mcp.json` independently.
- **Config surface — ⚠️ real gap, not resolved.** The Skills & Plugins
  section still lists Skills and MCP servers with enable/disable toggles
  (`src/main/skills.ts`, `src/main/mcpConfig.ts`, writing to
  `~/.clance/mcp.json`'s per-entry `enabled` flag), but **nothing currently
  reads that toggle state when launching a terminal session** — the
  `agent.ts` `query()` call that used to consume it was deleted along with
  the Agent SDK. The UI still writes real config; it just has no observed
  effect on what a Clance-launched session can use. Needs a decision (see
  `docs/design.md` open questions): wire the toggles into the launch args
  (e.g. `--strict-mcp-config`/`--mcp-config` for MCP; skills have no
  obvious CLI-level enable/disable flag to hook), or scope the toggle UI
  down to "informational only," or drop it.
- **Custom tools** — first one implemented: `insert_text` (types into the
  frontmost app), see `docs/design.md` §"Text-insertion tool (`insert_text`)".
  Click/screenshot-on-demand primitives are still not implemented. Planned
  direction unchanged beyond that: multi-step computer-use (opening apps,
  clicking around, multi-app workflows) is **not out of scope** — expected
  to arrive as further MCP tool(s) a Clance-launched CLI session calls
  itself, consistent with "Clance stays the context provider + session
  launcher, never the execution engine itself" in `docs/background.md`
  §"Why this exists".
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
- The main window uses a tab-based navigation model: the sidebar lists
  what can be opened (a section, or a past conversation from Chats) but
  doesn't itself switch content — opening something adds a closable tab,
  and the tab bar is the primary way to switch between what's open. A
  "Tab Behavior" preference controls whether reopening an already-open
  item reuses its tab or opens a duplicate. See `docs/design.md`.
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
- Privacy: screen content is only captured at the moment of invocation,
  saved to disk (`~/.clance/screenshots/`, not held only in memory the way
  the old in-memory base64 approach did) and read by the CLI only if it
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
- Screen context (screenshot + frontmost window title) is captured and
  reaches the CLI correctly for both new and resumed sessions — for new
  sessions, invisibly; for resumed sessions, as visible typed terminal
  input (see `docs/design.md` §"Context injection")
- ~~Text injection works in at least one real target app~~ — **removed**,
  no longer an app-owned feature to validate
- ❌ Dictation not yet implemented — still an open item, not yet a met
  success criterion
- ✅ A session created via Clance is resumable in a bare `claude`
  terminal, and vice versa — structurally guaranteed now (every session
  is a real CLI process), not just "in a format that could support this"
- ✅ Both new-session and resume/attach flows work reliably: `Option+Space`
  opens a clean new session every time; the picker resumes or attaches to
  an existing one without surfacing the CLI's "already running as
  background agent" error to the user (see `docs/design.md` §"Attach vs.
  resume")
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
