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
- Moving the pane, splitting it, or switching away from its tab and back
  never makes it start over: it redraws at once as it was — the files, the
  history, the open row, a half-written commit message, where the list was
  scrolled — and refreshes quietly underneath.
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

- Any file in the current repository, in the folder the Files explorer is
  pointed at, or opened from Finder, can be opened as a tab — and edited,
  where it's text (see Editor).
- ⌘P opens a file by name from anywhere in the main window, matching on any
  subsequence of its path, over every tracked file and every untracked one git
  isn't ignoring.
- A file tab shows the whole file, syntax highlighted, with lines changed
  since the last commit marked in the gutter. An **Edit / Diff** choice
  switches to the file with its deleted lines put back where they were, a
  count of changes, and jumping between them, since a change can be a long
  way down a long file.
- A file tab follows the file: a session writing to it while it's open updates
  what's shown (see Editor for when there are unsaved edits).
- A file tab stays where it was left. Switching to another tab and back, moving
  it between panes, reopening it with ⇧⌘T or relaunching Clance brings it back
  to the same scroll position, cursor and selection, the same view (Rendered
  or Source, Edit or Diff), and a preview to the same place in the document.
- One tab per file — opening the same file again focuses the tab that's
  already there. Files open beside the sidecars rather than over them.
- An image opens in a tab of its own and is shown at its size, fit to the
  pane. A transparent one reads as transparent rather than as whatever colour
  the page happens to be.
- A markdown file opens rendered, with a **Rendered / Source** choice; the
  rendered view follows unsaved edits.
- Rendered markdown covers CommonMark and GitHub's extensions (tables, task
  lists, strikethrough, autolinks, footnotes, `> [!NOTE]` alerts), definition
  lists, `==mark==` / `~sub~` / `^sup^`, and Obsidian's callouts, wikilinks,
  `#tags` and `%%comments%%`. Front matter shows as its YAML source — fenced,
  monospace, keys picked out — rather than run together into a paragraph.
  Code blocks are highlighted and have a Copy button; a `diff` block is
  coloured by line. Math and Mermaid show as their source.
- Raw HTML in a document renders, sanitized: anything that can run code —
  scripts, event handlers, `javascript:` URLs, iframes, objects, forms,
  `<style>`, SVG — is removed, so opening a document is never running it.
- A picture inside a markdown file is shown when it is a file inside the same
  repository or folder, read with the same containment check as any file
  tab. A remote picture is never fetched — it shows as a link — so opening a
  document never calls out to whoever wrote it.
- A link in a rendered document to `#a-heading` scrolls there, and one to a
  relative path opens that file in a tab. Anything else opens in the
  browser, only if it is http, https or mailto, and the URL is re-parsed
  before it is opened rather than handed over as it was written.
- A file tab never executes what it shows. File content is drawn, never turned
  into live markup, because a folder being browsed may have been cloned a
  minute ago and SVG and HTML both carry script. Rendered markdown is the one
  place a file's own HTML reaches the page, and only through the sanitizer.
- A file tab open when the branch changes under it follows the branch. If the
  file doesn't exist on the new branch it says so, which is different from
  saying the file is gone — a file git has never heard of says that instead.
  A file deleted since the last commit shows its last committed version,
  read-only.

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
- Every file in the folder is listed, including ones git ignores; those are
  dimmed, and a toggle hides them. Ignored files open like any other, without
  a diff. ⌘P still searches only what git isn't ignoring. Outside a
  repository nothing is ignored and the toggle is absent. Dotfiles are always
  shown.
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
- Files writes too: see File operations.

## Editor

- A text file's tab is an editor. The same tab reads and edits; there is no
  separate "edit mode" to enter.
