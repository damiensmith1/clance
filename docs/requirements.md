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
- The session is told, invisibly, that it was opened from the popup, which
  local tools it has and when to use them. Nothing about the screen is sent
  automatically.
- The widget can be dragged and resized and stays where the user puts it. It
  never closes on losing focus.
- Toolbar:
  - **Title** — shows the session's folder and title; clicking it, or ⌘K
    anywhere in the widget, resumes any past session in the widget, or starts
    a new session in a recent or chosen directory.
  - **Open in App** — move the live terminal into a main-window tab without
    restarting it.
  - **Hide** (or ⌥Space while the widget is open) — tuck the widget away
    with the session still running and return focus to the previous app.
    The next ⌥Space brings the same widget back.
  - **Close** (or ⌘W) — dismiss it. A session with no user message is
    deleted; anything else stays resumable.
- A hint bar under the terminal shows the shortcuts and the session's folder.
- If the session can't start, the widget says so, with Try again and Open
  Settings.
- No screenshot Clance takes includes the widget itself.
- Dropping a file onto any Clance terminal pastes its path into the input.

## Local tools

Sessions Clance starts get these tools when Accessibility is granted:

| Tool | Does | Asks for approval |
|---|---|---|
| `look_at_screen` | Screenshot of the display under the cursor | No |
| `read_window_text` | A window's text, read rather than screenshotted | No |
| `read_focused_field` | The text of the field the user is typing in | No |
| `read_selection` | The currently highlighted text | No |
| `list_open_windows` | Open apps and their window titles | No |
| `click_element` | Click a control by the name shown on it | No |
| `click_at` | Click at a position on the current display | No |
| `write_field` | Write into a field — replace, insert at the cursor, or clear | Yes |
| `activate_app` | Bring an app to the front | Yes |

- Approval is Claude Code's own Allow / Deny / Always allow prompt. Tools
  that can act on an app the user didn't point at, or that destroy content,
  always ask.
- Each tool can be switched off (Settings → clance tools). A
  switched-off tool is refused, not just prompted.
- Clicking prefers naming a control over aiming at coordinates, and writing
  into a field is confirmed by reading it back — a write that quietly did
  nothing is never reported as success.
- A session can read the screen as text — the focused field, the selection,
  a window's contents — rather than only as a screenshot, and reads the app
  the user came from rather than Clance.
- Sessions are told, invisibly, when to prefer these over the tools they
  already have: a question about what's on the user's screen is answered by
  reading it, not by opening or fetching a page, and these are the only
  tools that can see an app that isn't a browser. Driving the web itself is
  left to the session's own browser tools. Sessions opened in the main
  window get this too, aimed at a named app rather than the one in front.
- Reading the highlighted text finds a selection wherever it is — a passage
  in a page or a document, not only text inside an editable field.
- Some apps publish nothing but their window frame to macOS's accessibility
  API, and Clance can ask them to do better but can't compel them. A read of
  one says so, and points at the screenshot, rather than reporting an empty
  window as fact.
- Password fields are never readable, through any tool. Clance reports that
  one is focused and nothing about what it holds.
- Screen Recording is optional. Without it, `look_at_screen` says how to
  enable it rather than failing opaquely. Reading text needs Accessibility,
  and says so when it's off.
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
  folder in Finder, pin or unpin, and archive, stop or restore.
- Sessions can be pinned, from that menu or a pin at the head of the row.
  Pinned ones sit above every other session whatever their date or state, and
  don't appear again among the rest. They are still subject to the filter and
  the search — pinning changes where a session sits, not whether it shows.
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

## Changes

- A Changes pane shows what has changed in a git repository since its last
  commit — which, while a session is writing code, is what Claude has just
  done. It is a monitor, not a reader: files are read in file tabs.
- It opens beside the work rather than over it — in a pane of its own on the
  right, a quarter of the window wide, when the window has room for one. It
  keeps whatever width it is given afterwards.
- One repository at a time, chosen from a switcher that offers the default
  session directory, recently used directories, wherever the running agents
  are working, and any other folder. It reopens on the repository it was last
  pointed at.
- The header gives the repository and its branch, marks when a session is
  working there, and carries Fetch, with Pull and Push only when there is
  something to pull or push. A merge, rebase or cherry-pick in progress is
  named. A detached HEAD is named as such rather than shown as a bare commit
  id, so it can't be mistaken for a branch.
