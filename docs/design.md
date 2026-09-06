---
title: Design
tags: [clance, design]
status: draft
---

# Design

## Tech stack (proposed)

| Component | Choice | Notes |
|---|---|---|
| Shell | Electron | per requirement — Node.js, macOS-first |
| Hotkey | Electron `globalShortcut` | |
| Screenshot capture | Electron `desktopCapturer` | |
| Accessibility (read frontmost app / inject text) | macOS Accessibility API (AXUIElement) via a native Node addon or helper binary | highest-risk integration point — Electron doesn't expose this natively, will likely need a small Swift/Obj-C helper or a library like `node-mac-permissions` + custom AX bindings |
| AI | Claude Agent SDK (TypeScript) | |
| Session storage | JSONL files under `~/.claude/projects/...` | matches Claude Code CLI format — see [[Streaming Architecture in Node.js]] for the general append-only/streaming-write pattern this resembles |
| Optional index/cache | SQLite | only if JSONL scanning proves too slow for history UI |
| Streaming | SDK's native streaming interface | |

## Architecture notes

- The app is deliberately a thin shell: hotkey/tray presence, screen
  capture, text injection, and session storage are the only app-owned
  concerns. All reasoning and capability (tools, skills, MCP, hooks,
  subagents) is delegated to the Claude Agent SDK's own extension points —
  see `docs/requirements.md` §"Extensibility layer".
- Session transcripts are the one piece of persisted state, and their
  format is not app-invented — it must match whatever the Claude Code CLI
  currently writes, so cross-resumability holds. This is a hard external
  dependency on an undocumented format (see open questions below), not a
  design choice this project controls.
- Multi-turn continuation and session-id capture are handled by the Claude
  Agent SDK's own `resume`/session-store mechanism (`options.resume` +
  the `session_id` on the `result` message), not hand-rolled JSONL writing
  — Clance just persists the last session id to resume by default (see
  `src/main/paths.ts`). Still need to confirm the SDK's on-disk format
  under `cwd` is byte-for-byte what the CLI itself reads (first open
  question above).
- Config for API keys, MCP servers, and enabled skills/tools should follow
  the same file-based-source-of-truth pattern as Claude Code itself —
  see [[Configuration and Secret Management]] for general tradeoffs on
  where that config should live (env var vs. keychain vs. flat file).

## Popup UI

- **Visual style:** a translucent "liquid glass" surface, not a
  messaging-app skin — no chat bubbles, no avatars. Uses Electron's native
  `vibrancy: "hud"` window material (real macOS frosted-glass blur of
  whatever's behind the popup) layered with a hairline border, large corner
  radius, and a subtle top-edge CSS highlight to suggest refraction. See
  `src/renderer/popup.html`.
- **Message model:** each turn renders as two stacked typographic blocks —
  the prompt (dim, small) and the reply (full-opacity, primary) — appended
  to a scrolling column, so it *reads* like a transcript without looking
  like a chat widget. Full session history is shown, not just the last
  exchange.
- **Transcript lifetime:** history lives in the popup's renderer DOM, which
  persists across hide/show (hotkey toggle, blur-hide) since it's the same
  window instance — but resets if the app itself restarts, even though the
  underlying SDK session is still resumable. Rehydrating the UI transcript
  from the resumed session's transcript on app restart is a known v1 gap,
  not yet built.

## Open questions (resolve before building)

- [ ] Exact Claude Code CLI JSONL schema — need to inspect a real session
      file to confirm event/message structure before writing compatible
      transcripts
- [x] What "project path" should this app's sessions be keyed under, given
      it has no working directory concept the way Claude Code CLI does?
      **Resolved:** pass a fixed `cwd` (`~/.clance/`) to every `query()` call
      (see `src/main/paths.ts`), so all Clance sessions land under one
      stable `~/.claude/projects/<encoded ~/.clance>/` bucket regardless of
      which app was frontmost at invocation.
- [x] Screenshot vs. accessibility-tree read vs. both, by default —
      screenshots are simpler and more universal; accessibility tree is
      more precise for structured apps (forms, code editors) but harder to
      build. **Resolved (v1):** screenshot only, of the full display nearest
      the cursor, captured fresh on every submit (`src/main/screenCapture.ts`)
      and sent to Claude as an image content block alongside the prompt
      (`src/main/agent.ts`), resized to Claude's recommended max edge
      (1568px) to control token cost. Accessibility-tree read is deferred —
      revisit if screenshot-only proves insufficient for structured-app
      goals (forms, code editors).
- [ ] How does the app decide "talk back" vs. "type it out" — model-decided
      via prompt, or does the user pick a mode when typing their goal?
- [ ] Where does the Anthropic API key/auth live — env var, onboarding
      flow, macOS Keychain?
- [ ] Does the popup stay open for multi-turn follow-up in the same
      invocation, or is each hotkey-press a fresh single-turn request?
      (Current default: hotkey continues last session by default — confirm
      this is the right default vs. always-fresh)
- [ ] Which local speech-to-text engine — Whisper.cpp is the obvious
      default (fast, local, well-supported on Apple Silicon) — confirm no
      better native macOS option (e.g. on-device Speech framework) worth
      using instead
- [ ] Exact folder/config conventions for skills, tools, and MCP servers —
      reuse `~/.claude/` conventions directly, or use an `~/.ambient/`
      namespace that mirrors them? Reusing directly maximizes compatibility
      but risks conflicts with an actual Claude Code install on the same
      machine
- [ ] How much of the settings UI (enabling/disabling plugins) ships in v1
      vs. "edit the config file yourself for now"
