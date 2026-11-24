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
- Distributed as a Homebrew cask (`brew install --cask damiensmith1/tap/clance`)
  that downloads only the app: the dictation engine ships inside it, so
  installing never builds anything, on any supported macOS.
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
- The one exception is the first session in a folder Claude Code hasn't been
  trusted in yet. A background agent can't show the trust prompt, so Clance
  opens a plain `claude` in a terminal tab there instead: accept the prompt
  and that is the session. It's interactive, so closing the tab ends it, and
  it isn't brought back on relaunch. Sessions in the folder after that are
  background agents as usual. Clance never accepts the prompt on anyone's
  behalf.
- Every session is reachable from the Work tab (see Work): running ones as
  part of the work they're doing, past ones in its History, newest first —
  every Claude Code transcript on the machine, from any project.
- Opening a session attaches to it if it's running, or resumes it in its own
  recorded working directory. Opening one already open in a tab goes to that
  tab.
- Sessions a program started (a plugin's commit reviews, an SDK script) are
  hidden from History and the widget, and viewable under an Automated filter.
- A past session can be resumed in a tab, the widget or Terminal, peeked at,
  pinned (pinned ones sit above the rest, still subject to the search and
  filter) and archived or restored.
- A session can be peeked at without opening it — Space or the menu shows
  what was said, read straight from the transcript: messages in full, tool
  calls as one line each, their output behind a toggle. It opens at the end
  of the conversation, is scrollable from the keyboard, and on a session too
  long to show whole it keeps the most recent messages. A peek never changes
  a session, and stays responsive on transcripts of any size.
- Clance never deletes a transcript that has user messages — History
  includes other projects' Claude Code history.
- New sessions open in a default directory set in Settings (`~/.clance` if
  unset). "New session here" in Work and "Open in…" can choose another; recent choices are
  remembered.
- Any session started in Clance can be resumed with `claude --resume` in a
  terminal, and vice versa.

## Work

- One tab, the home tab, shows every change the user's sessions are making,
  in every repository, branch and worktree they work in, and every session,
  running or past. A narrow Changes pane beside it shows whatever is picked,
  and a file's diff opens in a tab. All three look and behave like the rest
  of the app: one-line rows, the Sessions page's search and keyboard, the
  Changes pane's bar and lists.
- **In flight** lists what needs a look now, grouped by what the user has to
  do: needs you (a session waiting on the user or failed), ready to review,
  working, open with nothing changed, branches with no session, and merged,
  ready to clean up. Work with nothing to do isn't listed there.
- Every running session is listed in In flight under its own name, with the
  checkout where most of its changes are, and is found by searching for that
  name.
- **Repos** lists every repository with every checkout (its folder and its
  worktrees) and local branch: where each is checked out, how far ahead of
  and behind the base branch it is, and its state. A repository can be
  fetched from its row.
- **Past sessions**, **Archived** and **Automated** are the session history,
  searchable, with pinning, archiving (with Undo) and restoring.
- Repositories are found without configuration: wherever sessions run or
  have edited files, the folders sessions were started in, and the
  repositories Clance has been pointed at.
- Picking a row shows it in the Changes pane, opening the pane if it isn't
  open, without taking the keyboard away from the list. ↩ opens its session.
  The selection only moves when the user moves it.
- The Changes pane shows a checkout, a branch checked out nowhere, or a past
  session. Its branch menu lists every checkout and branch of the repository,
  and picking one shows it there without moving anything on disk.
- For a checkout it shows what's uncommitted (staged per file, with a commit
  box), and when its branch has commits of its own, everything the branch
  changed against the base, or for the base branch what isn't pushed. For a
  branch, everything it changed against the base. For a past session, the
  files it edited, per checkout, and the commits it made.
- Under the files, the commits the work is made of (not on the base, or not
  pushed), else the recent ones. Picking one shows that commit's files.
- Clicking a file opens its diff across what's shown — uncommitted, the
  branch, or a commit — in a read-only tab, reused for the next file until
  it's kept (double-click, or Keep open). The tab can open the file itself to
  edit it, and follows the disk when it shows the working tree.
- The sessions working in a checkout are shown with it, and can be opened or
  replied to: the reply is typed into the session's prompt and sent. A
  running session can also be stopped, peeked at, or opened in the widget.