- The branch opens a read-only list of the repository's branches, most
  recently committed to first: which one is checked out, how far each is
  ahead of or behind its upstream, which have no upstream, and when each was
  last committed to. Clicking one copies its name. Nothing there checks a
  branch out — switching is done in a terminal or by a session.
- Each changed file gives its path, what happened to it (added, modified,
  deleted, renamed, untracked, conflicted) and its line counts, with the
  repository's totals above them. Clicking one opens it as a file tab; a
  chevron expands a short diff in place, for when a glance is all that's
  wanted.
- The list updates by itself as files change on disk, so a session working in
  the repository is watched rather than polled by hand.
- Files that changed while the user was looking elsewhere are marked, and the
  count of them can be cleared in one action. Opening or peeking at a file
  clears its own mark. The first listing after opening a repository is the
  baseline and marks nothing.
- Files are staged and unstaged individually or all at once, and a commit
  takes exactly what is staged. Staging is per file; there is no hunk-level
  staging.
- A commit needs a message, and can be followed straight away by a push. ⌘↩
  in the message box commits. A push from a branch with no upstream sets one.
  A pull is fast-forward only.
- A file's uncommitted changes can be discarded, behind a confirmation. This
  is the only destructive action, and for an untracked file it deletes the
  file.
- Under the commit box, recent commits — subject, how long ago, short hash —
  so a commit can be seen to land and the pane still says something when the
  working tree is clean. As many are shown as fit the space between the
  commit box and the remote button, re-measured when the pane is resized;
  the strip never scrolls, and disappears entirely when there is no room for
  even one. A repository with no commits yet says so.
- If the repository has a remote that can be browsed, a button opens it in
  the default browser. A repository with no remote, or one that isn't a web
  address, doesn't show the button.
- Every git failure is reported in git's own words rather than as a generic
  error, and nothing is reported as done that didn't happen.
- Not included: a commit graph, browsing history beyond what that strip
  shows, branch switching, merges, rebases, stashes and anything that
  rewrites history. Those stay in a terminal or in the session next door.

## Files

- Any file in the current repository, or in the folder the Files explorer is
  pointed at, can be opened as a tab and read — Clance is a read-only viewer
  over the code a session is writing. It never edits a file.
- ⌘P opens a file by name from anywhere in the main window, matching on any
  subsequence of its path, over every tracked file and every untracked one git
  isn't ignoring.
- A file tab shows the whole file, syntax highlighted, with its changes marked
  in place: added lines, and deleted lines put back where they were.
- A Diff / Clean choice switches between the marks and the file exactly as it
  stands on disk. Both views come from one read, so they can't disagree about
  what the file says.
- A changed file's tab says how many changes it has and can jump between
  them, since a change can be a long way down a long file.
- A file tab follows the file: a session writing to it while it's open updates
  what's shown.
- One tab per file — opening the same file again focuses the tab that's
  already there. Files open beside the Changes pane rather than over it.
- A file is drawn by a **reader** chosen from its path: text with syntax
  highlighting, images, or markdown. A table over a CSV or a JSON tree would
  each be another. A reader returns its own payload, so a file view is not a
  list of lines with a diff on it, and whether a file has a Diff / Clean
  choice at all is something its reader says.
- An image opens in a tab of its own and is shown at its size, fit to the
  pane, with its file size in the header. A transparent one reads as
  transparent rather than as whatever colour the page happens to be.
- A markdown file opens rendered, with a **Rendered / Raw** choice. Raw is
  the source with its changes marked in place, so a changed document can
  still be read as a diff. A file whose reader has only one view never shows
  the choice — an SVG offers Image / Raw, a PNG offers nothing, a `.ts` is
  only itself.
- Nothing is loaded to render a document. A picture referenced inside a
  markdown file shows as its alt text; opening a file never reads other
  files, and never fetches anything from whoever wrote it. An image is looked
  at by opening it, which is its own tab.
- A link in a rendered document opens in the browser, and only if it is
  http, https or mailto. The URL is re-parsed before it is opened rather than
  handed over as it was written.
- A file no reader claims says what it can about itself — its name, its size —
  rather than apologising. So does one larger than its reader will open.
- A reader never executes what it reads. File content is drawn, never turned
  into markup, because a folder being browsed may have been cloned a minute
  ago and SVG and HTML both carry script.
