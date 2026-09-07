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
- Screen content capture at time of invocation (screenshot → vision, and/or
  accessibility-tree read of frontmost app) as context for the request
- Claude Agent SDK handles reasoning/looping
- Two response modes: **type it out** (inject text into the focused app) and
  **talk back** (respond conversationally in the popup, no injection)
- Multi-turn conversations *within one open* — the popup keeps context
  turn-to-turn while it's open, but every hotkey-open starts a brand new
  conversation (see §"Multi-turn conversations" — this reverses the
  originally-planned "reopen continues last session" behavior)
- In-app chat history view (all past conversations, browsable, resumable)
- Session storage compatible with Claude Code CLI's format, so a session
  started in this app can be resumed via `claude` in the terminal, and
  vice versa
- A pluggable extensibility layer (skills, tools, MCP servers, hooks,
  subagents — see §4.8) so the community can add capabilities without
  forking the app
- No notarization/permission-hardening yet — assume the user manually grants
  Accessibility/Screen Recording permissions during dev

**Explicitly out of scope for v1:**

- Notarization, code signing, Gatekeeper handling (later — this is what
  actually triggers/streamlines the permission prompts for end users)
- Windows/Linux support
- Multi-step autonomous computer-use (clicking around, multi-app workflows)
  — each turn is still "read screen once, respond once," even within a
  multi-turn conversation
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
4. App captures current screen (screenshot) and/or frontmost app's
   accessibility tree as context
5. Goal + screen context (+ any prior turns, if continuing a session) sent
   to Claude Agent SDK, along with whatever custom tools/skills/MCP
   servers/hooks the user has configured
6. Claude decides: respond conversationally, produce text to inject, or
   invoke a custom tool/skill (e.g. a community-built Obsidian-canvas skill)
7. If injecting: text is typed/inserted into the focused field via
   accessibility API. If conversational: response shown in the popup
8. Turn is appended to the session transcript (JSONL, Claude Code-compatible
   format)
9. User can continue submitting follow-up goals in the same popup open —
   each one resumes the session from step 8. Closing the popup and
   reopening it always starts a new conversation (see "Multi-turn
   conversations" below)
10. User can reopen the app's chat view to browse any past session,
    including ones resumable from the CLI

## Functional requirements

### Hotkey & activation

- Global hotkey listener (Electron `globalShortcut`), works regardless of
  focused app
- Configurable hotkey binding
- Popup appears near cursor or centered (spotlight-style), always-on-top,
  transparent background

### Dictation

- Push-to-talk or toggle mic input from within the popup, as an alternative
  to typing
- Local speech-to-text (e.g. Whisper running locally) — no audio sent to any
  cloud service, consistent with the local-first principle
- Transcribed text populates the goal input the same as if typed; user can
  edit before submitting

### Screen context capture

- On invocation, capture:
  - A screenshot of the active display (or frontmost window) for
    vision-based context
  - Optionally, the frontmost app's accessibility tree / focused element
    content, for cases where structured text is more useful than pixels
- Read-only and on-demand — never persistent/background capture in v1

### Claude Agent SDK integration

- Use Claude Agent SDK (Node/TypeScript) for all reasoning
- Screenshot passed as image input; goal text as the prompt
- Stream responses into the popup
- SDK decides response mode (text reply vs. actionable output) based on
  prompt — or app-level logic inspects the response and branches

### Response modes

- **Talk back:** render Claude's response as chat text in the popup
- **Type it out:** ✅ implemented, as a propose/accept/reject loop rather
  than direct injection. The model calls a custom `proposeText` tool
  (chosen from phrasing, not a user-facing mode switch) instead of
  replying in prose; the popup shows the proposed text with **Accept &
  Insert** or **Reject**. Accepting refocuses the app that was frontmost
  when the popup opened and simulates real keystrokes via
  `@nut-tree-fork/nut-js`'s `keyboard.type()` (not the originally-planned
  AXUIElement direct text insertion — keystroke simulation is universal
  across apps with no per-app Accessibility-tree work). Rejecting reveals
  a "what should change?" input; the answer is a normal follow-up turn in
  the same resumed session, so the model can revise and the loop repeats.
  See `docs/design.md` §"Text injection and conversation continuity".
- No clipboard-fallback path yet for injection failure — not hit in
  testing, revisit if it proves necessary.

### Multi-turn conversations

- A single open of the popup is one conversation: turns within it share
  full context via the SDK's session resume, and the transcript stays
  visible turn-to-turn.
- **The default hotkey opens a new conversation; a second hotkey resumes
  one.** `Option+Space` (unchanged) always starts fresh: transcript
  cleared, layout reset to input-only, new SDK session, no `resume`. A
  second hotkey, `Option+Shift+Command+Space` ("Continue a Conversation"
  in Settings), opens the popup in a searchable session-picker mode
  instead — picking a session loads its real prior transcript and resumes
  it, so screen context captured on the next turn effectively gets added
  to that existing conversation. A "Continue in Popup" action on a
  session's page in the Chats section does the same thing directly,
  skipping the picker. Both reuse the same `resume` mechanism as any other
  follow-up turn — see `docs/design.md`.