- A session's changes are attributed to it by where it runs and which files
  it edited, read from its transcript, never by listening inside it. What
  changed always comes from git, so it's right however files were edited.
- Actions, each refused with git's own reason rather than forced:
  - open a branch as a worktree, under the repository's `.claude/worktrees/`,
    without moving any checkout;
  - check a branch out in the repository's folder, refused while that folder
    has changes and warned when a session is working there;
  - merge a branch into the base, in the base's clean checkout, undone if it
    conflicts;
  - clean up a merged worktree (remove it and delete its branch) when nothing
    there could be lost, and delete a merged branch;
  - stage, commit (with an optional push), push (publishing a new branch),
    pull (fast-forward only), fetch, revert a commit, and discard a file's
    uncommitted changes;
  - open a terminal or a new session in a checkout, open its changes in
    lode, and open the repository's web remote.
- Anything that removes or rewrites asks first, in the pane, saying what will
  happen and what was checked.
- Opening the tab never waits on git after the first few seconds of a
  launch, and nothing on screen blinks when it refreshes: lists keep what
  they show until the next one is read, and an unchanged refresh changes
  nothing.
- Every git failure is reported in git's own words, and nothing is reported
  as done that didn't happen.
- Not included: hunk staging, rebases, stashes, and anything that rewrites
  history. Those stay in a terminal or in a session.

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
  already there. Files open in the largest pane, so a file clicked in Files or
  Changes opens beside the list rather than over it.
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
- A folder Claude Code hasn't been trusted in shows a banner in Files with
  a button that opens a terminal running `claude` there, to answer its
  trust prompt; the banner goes once it's trusted.
- One folder at a time, from a switcher offering the default session
  directory, the folders it has been pointed at before (including ones chosen
  with "Choose folder…"), recently used directories, wherever running agents
  are working, and any other folder. It reopens on
  the folder it was last pointed at, independently of the Changes repository.
- Rows have VS Code-style file-type icons (Material Icon Theme), by file
  name, extension and folder name.
- Directories expand and collapse, one level read at a time. Which are open
  is remembered per folder for as long as the app is running.
- The tree keeps up with the disk: a file a session creates, deletes or
  renames appears or goes within a moment, in any directory that's open,
  without switching away and back.
- Every file in the folder is listed, including ones git ignores; those are
  dimmed, and a toggle hides them. Ignored files open like any other, without
  a diff. ⌘P still searches only what git isn't ignoring. Outside a
  repository nothing is ignored and the toggle is absent. Dotfiles are always
  shown.
- When git can't say what a repository ignores, the tree lists everything and
  says so. Silently showing node_modules looks exactly like a project that
  ignores nothing.
- Clicking a file opens it as a file tab in the largest pane. A file inside a
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
- Find and replace (⌘F, ⌥⌘F) is a small bar floating over the top right of
  the code, never pushing it down: match case, whole word and regular
  expression toggles, "3 of 12", ↩ / ⇧↩ for next and previous, and a replace
  row (↩ replaces one, ⌘↩ all) where the file is editable. It opens with a
  one-line selection as its query, highlights every match, jumps to the
  nearest as you type, and Esc closes it and returns to the code.
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
  as the root. A folder opens in the Files pane.
- Opening a file launches Clance if it isn't running and shows the file once
  the window is ready. Opening several at once opens each as a tab.

## Search

- Search lives in the Files tab: its search button, ⇧⌘F, or ⌘F while the
  tab has focus swaps the tree for a search of the contents of every file
  under the Files folder, and Esc, ⌘F or the button again brings the tree
  back as it was left. Find in Folder… on a
  folder (right-click) searches just that folder, shown as "in src/main"
  with a ✕ to widen it to the whole Files folder. What git ignores is
  skipped unless asked not to.
- Case, whole-word and regular-expression toggles, and include / exclude
  globs.
- Results stream in as they're found, grouped by file with the matching line,
  and a new query cancels the old one. ↩ or a click opens the file with the
  match selected. Results stop at 5,000 and say so.
- The search runs again when the window comes back to the front, so results
  keep up with files sessions have changed.

## Sessions and the editor

- Selecting code and pressing ⌘L puts a reference to it — the file's path,
  the line range and the selected code — into a session's prompt, without
  sending it. With nothing selected it's the cursor's line. It goes to the session
  tab used most recently; with none open, a new session starts in the file's
  repository.
- Ask Claude on a file or folder in the tree does the same for the whole
  path.