- Readers are added in the codebase. Clance loads nothing from a user's disk
  to render a file, and this isn't a plugin surface.
- A file tab open when the branch changes under it follows the branch. If the
  file doesn't exist on the new branch it says so, which is different from
  saying the file is gone — a file git has never heard of says that instead.

## Files explorer

- A **Files** section browses any folder on the Mac, not only a git
  repository — a scratch directory, a folder of notes, a repository that
  isn't the one Changes is pointed at. ⌘P needs a filename already; looking
  around a project is a different act from recalling a file in it.
- One folder at a time, from a switcher offering the same places the Changes
  switcher does: the default session directory, recently used directories,
  wherever running agents are working, and any other folder. It reopens on
  the folder it was last pointed at, independently of the Changes repository.
- Directories expand and collapse, one level read at a time. Which are open
  is remembered per folder for as long as the app is running.
- Files git is ignoring are hidden, with a toggle to show them — the same set
  ⌘P searches, so the two can't disagree about what is in the project.
  Outside a repository nothing is ignored and the toggle is absent. Dotfiles
  are always shown.
- When git can't say what a repository ignores, the tree lists everything and
  says so. Silently showing node_modules looks exactly like a project that
  ignores nothing.
- Clicking a file opens it as a file tab beside the sidecar. A file inside a
  repository opens against that repository, so it arrives with its changes
  marked in place and is the same tab the Changes pane would have opened.
- Arrows move through the tree, → opens a directory and ← closes it or moves
  to the parent, ↩ opens the selected file.
- Symbolic links are listed and never followed. A file outside the chosen
  folder is never readable through Files, including through a link inside it:
  paths are resolved before they are checked, because a link pointing at
  `~/.ssh/id_rsa` passes every test made on a path as text.
- Files never writes. Moving, renaming or creating a file is a capability the
  model may be given later, and it would arrive as a local MCP tool gated by
  Claude Code's own approval prompt — not as a button in the tree.

## Main window

- Opens from the Dock icon or the menu-bar menu. While setup is incomplete it
  opens on launch.
- A launcher opens Sessions, Changes, Files, Dictation, Settings, or a
  plain shell terminal. Changes and Files are sidecars: they open in a pane
  of its own on the right when the window can take one, and files open as
  tabs beside it. The second sidecar to open joins the first's pane as a tab
  rather than taking another quarter of the window. Sections open as tabs;
  reopening one focuses it.
- Tabs can be split into up to four panes by dragging to an edge (at most a
  2×2 grid), resized by dragging dividers, and reordered. The layout is
  restored on launch.
- A session with nothing in it yet is shown as "Clance Chat" — one name for
  that state, wherever it appears. A tab takes the conversation's real title
  as soon as it has one.
- Terminal tabs survive tab switches and window reloads. A session tab shows
  a live dot and a status line with its folder and start time, and can be
  popped out into the widget.
- A tab too narrow to show its name shows only its icon, rather than a
  clipped word. Hovering any tab for two seconds gives its full name — for a
  file tab, its whole path, since the label is only a basename and two tabs
  called `index.ts` are otherwise the same tab twice.
- Tabs are driven from the keyboard the way they are in any macOS app: ⌘W
  closes the active tab (and the window once its last tab goes), ⇧⌘W closes
  the window, and ⌃⇥ / ⇧⌃⇥ move between the tabs of the pane in focus. The
  bindings appear in the Window menu, and work while a terminal has focus.
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
  tool. No audio leaves the Mac. No telemetry.
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
- A full git client: history and graph views, branching, merging, rebasing,
  stashing, conflict resolution or anything that rewrites history.
- Editing files. Clance reads code; the session writes it.
- Cross-file search. The Files explorer reaches a file you can see; search
  is a second navigation model with its own ranking and result UI, and a tree
  doesn't imply one.
- Anything else an editor does beyond opening a file and reading it: editing,
  creating, renaming, moving or deleting, a preview that isn't a file tab,
  drag and drop between folders, or more than one folder open at once.
- A plugin marketplace or installer.
- Self-updating.
- For dictation: speaking responses aloud, non-English-first transcription,
  meeting recording, speaker diarization, transcribing audio files, and live
  two-way voice conversation with the model.

## Ideas (not committed)

- **Quick Ask** — a separate fast path using the Agent SDK for read-only
  questions and `write_field`, escalating to a full session by starting a new
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
