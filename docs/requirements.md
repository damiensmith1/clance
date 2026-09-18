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
- The menu-bar menu opens the widget, starts dictation and opens the main
  window, shows the current shortcuts, and says whether Claude is connected.

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
  - **Title** — shows the session's folder and title; clicking it, or ⌘K
    anywhere in the widget, resumes any past session in the widget, or starts
    a new session in a recent or chosen directory.
  - **ctx** — hover card showing what the last ⌘⇧R captured.
  - **Open in App** — move the live terminal into a main-window tab without
    restarting it.
  - **Hide** (or ⌥Space while the widget is open) — tuck the widget away
    with the session still running and return focus to the previous app.
    The next ⌥Space brings the same widget back.
  - **Close** — dismiss it. A session with no user message is deleted;
    anything else stays resumable.
- A hint bar under the terminal shows the shortcuts and the session's folder.
- If the session can't start, the widget says so, with Try again and Open
  Settings.
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
- Each tool can be switched off (Settings → clance tools). A
  switched-off tool is refused, not just prompted.
- Screen Recording is optional. Without it, `look_at_screen` says how to
  enable it and ⌘⇧R omits the screenshot.
- Tool, MCP and settings changes apply to sessions started afterwards. A
  session that's already running keeps what it started with.

## Sessions

- Every session Clance opens runs as a Claude Code background agent, so
  closing a tab, the widget or Clance itself never ends a conversation.
- The Sessions tab lists, in one searchable table with project, state and
  last-updated columns:
  - every running background agent on the machine first, marked when it's
    working or waiting on the user, with a Stop action (it stays resumable);
  - then every Claude Code transcript on the machine, from any project,
    newest first.
- Opening a session attaches to it if it's running, or resumes it in its own
  recorded working directory.
- Sessions a program started (a plugin's commit reviews, an SDK script) are
  hidden from the list and the widget, and viewable under an Automated filter.
- The table can be filtered (all, running, closed, archived, automated) and driven from
  the keyboard: ⌘K (from anywhere in the main window) to search, which also
  offers a new session in the default,
  a recent or a chosen folder; arrows to select; ↩ to open; ⌥↩ to open in the
  widget; Space to peek; ⌘⌫ to archive or stop; ⌘N for a new session.
- Right-clicking a session offers peeking at it, opening it in a tab or the
  widget, resuming it in Terminal, copying its folder path, revealing the
  folder in Finder, and archive, stop or restore.
- A session can be peeked at without opening it — Space or the row menu shows
  what was said, read straight from the transcript: messages in full, tool
  calls as one line each, their output behind a toggle. It opens at the end
  of the conversation, is scrollable from the keyboard, and on a session too
  long to show whole it keeps the most recent messages. A peek never changes a session, and stays responsive
  on transcripts of any size.
- Sessions can be archived (with Undo) and restored. Clance never deletes a transcript
  that has user messages — the list includes other projects' Claude Code
  history.
- New sessions open in a default directory set in Settings (`~/.clance` if
  unset). "New session" and "Open in…" can choose another; recent choices are
  remembered.
- Any session started in Clance can be resumed with `claude --resume` in a
  terminal, and vice versa.

## Main window

- Opens from the Dock icon or the menu-bar menu. While setup is incomplete it
  opens on launch.
- A launcher opens Sessions, Dictation, Settings, or a
  plain shell terminal. Sections open as tabs; reopening one focuses it.
- Tabs can be split into up to four panes by dragging to an edge (at most a
  2×2 grid), resized by dragging dividers, and reordered. The layout is
  restored on launch.
- Terminal tabs survive tab switches and window reloads. A session tab shows
  a live dot and a status line with its folder and start time, and can be
  popped out into the widget.
- While Claude is signed out, the main window shows a banner with Sign in.

## Extensibility

- Skills, hooks, plugins and MCP servers configured for Claude Code (in
  `~/.claude/` or a project's `.mcp.json`) work in Clance sessions with no
  Clance-specific setup.
- Clance doesn't manage skills, plugins or MCP servers; engineers do that with
  the `claude` CLI.
- Settings has a collapsible "clance tools" group, collapsed by default: a
  summary row, expanding to the local tools server's health check and a
  per-tool on/off switch.

## Dictation

- A global shortcut (⌥D by default) starts recording in any app; pressing it
  again stops and transcribes. Escape cancels, including during
  transcription.
- Recording stops by itself after 1.5 s of silence following speech, and
  after 5 minutes regardless.
- A small HUD shows the input level and progress, and never takes focus, so
  the text lands where the cursor was. It says where the text went (typed
  into which window, or copied), and when something is missing (model, engine,
  microphone permission) it says what and links to the place to fix it. The menu bar shows a dot while
  recording, and the app menu has Start/Stop and Cancel.
- Dictation records from the Mac's default input, or from a microphone chosen
  in Settings, so connecting a headset doesn't move it; a chosen mic that isn't
  connected falls back to the default.
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
  custom range), copy and delete per transcript, and delete-all-matching
  behind a confirmation.
- Dictation works without Claude being set up.

## First-run setup

- Until setup is complete, the main window shows a wizard and the popup
  shortcut isn't registered:
  1. **Connect Claude** — detect the CLI (showing the install command, with
     a copy button, if missing) and sign in.
  2. **Permissions** — Accessibility (required) and Screen Recording
     (optional, with a restart once granted).
  3. **Shortcuts** — record shortcuts by pressing the keys.
  4. **Dictation** (optional, skippable) — microphone access and the
     recommended model, or another from a menu. Setup can finish while the
     model downloads.
- Each step after the first can go back to the previous one. Enter continues.
- Permissions are detected as soon as they're granted, without a recheck
  button.
- Claude sign-in and permissions are re-checked on every launch, never
  remembered as done. Settings keeps every wizard step available afterwards,
  alongside launch at login and the default directory.
- The CLI must be found when Clance is opened from Finder or the Dock, not
  only from a terminal.
- A shortcut needs ⌘, ⌥ or ⌃ (⌘ on its own isn't enough), unless it's a
  function key. System shortcuts and duplicates are rejected with a reason.

## Updates

- On launch, and from Settings on demand, Clance compares the running version
  with the latest GitHub release and, if newer, shows the
  `brew upgrade --cask clance` command. Clance never updates itself.

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