- The keys are VS Code's, since that's what an engineer's hands already know:
  ⌘S save, ⌥⌘S save all, ⌘Z / ⇧⌘Z, ⌘F find, ⌥⌘F replace, ⌘G / ⇧⌘G next and
  previous match, ⌃G go to line, ⌘D add next occurrence, ⌘-click add cursor,
  ⌥-drag column selection,
  ⌘/ toggle comment, ⌘] / ⌘[ indent, ⌥↑ / ⌥↓ move line, ⇧⌥↓ duplicate line,
  ⇧⌘K delete line, ⌥Z toggle wrap. Bracket matching, auto-closing brackets,
  auto-indent and code folding are on.
- Syntax highlighting while editing covers at least TypeScript / JavaScript
  (and JSX), JSON, CSS, HTML, Markdown, Python, shell, YAML, TOML, SQL, Rust,
  Go, Swift, Dockerfile and `.env`. Anything else edits as plain text.
- Lines changed since the last commit are marked in the gutter while editing.
  Diff is read-only, so a save never has two views to come from.
- Saving is manual. There is no auto-save: a session may be writing the same
  file, and a save nobody asked for is how one side's work disappears.
- A tab with unsaved edits shows a dot in place of its ✕. Closing it — ✕, ⌘W,
  Close Other Tabs, closing the window, quitting — asks Save / Don't Save /
  Cancel. Unsaved edits survive switching tabs and moving a tab between panes.
- A file that changes on disk while open:
  - With no unsaved edits, the tab follows it, as today, keeping the cursor
    and scroll position.
  - With unsaved edits, a banner says so and offers **Keep mine** (the next
    save overwrites), **Take theirs** (discard mine) and **Compare** (theirs
    and mine side by side, taking changes across either way). Nothing is
    reloaded or overwritten until one is chosen.
  - A save never silently overwrites a version it hasn't seen. If the file
    changed since it was loaded, saving opens the same choice instead.
  - A file deleted on disk while open says so; saving recreates it.
- Saving keeps the file's line endings, its final newline or lack of one, a
  UTF-8 byte-order mark if it had one, and its permissions. A save is atomic:
  a session reading the file mid-save sees the old version or the new one,
  never half of each.
- Indentation (tabs or spaces, and width) is detected from the file. Settings
  has the editor font size, the default indent and whether lines wrap.
- Some views stay read-only and say why: a deleted file's last committed
  version, a file not on the current branch, a file over the editor's size
  limit, and anything that isn't text.

## File types

- A file opens with a **handler** chosen from its name, and its contents
  where the name isn't enough. A handler decides how that kind of file is
  shown, whether it can be edited, and which views it offers (Rendered /
  Source, Image / Source).
- Handlers at first:
  - **Text and code** — the editor.
  - **Markdown** — the editor, with the rendered view (everything under Files)
    as a second view that follows unsaved edits live.
  - **Images** — shown as today. An SVG adds an editable Source view.
  - **`.env` files** — the editor with `.env` highlighting, and a toggle that
    masks every value (for screen sharing). Masking changes what's shown,
    never what's saved.
  - **Everything else** — the name, size and kind, with **Open in Default
    App**, **Reveal in Finder** and **Open as Text**.
- Adding a file type means adding one handler module to a registry, without
  touching file tabs. Handlers live in the codebase; none are loaded from disk.

## File operations

- The Files tree creates, renames, duplicates, moves and deletes: New File,
  New Folder, Rename (inline), Duplicate, Delete, and dragging an entry onto a
  folder to move it. All are in the entry's right-click menu, with New File
  and New Folder also on the folder header.
- Delete moves to the macOS Trash, never straight to deletion.
- Dragging files from Finder onto a folder in the tree copies them in. A name
  that's taken asks Replace / Keep Both / Cancel, as Finder does.
- The right-click menu also offers Copy Path, Copy Relative Path, Reveal in
  Finder, Open in Terminal (a shell tab in that folder) and Ask Claude.
- Open tabs follow renames and moves. A file deleted from the tree with a tab
  open leaves the tab saying the file is gone, with its unsaved edits intact.
- Every write stays inside the folder or repository it was made from, checked
  in the main process after resolving links, the same as reads. Nothing a
  file contains can cause a write; only the person's own actions do.

## Opening files from outside

- Any file or folder can be opened in Clance from Finder: Open With, dragging
  onto the Dock icon, or making Clance the default app for a type. Clance
  offers itself for every kind of file but makes itself the default for
  nothing unless asked.
- `clance <path>` opens a file or folder from a terminal, and `clance`
  alone opens the current folder. The Homebrew cask installs the command;
  Settings offers to install it otherwise, and says if where it went isn't on
  the shell's `PATH`.
- A file inside a git repository opens against that repository, so it
  arrives with its changes marked. Anything else opens with its own folder
  as the root. A folder opens in the Files sidecar.
- Opening a file launches Clance if it isn't running and shows the file once
  the window is ready. Opening several at once opens each as a tab.

## Search

- ⇧⌘F searches the contents of every file under the Files folder (or the
  current repository), skipping what git ignores unless asked not to.
- Case, whole-word and regular-expression toggles, and include / exclude
  globs.
- Results stream in as they're found, grouped by file with the matching line,
  and a new query cancels the old one. ↩ or a click opens the file with the
  match selected. Results stop at 5,000 and say so.
- It opens from the launcher as a sidecar, like Changes and Files.

## Sessions and the editor

- Selecting code and pressing ⌘L puts a reference to it — the file's path,
  the line range and the selected code — into a session's prompt, without
  sending it. With nothing selected it's the cursor's line. It goes to the session
  tab used most recently; with none open, a new session starts in the file's
  repository.
- Ask Claude on a file or folder in the tree does the same for the whole
  path.
- ⇧⌘T reopens the most recently closed tab.

## Main window

- Opens from the Dock icon or the menu-bar menu. While setup is incomplete it
  opens on launch.
- A launcher opens Sessions, Changes, Files, Search, Dictation, Settings, or
  a plain shell terminal. Changes, Files and Search are sidecars: they open
  in a pane of their own on the right when the window can take one, and files
  open as tabs beside it. A later sidecar joins the first's pane as a tab
  rather than taking another quarter of the window. Sections open as tabs;
  reopening one focuses it.
- Tabs can be split into up to four panes by dragging to an edge (at most a
  2×2 grid), resized by dragging dividers, and reordered. The layout is
  restored on launch.
- Moving a tab to another pane, or switching away from it and back, never
  loses what it was doing. Sessions keeps its search, filter, selected row,
  an open peek and where that peek was scrolled; Dictation its search and
  date filter; Settings its open groups; Search its query and results; Files
  its open folders; every tab its scroll position. None of them flashes back
  to "Loading…" — they redraw as they were and refresh quietly.
- The parts worth keeping — a search, a filter, scroll positions, where a
  file was left — also survive a relaunch and come back with a tab reopened
  by ⇧⌘T. What a tab was showing (lists, results) is re-read instead.
- A session with nothing in it yet is shown as "Clance Chat" — one name for
  that state, wherever it appears. A tab takes the conversation's real title
  as soon as it has one.
- Terminal tabs survive tab switches and window reloads. A session tab shows
  a live dot and a status line with its folder and start time, and can be
  popped out into the widget.
- A tab too narrow to show its name shows only its icon, rather than a
  clipped word — but only in a pane that's a small share of the window (under
  45% of its width). A bigger pane keeps its names even when they don't all
  fit, and its tab row scrolls sideways. Hovering any tab for two seconds gives its full name — for a
  file tab, its whole path, since the label is only a basename and two tabs
  called `index.ts` are otherwise the same tab twice.