- Screen context is re-captured fresh on every turn, even within the same
  open conversation (the screen may have changed since the last turn).

### Session storage (Claude Code-compatible)

- Write session transcripts as JSONL, one JSON object per line, append-only
- Store under `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl` —
  same location/format the Claude Code CLI uses, so:
  - Sessions started in this app are resumable via `claude --resume
    <session-id>` (or equivalent) in the terminal
  - Sessions started in the CLI could, in principle, be browsed in this
    app's history view
- Need to confirm exact JSONL schema (event types, message structure)
  matches current Claude Code CLI version before relying on
  cross-compatibility — this format is undocumented/reverse-engineered
  externally, so treat as best-effort, not a guaranteed stable contract
- "Project path" key: since this app isn't tied to a working directory the
  way Claude Code CLI is, decide on a fixed pseudo-path (e.g.
  `~/.claude/projects/-ambient-app/`) to key all its sessions under, or key
  per-day/per-topic — see `docs/design.md` open questions

### In-app chat history

- Chat-style UI listing past sessions (most recent first, grouped by day),
  covering both Clance's own sessions and real Claude Code CLI sessions
  from any project on the machine
- Click a session to open its full back-and-forth as its own closable tab
  (see the main window's tab system in `docs/design.md`). The tab view
  itself stays read-only (no editing history in place), but a "Continue in
  Popup" action opens that same session, fully resumed, in the popup —
  see "Multi-turn conversations" above.
- Since storage is JSONL-based, history view is just a JSONL
  reader/renderer, not a separate SQLite-driven UI
- Optional: SQLite as a lightweight index/cache on top of the JSONL files
  for fast search/sort, if JSONL directory scanning becomes slow — not
  required for v1
- Full details in
  `docs/superpowers/specs/2026-09-07-chat-history-design.md`

### Extensibility layer (plugins, skills, MCP, hooks)

Goal: the app itself stays minimal — a shell, screen capture, injection,
and storage — while all *capability* is added through the Claude Agent
SDK's own extension points.

- **Skills** — ✅ implemented. Reuses `~/.claude/skills/` directly (Claude
  Code's own convention, `SKILL.md` files), passed to the Agent SDK's
  `skills` query option. Community members drop in a skill folder and it's
  picked up automatically, no code changes.
- **MCP servers (external)** — ✅ implemented. `~/.clance/mcp.json` mirrors
  Claude Code's own `.mcp.json` server config shape (stdio/sse/http), with
  a Clance-only `enabled` flag wrapping each entry — only enabled servers
  are passed to the Agent SDK's `mcpServers` query option.
- **Custom tools** — not yet implemented. Deferred: needs real code (the
  SDK's `@tool` pattern), not just config, so no generic management UI can
  offer this the way Skills/MCP toggles do.
- **Hooks** — not yet implemented. Deferred as a security-sensitive gating
  layer that deserves its own design pass.
- **Subagents** — not yet implemented. Deferred alongside Custom tools and
  Hooks.
- **Config surface** — ✅ implemented for Skills and MCP servers: the
  Skills & Plugins section lists both with enable/disable toggles
  (`src/main/skills.ts`, `src/main/mcpConfig.ts`). Config files remain the
  source of truth — the UI is a convenience layer over them, not a
  replacement.
- **Compatibility goal** — met for Skills (same directory, same `SKILL.md`
  format) and MCP servers (same config shape). Not yet applicable to
  Custom tools/Hooks/Subagents since those aren't built yet.

*Example scenario this should support:* a community member wants Clance to
be able to create Obsidian canvases. They write an MCP server (or a skill,
if no tool execution is needed) that exposes that capability, drop its
config into the appropriate folder, and Clance picks it up on next launch —
no PR to the core app required.

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
- No notarization for v1 — user manually grants Accessibility + Screen
  Recording permissions via System Settings on first run

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

- Latency: response should start streaming within ~1-2s of request
- Privacy: screen content is only captured at the moment of invocation,
  sent only to Claude's API for that one request, never stored as raw
  images (only the resulting text conversation is persisted)
- Reliability: failed injection should never lose the model's output
  (always recoverable via clipboard/chat history)
- No persistent screen recording or ambient capture of any kind in v1
- macOS Apple Silicon only — no Intel Mac support required for v1

## Success criteria for v1

- Hotkey reliably opens the popup from any app, any time
- Can read screen content and produce a relevant response for at least a
  few real scenarios (e.g. "summarize this," "draft a reply to this email")
- Text injection works in at least one real target app (e.g. Mail, Notes,
  or a browser text field)
- Dictation works as a reliable alternative to typing the goal
- A session created in the app can be resumed in the Claude Code CLI (or at
  minimum, is stored in a format that could support this without redesign)
- Submitting follow-up goals within one popup open keeps working multi-turn
  context; reopening the popup reliably starts a clean, new conversation
- Chat history view accurately shows all past sessions
- At least one third-party capability (a skill or MCP server not built by
  the core team) can be dropped in and used, without modifying app code —
  proves the extensibility layer actually works, not just documented as a
  goal
- Everything works fully offline except the actual Claude API call
- Graceful fallback (clipboard) when permissions aren't granted or
  injection fails
