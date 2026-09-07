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

- **Visual style (superseded twice):** originally a translucent "liquid
  glass" surface using `vibrancy: "hud"`. A first pass replaced that with
  a flat, warm, editorial look with no avatars/bubbles. A second pass —
  built to match user-supplied UI mockups pixel-for-pixel (see "Design
  system" below) — restored avatars and a subtle bubble for the user's
  own messages specifically (Clance's replies stay plain text, unbubbled)
  and nests the transcript in its own bordered "ACTIVE SESSION" card
  above the input. Both windows use `backgroundColor` instead of
  `vibrancy` (`src/main/mainWindow.ts`, `src/main/popupWindow.ts`).
- **Message model:** each turn shows a small circular avatar (person icon
  for the user, robot icon for Clance) beside its content — the user's
  text sits in a light rounded bubble, Clance's reply renders as plain
  markdown text beneath its avatar. Full session history is shown, not
  just the last exchange.
- **Conversation lifetime:** every popup open is a new conversation —
  closing it (blur-hide or toggle) and reopening always clears the
  transcript and starts a fresh SDK session (no `resume`), regardless of
  how it was closed. Within one open, follow-up turns do resume the
  in-progress session for shared context. See
  `docs/requirements.md` §"Multi-turn conversations".
- **Input position:** the input starts pinned above the (empty) transcript;
  once the first turn is submitted, `#app` gets a `has-messages` class that
  flips both elements' flexbox `order` so the input moves below the
  transcript (chat-input-bar style) for the rest of that conversation. Reset
  back to the top position on every reopen along with the transcript.
- **Dynamic sizing:** the window isn't a fixed size — `#app` uses
  `height: auto` with a `max-height` (480px) instead of filling a fixed
  window, so it starts only as tall as the input row and grows with content.
  A `ResizeObserver` on `#app` reports its real rendered height to the main
  process (`resize-request` IPC), which calls `win.setContentSize(w, h,
  true)` (animated) clamped to a small floor and the max — see
  `src/main/popupWindow.ts`. The report happens directly in the observer
  callback, not batched via `requestAnimationFrame`, because rAF is
  throttled while the window is hidden/unfocused (confirmed via
  `document.hidden`) and a response can legitimately arrive while hidden.

## Main application window

- There are now two windows/renderer surfaces: the popup (unchanged) and a
  new persistent main application window (Dock-icon-launched, also
  reachable via an "Open Dashboard" tray item). Each has its own preload
  script (`src/preload/popup.ts`, `src/preload/mainWindow.ts`) and full
  context isolation between them. The main window's preload
  (`contextBridge.exposeInMainWorld("clanceApp", {...})`) now exposes a
  real API surface — `getSetupStatus`, `connectClaude`, `openInstallDocs`,
  `recheckPermissions`, `openScreenRecordingSettings`,
  `openAccessibilitySettings`, `getShortcutActions`, `saveShortcuts`,
  `completeSetup` — added by the Setup Wizard sub-project (see below);
  future specs (chat history, extensibility UI) will extend it further.
- **Setup Wizard (sub-project #2):** the app is fully gated — no global
  hotkey, no popup — until three sequential checks pass: the Claude plan
  is connected, Screen Recording + Accessibility permissions are granted,
  and a keyboard shortcut is confirmed. `src/main/setupStatus.ts`'s
  `getSetupStatus()` is the single source of truth for this, live-checked
  on every call (auth and permissions are never cached as a "done" flag);
  only the chosen shortcut and a `shortcutsConfigured` flag persist, in a
  new `~/.clance/config.json` alongside the existing session-id file.
  Connecting the Claude plan is delegated entirely to the `claude` CLI's
  own `auth login`/`auth status --json` commands rather than a custom
  OAuth implementation — this makes the CLI a required, separately-
  installed dependency (the wizard guides the user to install it if
  missing) rather than something bundled with Clance. Full details in
  `docs/superpowers/specs/2026-09-06-setup-wizard-design.md` and
  `docs/superpowers/plans/2026-09-06-setup-wizard.md`.
- The main window uses Preact + htm for its UI, vendored as a single
  self-contained file (`src/shared/vendor/preact-htm-standalone.module.js`,
  sourced from the `htm@3.1.1` npm package's `preact/standalone` build)
  rather than loaded from a CDN, to preserve the project's local-first
  principle (no network access required to launch the app) and to avoid
  needing a bundler. This is distinct from the popup, which stays vanilla
  JS with no framework.
- **Tab-based navigation (supersedes the original sidebar-swap model):**
  the sidebar (`src/mainWindow/Shell.js`) is a launcher, not a content
  switcher — clicking a launcher item or a chat-history row opens it as a
  closable tab, and the tab bar (not the sidebar) is what actually
  switches visible content. Tab state (`tabs`, `activeId`) lives in
  `Shell.js` as plain Preact `useState`, keyed by a stable `id` per tab
  (`"chats"`/`"skills"`/`"settings"` for the three launcher sections,
  `chat:<filePath>` for an opened conversation). Opening an id that's
  already open either activates the existing tab or opens a duplicate,
  governed by the `reuseTabs` preference (`~/.clance/config.json`,
  default `true`, editable from Settings' "Tab Behavior" toggle) — see
  `openTab()` in `Shell.js`. Still no router library; revisit only if
  cross-session tab persistence or deep-linking is needed later.
- **Design system — "Editorial Warmth" (supersedes the flat/no-serif pass
  above):** built to match user-supplied UI mockups exactly, not just
  "inspired by." Palette: `--app-bg #F7F3EB`, `--surface-bg #EFEDE5`,
  `--surface-card`/`--surface-elevated #FFFFFF`, `--text-primary
  #2D2924`, `--text-secondary #7A7267`, `--accent #D97757` (notably close
  to Claude's own real brand accent). Typography is three real vendored
  font families, not system fonts: Newsreader (serif, headings/page
  titles/the sidebar wordmark), Inter (sans, body/UI), JetBrains Mono
  (code/paths) — each a single variable-weight `.woff2` file under
  `src/shared/fonts/`, referenced via local `@font-face` in
  `theme.css` (no Google Fonts CDN link — matches the no-CDN rule the
  same way the vendored Preact/htm build does; the files were fetched
  once during development and committed, not loaded at runtime).
- **New shared components:** `src/shared/icons.js` (a small hand-rolled
  inline-SVG icon set, ~20 icons, no icon font/library), `Toggle.js` and
  `StatusCard.js` under `src/mainWindow/components/`. `chatHistory.ts`'s
  collapsed tool/thinking blocks now group into one collapsible "Thought &
  Tool Execution" disclosure per contiguous run (`ToolGroup` in
  `ChatsSection.js`) instead of one line per block. `markdown.js` gained a
  regex-based (not a real tokenizer) syntax highlighter and a copy-button
  header for fenced code blocks, rendered dark-on-light regardless of the
  surrounding page's palette — shared verbatim between the popup and the
  main window's chat detail view.
- Full details are in
  `docs/superpowers/specs/2026-09-06-app-shell-design.md` and
  `docs/superpowers/plans/2026-09-06-app-shell.md`.
- **Chat history browser (sub-project #3):** `src/main/chatHistory.ts`
  walks `~/.claude/projects/*/` directly (no bundled SQLite index) and
  builds session summaries without a full-file parse — title comes from
  the first `user`-turn line only, streamed line-by-line, since scanning
  to EOF for the latest Claude-Code-generated `ai-title` isn't worth it
  for real session files that run 7-11MB. Full transcript parsing (with
  `tool_use`/`tool_result`/`thinking` blocks collapsed to compact
  one-line summaries) only happens on demand, when a session is opened.
  The popup's markdown renderer (`src/popup/markdown.js` originally) is
  now `src/shared/markdown.js`, a real ES module — both the popup and
  the chat history detail view import the same `renderMarkdown`, which
  also meant converting the popup's own scripts from classic `<script>`
  tags to `type="module"` + `import`. Full details in
  `docs/superpowers/specs/2026-09-07-chat-history-design.md`.
- **Extensibility management UI (sub-project #5):** the Skills & Plugins
  section now manages the two purely config-driven extension points —
  Skills and MCP servers — for real, not just as a UI mockup.
  `src/main/skills.ts` scans `~/.claude/skills/*/SKILL.md` directly (hand-
  rolled frontmatter parsing, no YAML dependency, same approach as
  `chatHistory.ts`) and cross-references Clance's own `enabledSkills`
  config field (`"all"` by default, converts to an explicit list the first
  time a skill is toggled off, so newly-added skills stay off afterward —
  never implicitly collapses back to `"all"`). `src/main/mcpConfig.ts`
  owns `~/.clance/mcp.json`, wrapping each Claude-Code-`.mcp.json`-shaped
  server config with a Clance-only `enabled` flag; `agent.ts`'s `query()`
  call now passes `skills` and `mcpServers` built from these two modules.
  Custom tools, hooks, and subagents are explicitly deferred — the first
  needs real code rather than config, the second is a security-sensitive
  design decision on its own, and building a generic management UI for
  either doesn't make sense yet.

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
- [x] Where does the Anthropic API key/auth live — env var, onboarding
      flow, macOS Keychain? **Resolved:** delegated entirely to the
      `claude` CLI's own credential store via `claude auth login`/`claude
      auth status --json` (see `src/main/claudeAuth.ts`) — Clance never
      handles a raw API key itself. This makes the globally-installed
      `claude` CLI a required dependency; see the Setup Wizard note above.
- [x] Does the popup stay open for multi-turn follow-up in the same
      invocation, or is each hotkey-press a fresh single-turn request?
      **Resolved:** multi-turn within one open (follow-ups resume the
      in-progress session), but every hotkey-open is a new conversation —
      reverses the earlier "continues last session by default" plan (see
      `docs/requirements.md` §"Multi-turn conversations").
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