- Right-clicking a tab offers Close Tab, Close Other Tabs, Close Tabs to the
  Left / Right and Close All (all within that tab's pane), and Move to Pane
  for each other pane. Closing every tab of the only pane leaves the Sessions
  tab. A session tab adds Close and Stop Session, Open in Floating Window and
  Copy Session ID; a file tab adds Copy Path, Copy Relative Path and Reveal in
  Finder. Splitting stays a drag, not a menu item.
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
- **Editing keeps up.** Typing has no perceptible lag in a 10,000-line file,
  and a 1 MB file opens in well under a second.

## Out of scope

- Windows, Linux and Intel Macs.
- Notarization and the Mac App Store.
- Ambient or background screen watching.
- Cloud sync and telemetry.
- A custom chat UI, or reimplementing anything the CLI already does.
- Clance writing or deleting session transcripts.
- A full git client: history and graph views, branching, merging, rebasing,
  stashing, conflict resolution or anything that rewrites history.
- A debugger, a test-runner UI, or refactoring tools. Changes across a
  codebase are a prompt to a session.
- Language servers: completion, go-to-definition, hover types and
  diagnostics (see Ideas).
- Auto-save.
- More than one folder open in Files at once.
- Remote development (SSH, containers) and notebooks.
- A plugin marketplace or installer, and file-type handlers or extensions
  loaded from disk.
- Self-updating.
- For dictation: speaking responses aloud, non-English-first transcription,
  meeting recording, speaker diarization, transcribing audio files, and live
  two-way voice conversation with the model.

## Ideas (not committed)

- **Language servers** — completion, go-to-definition and diagnostics for the
  languages used most, started per repository on demand.
- **User handlers, sandboxed** — file-type handlers loaded from
  `~/.clance/handlers`, run in a sandboxed frame that talks to Clance only by
  message, so a handler can't reach the terminal bridge.
- **More handlers** — a table over a CSV, a tree over JSON, a hex view.
- **Command palette** (⇧⌘P) over every command and setting.
- **Replace across files** from the search results.
- **Vim keybindings** as an editor setting.

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
