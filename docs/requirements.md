---
title: Requirements
tags: [clance, requirements]
---

# Requirements

What Clance does. Why is in `background.md`; how is in `design.md`.

## Platform

- macOS 13 (Ventura) or later, Apple Silicon only.
- Requires the Claude Code CLI, installed separately and signed in. Clance
  never handles Claude credentials; sign-in goes through `claude auth login`.
- Distributed as a Homebrew cask (`brew install --cask damiensmith1/tap/clance`),
  which also installs `whisper.cpp` for dictation.
- Not notarized. Releases are signed with a stable self-signed certificate
  so macOS keeps permission grants across upgrades.
- Lives in the menu bar and the Dock. Closing every window leaves it running;
  ⌘Q or the menu-bar Quit item quits it. Optional launch at login.

## Popup

- A global shortcut (⌥Space by default) opens a floating widget near the
  cursor from any app, immediately, showing a loading state until the session
  is ready.
- The widget is a terminal running a new Claude Code session in the default
  working directory. The user talks to the CLI directly.
- The session is told, invisibly, that it was opened from the popup and which
  local tools it has. Nothing about the screen is sent automatically.
- The widget can be dragged and resized and stays where the user puts it. It
  never closes on losing focus.
- Toolbar:
  - **Open in…** — resume any past session in the widget, or start a new
    session in a recent or chosen directory.
  - **See context** — hover card showing what the last ⌘⇧R captured.
  - **Open in App** — move the live terminal into a main-window tab without
    restarting it.
  - **Hide** — tuck the widget away with the session still running and
    return focus to the previous app. The next ⌥Space brings it back.
  - **Close** — dismiss it. A session with no user message is deleted;
    anything else stays resumable.
- **⌘⇧R** pastes a fresh screenshot (as an image), the frontmost window's
  title and the highlighted text into the input, unsent, for the user to ask
  about.
- Dropping a file onto any Clance terminal pastes its path into the input.

## Local tools

Sessions Clance starts get these tools when Accessibility is granted:

| Tool | Does | Asks for approval |
|---|---|---|
| `look_at_screen` | Screenshot of the display under the cursor | No |
| `read_selection` | The currently highlighted text | No |
| `list_open_windows` | Titles of open windows | No |
| `click_at` | Click at a position on the current display | No |
| `insert_text` | Type text into the app the popup was opened over, or a named app | Yes |
| `activate_app` | Bring an app to the front | Yes |
| `clear_focused_field` | Clear the focused field | Yes |
| `replace_focused_field` | Replace the focused field's contents | Yes |

- Approval is Claude Code's own Allow / Deny / Always allow prompt. Tools
  that can act on an app the user didn't point at, or that destroy content,
  always ask.
- Each tool can be switched off (Skills & Plugins → Custom Tools). A
  switched-off tool is refused, not just prompted.
- Screen Recording is optional. Without it, `look_at_screen` says how to
  enable it and ⌘⇧R omits the screenshot.
- Tool, MCP and settings changes apply to sessions started afterwards. A
  session that's already running keeps what it started with.

## Sessions

- Every session Clance opens runs as a Claude Code background agent, so
  closing a tab, the widget or Clance itself never ends a conversation.
- The Sessions tab lists:
  - **Active** — every running background agent on the machine, with a Close
    action that stops it (it stays resumable).
  - **Closed** — every Claude Code transcript on the machine, from any
    project, newest first, grouped by day, searchable.
- Opening a session attaches to it if it's running, or resumes it in its own
  recorded working directory.
- Sessions can be archived and restored. Clance never deletes a transcript
  that has user messages — the list includes other projects' Claude Code
  history.
- New sessions open in a default directory set in Settings (`~/.clance` if
  unset). "New Session" and "Open in…" can choose another; recent choices are
  remembered.
- Any session started in Clance can be resumed with `claude --resume` in a
  terminal, and vice versa.

## Main window

- Opens from the Dock icon or the menu-bar menu. While setup is incomplete it
  opens on launch.
- A launcher opens Sessions, Dictation, Skills & Plugins, Settings, or a
  plain shell terminal. Sections open as tabs; reopening one focuses it.
- Tabs can be split into up to four panes by dragging to an edge (at most a
  2×2 grid), resized by dragging dividers, and reordered. The layout is
  restored on launch.
- Terminal tabs survive tab switches and window reloads. A session tab can
  be popped out into the widget.

## Extensibility