- ⇧⌘T reopens the most recently closed tab.

## lode tabs

- A lode tab shows a project's code as cards on a canvas (lode): a symbol's
  code with arrows to what it calls and what calls it, folds that open in
  place, and git changes marked when asked. Cards can be edited in place.
- Open a flow from a file or folder in the Files tree (Open in lode), from
  a file tab (lode: the symbol at the cursor), or the launcher (the Files
  folder). A flow for a folder that already has one opens in it.
- The tab's search finds a symbol by name, or with `/` builds the flow
  that answers a question, quickly or as a crawl that reads more (a picker
  beside it, kept with the tab). `/` needs a Jev key, set in Settings or
  setup (or `TYPESAFE_API_KEY` in the environment, or the repo's `.env` in
  a dev run); without one it's off and points to Settings. A key set takes
  effect in open lode tabs at once, and is kept encrypted, never shown.
- A card's title opens the file in a file tab at that line.
- While a lode tab is showing in the main pane, opening a file (Files,
  Changes, search, ⌘P) adds it to that flow as a card instead of opening a
  file tab, when the file is in the flow's project.
- Ask Claude opens a new Claude session beside the lode (in another pane,
  or a new one to its right) with a pointer to the canvas in its prompt,
  without sending it; Claude sessions can see any open lode tab's cards and
  the project's code graph, and draw on the canvas (add cards, build a flow
  for a question, expand, close, select, focus, show changes), and opens at once (one session is kept warm,
  in the folder of the lode tab being shown). Pressing it again while that
  session is open goes to it and pastes the cards there instead of opening
  another. Copy context puts
  the same on the clipboard.
- A lode tab can follow a Claude session (a Follow picker in its toolbar,
  listing the sessions open in Clance that work in the tab's project; Ask
  Claude's session is followed from the start). As the session writes
  code, by any tool, in any folder (tracked by git or not), it appears as
  cards and the view moves to them, unless the user moved the canvas in
  the last few seconds; code it writes in a worktree or another repo comes
  onto the same canvas, framed as a group named for that folder. When its
  turn ends the view frames what that turn did (the code it changed and
  the notes it drew), not the whole canvas. A followed session is asked to
  explain with notes, diagrams and groups on the canvas and keep its
  written reply short. Only sessions Clance started can be followed.
- A lode canvas can be saved under a name and opened again later from a
  list of saved canvases (by project), live: its code as it is now, its
  notes, groups and layout as saved. Save (⌘S, when not editing a card's
  code) writes over it, asking for a name the first time. Export writes a
  copy anywhere, without saving. A saved canvas can be deleted from the
  list (to the Trash, after asking). Closing a lode tab with unsaved
  changes asks to save them first, like a file. A lode tab shows a red dot while it has
  unsaved changes: a saved canvas changed since, or one never saved that
  has cards (moving around the canvas isn't a change).
- The Changes pane opens every uncommitted change in a checkout as a
  lode tab of the changed functions, with the changes marked.
- Reading a project never freezes the window, and a canvas comes back as it
  was after switching tabs, ⇧⌘T or a relaunch.

## Main window

- Opens from the Dock icon or the menu-bar menu. While setup is incomplete it
  opens on launch.
- A launcher opens Sessions, Changes, Files, Dictation, Settings, or
  a plain shell terminal. Sections open as tabs; reopening one focuses it
  wherever it is.
- By default, tabs open in the largest pane, except Changes and Files, which
  open in the small pane on the right (one no wider than 40% of the window),
  made at a quarter of the width if there isn't one. Where the layout has no
  room for another pane, they open in the rightmost pane. These are only
  defaults: which pane a tab is in never changes where the next one opens,
  and a tab goes wherever it's dragged.
- Tabs can be split into up to four panes by dragging to an edge (at most a
  2×2 grid), resized by dragging dividers, and reordered. The layout is
  restored on launch.
- Moving a tab to another pane, or switching away from it and back, never
  loses what it was doing. Sessions keeps its search, filter, selected row,
  an open peek and where that peek was scrolled; Dictation its search and
  date filter; Settings its open groups; Files its open folders, and
  its search and results; a file tab its find bar; every tab its scroll position. None of them flashes back
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
  for each other pane. Closing every tab of the only pane leaves the Work
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
  5. **lode** (optional, skippable) — a Jev key for lode's `/` questions.
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