- Skills, hooks, plugins and MCP servers configured for Claude Code (in
  `~/.claude/` or a project's `.mcp.json`) work in Clance sessions with no
  Clance-specific setup.
- Skills & Plugins shows:
  - installed skills (read-only — Claude Code has no per-skill switch);
  - MCP servers from `~/.clance/mcp.json`, each with an on/off toggle;
  - Clance's local tools, with per-tool toggles and a health check for the
    local tools server.

## Dictation

- A global shortcut (⌥D by default) starts recording in any app; pressing it
  again stops and transcribes. Escape cancels, including during
  transcription.
- Recording stops by itself after 1.5 s of silence following speech, and
  after 5 minutes regardless.
- A small HUD shows the input level and progress, and never takes focus, so
  the text lands where the cursor was. The menu bar shows a dot while
  recording, and the app menu has Start/Stop and Cancel.
- Transcription runs on the Mac with whisper.cpp. Audio is deleted after
  transcription unless "keep audio" is on.
- The transcript is pasted at the cursor (needs Accessibility), or only
  copied to the clipboard if the user prefers.
- Clance recommends one speech model for the machine. Any catalog model can
  be installed (resumable, verified, cancellable, with progress), made active
  or removed.
- The shortcut is only claimed once a model is installed.
- An editable transcription prompt improves recognition of names and
  technical terms.
- The Dictation tab keeps every transcript — text, time, duration, target
  app, model — with full-text search, date filters (today, 7 days, 30 days,
  custom range), copy, and delete-all-matching behind a confirmation.
- Dictation works without Claude being set up.

## First-run setup

- Until setup is complete, the main window shows a wizard and the popup
  shortcut isn't registered:
  1. **Connect Claude** — detect the CLI (with a link to install it if
     missing) and sign in.
  2. **Permissions** — Accessibility (required) and Screen Recording
     (optional, with a restart once granted).
  3. **Shortcuts** — record shortcuts by pressing the keys.
  4. **Dictation** (optional, skippable) — microphone access and the
     recommended model.
- Claude sign-in and permissions are re-checked on every launch, never
  remembered as done. Settings keeps every wizard step available afterwards,
  alongside launch at login and the default directory.
- The CLI must be found when Clance is opened from Finder or the Dock, not
  only from a terminal.
- A shortcut needs ⌘, ⌥ or ⌃ (⌘ on its own isn't enough), unless it's a
  function key. System shortcuts and duplicates are rejected with a reason.

## Updates

- Settings → Check for Updates compares the running version with the latest
  GitHub release and shows the `brew upgrade --cask clance` command. Clance
  never updates itself.

## Non-functional

- **Responsive.** The popup appears the instant the shortcut is pressed; a
  pre-warmed session keeps the CLI ready within a second or two. The dictation
  HUD appears in about 100 ms, and a 10-second utterance transcribes in under
  1.5 s on the recommended model.
- **Private.** No screen content is captured unless a session calls a screen
  tool or the user presses ⌘⇧R. No audio leaves the Mac. No telemetry.
- **Local.** Works offline apart from the Claude API, speech model downloads
  and the update check.
- **Light when idle.** No background capture of any kind; one spare `claude`
  process is kept warm.

## Out of scope

- Windows, Linux and Intel Macs.
- Notarization and the Mac App Store.
- Ambient or background screen watching.
- Cloud sync and telemetry.
- A custom chat UI, or reimplementing anything the CLI already does.
- Clance writing or deleting session transcripts.
- A plugin marketplace or installer.
- Self-updating.
- For dictation: speaking responses aloud, non-English-first transcription,
  meeting recording, speaker diarization, transcribing audio files, and live
  two-way voice conversation with the model.

## Ideas (not committed)

- **Quick Ask** — a separate fast path using the Agent SDK for read-only
  questions and `insert_text`, escalating to a full session by starting a new
  `claude --bg` session seeded with the exchange (never writing transcripts by
  hand).
- **Watch mode** — a pinned widget that stays attached to one session across
  hotkey presses.
- **More output destinations** — paste as a table or code block, or copy to
  the clipboard instead of typing into the frontmost app.
- **Richer screen reading** — accessibility-tree or OCR text for text-heavy
  apps, and more than one window of context (e.g. "compare these two").
- **Dictation** — hold-to-talk, an optional LLM clean-up pass (off by
  default, since it sends the transcript to a model), live partial
  transcripts, per-app insert modes.
- **Live voice** — real-time two-way audio with the model. This would need
  the API directly rather than the CLI, and API support is unconfirmed.
