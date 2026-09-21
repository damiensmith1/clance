---
title: Design
tags: [clance, design]
---

# Design

How Clance is built. What it does is in `requirements.md`; why is in
`background.md`. This doc describes the current system — the history of how
it got here is in git.

## Architecture at a glance

One Electron app, three renderer surfaces:

| Surface | Renderer | Preload | Role |
|---|---|---|---|
| Popup widget | `src/popup/` (vanilla JS) | `src/preload/popup.ts` | Floating terminal opened by ⌥Space |
| Main window | `src/mainWindow/` (Preact + htm) | `src/preload/mainWindow.ts` | Sessions, Dictation, Settings, terminal tabs |
| Dictation HUD | `src/dictationHud/` (vanilla JS) | `src/preload/dictationHud.ts` | Non-focusable recording indicator; also captures the audio |

Everything with OS or process access lives in the main process
(`src/main/`). Renderers are context-isolated and talk to it only through
their preload's IPC surface.

The central idea: **Clance never runs a conversation itself.** Every
conversation is a real Claude Code CLI process, started as a background
agent and shown through an embedded terminal. Clance adds OS integration
around it — hotkeys, windows, a local MCP server of screen/keyboard/mouse
tools, and on-device dictation.

Clance does make model calls of its own, but only to *decide*, never to
write: the assistant (⌥A) classifies speech into actions Clance already
knows how to perform. No model output is ever shown to the user as prose —
anything open-ended is handed to a Claude Code session. See "Assistant".

### Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | Electron, TypeScript main process | Renderer code is plain ES modules, copied to `dist/` by `npm run build` — no bundler |
| Reasoning, tools, session storage | The `claude` CLI, as background agents | See "Sessions" |
| Terminal | `node-pty` + `xterm.js` (vendored under `src/shared/vendor/xterm/`) | |
| Main window UI | Preact + htm, vendored as one standalone module | No CDN, no build step |
| Hotkeys | Electron `globalShortcut` | No key-up events, hence press-to-toggle dictation |
| Keyboard/mouse/window access | `@nut-tree-fork/nut-js` | Needs Accessibility |
| Screenshots | Electron `desktopCapturer` | Needs Screen Recording |
| Local tools transport | `@modelcontextprotocol/sdk`, Streamable HTTP | See "Local tools server" |
| Speech-to-text | Homebrew `whisper.cpp` (`whisper-cli`), ggml models, Metal | Spawned per utterance |
| Dictation history | `node:sqlite` + FTS5 | Built into Electron's Node — no second native addon to rebuild |
| Git | The `git` binary, via `execFile` | See "Changes pane" |
| Syntax highlighting | Hand-rolled (`src/shared/syntax.js`) | See "Syntax highlighting" |
| Packaging | `electron-builder`, self-signed | See "Packaging and distribution" |

### Local data

Clance's own state lives in `~/.clance/` (`SESSION_CWD`, `src/main/paths.ts`),
which is also the working directory for sessions that have no project:

| Path | Contents | Owner |
|---|---|---|
| `config.json` | Shortcuts, default directory, recent directories, the Changes pane's last repo, enabled local tools, dictation settings | `config.ts` |
| `archived-sessions.json` | Archived session ids | `archivedSessions.ts` |
| `window-layout.json` | Main window pane/tab tree; tabs for sections that no longer exist are dropped on restore | `windowLayout.ts` |
| `pool.json` | The pre-warmed popup session | `agentPool.ts` |
| `loginShellPath.json` | Cached login-shell `PATH` | `ptyManager.ts` |
| `local-tools.json` | Local tools server port and server key suffix, saved once per install | `localToolsServer.ts` |
| `local-tools-headers-<port>.json` | This launch's local tools bearer token, as the header `headersHelper` returns (mode `0600`) | `localToolsServer.ts` |
| `dictation.db` | Transcript history | `dictationStore.ts` |
| `models/` | Speech model weights | `whisperModels.ts` |
| `dictation/` | Per-utterance WAVs (deleted after transcription unless `keepAudio`) | `dictation.ts` |
| `dropped-files/` | Copies of files dropped onto a terminal | `dropFiles.ts` |

Session transcripts are never written by Clance — the CLI writes them to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` like any other session.
Config readers merge defaults per nested object (`shortcuts`, `dictation`)
so a config written by an older version picks up new keys. A dev build
(`!app.isPackaged`) uses `local-tools.dev.json` and
`local-tools-headers-<port>.dev.json` instead, so it can run next to the installed
app.

## Sessions

### Background agents, attached

Every session Clance opens is a `claude --bg` background agent — a real
process supervised by the CLI's own daemon. A terminal tab or the popup is
only a `claude attach <id>` client onto it. Closing a tab, switching away
from it, or quitting Clance kills the attach client, never the conversation.
Ending a session is explicit: the Sessions tab's Stop action runs
`claude stop <id>`, which leaves it resumable.

`src/main/agentSessions.ts` is the single place `claude` processes are
started:

- `spawnBackgroundAgent(name, args, cwd)` runs `claude --bg -n <name> …` and
  parses the short id from stdout (`backgrounded · <id> · <name>`, with ANSI
  codes stripped — they're emitted even when piped).
- `resolveOpenArgs(sessionId, name, mcpArgs)` decides how to open an existing
  session. A live agent is attached as-is. A stopped agent already in
  `claude agents --json --all` is attached if it was minted in the session's
  own working directory (`attach` restarts it). Anything else is revived with
  `claude --bg --resume <sessionId>` in the directory recorded in its
  transcript. Concurrent opens of one session share a single in-flight
  resolution, since two `--bg --resume` calls would fork two copies.
- `listAgents`, `stopAgent`, `rmAgent` wrap `claude agents --json`, `stop`,
  `rm`.

**Everything a session is configured with is fixed when it's minted.**
`attach` accepts no other flags, so settings (`--settings`, which tells the
CLI the terminal background is light — it emits truecolor diff colours that
xterm's palette can't remap), local tools (`--mcp-config`, `--allowedTools`)
and the popup's system prompt are passed to `--bg`. The CLI saves those flags
with the agent and reuses them whenever `attach` restarts a stopped one, and
a live session keeps them until it's stopped. The local tools config is
therefore identical across Clance launches (see "Local tools server"), so
old sessions keep reaching the server.

Every `claude` process gets:

- **The login-shell `PATH`.** A GUI-launched app inherits launchd's minimal
  `PATH`, which doesn't contain `claude`. `ptyManager.ts` resolves
  `$SHELL -ilc 'echo -n $PATH'` in the background at startup, caches it to
  `loginShellPath.json` for the next launch, and refreshes it every launch.
  Callers await the in-flight resolution rather than blocking — a synchronous
  fallback here once froze the main process, including the local tools
  server, for as long as the user's shell startup took.
- **`CLAUDE_CODE_AUTO_CONNECT_IDE=false`,** so the CLI doesn't attach to
  whatever editor happens to be open.
- **An argv array, never a shell string,** so arguments carrying user or
  screen-derived text can't inject commands.

### Working directory

- New sessions open in `getDefaultDirectory()` — the Settings value, or
  `~/.clance` if unset. Both "New session" (Sessions tab) and the popup's
  "Open in…" can instead mint in a picked directory; picks are remembered in
  `recentDirectories` (most recent first, max 8).
- Reopening a session always uses the `cwd` recorded on its transcript's
  user messages (`chatHistory.ts`'s `cwdForSessionId`), never the default.

### Pre-warmed popup session

Minting takes a noticeable fraction of a second, so `agentPool.ts` keeps one
spare popup session running (`POOL_SIZE = 1` — one hotkey, one user). A spare
records the `cwd` and mint args it was started with. `claimPoolSpare` only
hands it out if both match what a fresh mint would use right now; otherwise
it's stopped and removed, and the popup mints fresh. This catches a changed
default directory, and a spare warmed before Accessibility was granted (which
would otherwise be missing its tools). The pool refills after every claim,
at startup, and when setup completes.

Pool spares and popup sessions with no real user message yet are hidden from
the Sessions tab (matched by the `Clance popup` name prefix, which can't be
orphaned the way an in-memory id set could). Closing the popup on such a
session stops and removes it, so empty conversations don't accumulate.

### Session list

A session with nothing in it yet is called `SESSION_PLACEHOLDER_TITLE`
("Clance Chat"), defined once in `chatHistory.ts` and used everywhere that
state is shown: a Sessions row, a tab, a peek header, and the name a
main-window mint is given, so `claude agents --json` agrees too. The
renderer never holds the string — `agents:spawn-new` names the agent and
returns the name for the tab to wear. Emptiness itself is never that
string: `readSessionHead` reports a transcript with no real user message as
`title: null`, and `hasRealUserMessage` and the empty-session filter test
for null. They used to compare the title against the placeholder's text,
which meant a first message of exactly "New conversation" read as an empty
session — and the widget's close path deletes sessions it believes are
empty.

`chatHistory.ts` scans `~/.claude/projects/*/*.jsonl` directly — every Claude
Code session on the machine, not just Clance's. Titles come from the first
real user message, read line by line rather than parsing whole transcripts
(they reach several MB). Messages the CLI injects for local slash commands
(`<local-command-caveat>` etc.) and the context preambles Clance used to
type into the widget are skipped so they never become a title.

The Sessions tab (`ChatsSection.js`) is one table: session (title over its
folder), project, state, updated. It has no header row, since each column is
plain from its content; a line of keyboard hints sits above it instead. Live sessions come first, from
`claude agents --json` polled every 5 s, titled from the matching transcript.
Their project is the agent's `cwd` basename, and their state comes from the
CLI's `state` field: `working` (signal dot), `blocked` shown as "needs you"
(amber), `failed`, `done`, or the `busy`/`idle` status otherwise. Closed
transcripts follow, newest first, minus whatever is live. A filter menu
narrows to running, closed, archived (`archived-sessions.json`) or automated.
Archiving is the only form of removal: deleting a transcript could destroy real
work from an unrelated project.

Automated sessions are ones a program started rather than a person, read from
the `entrypoint` the CLI stamps on each transcript entry: `sdk-py`, `sdk-ts` or
`sdk-cli` (`claude -p`), as opposed to `cli` for interactive sessions,
Clance's `--bg` agents included. The security-guidance plugin, for one, runs
two Agent SDK passes per commit. They only appear under the Automated filter,
never in All sessions, Closed, search or the widget's resume list; an archived
one shows under Archived.

Pinned sessions sort above everything else, whatever their date or state —
a closed session from last week sits above a running one from this morning.
`pinnedSessions.ts` keeps the ids in `pinned-sessions.json`, the same
Clance-local shape archiving uses, and a slightly heavier rule closes the
group. Pinning decides where a row sits, not whether it is exempt: the
filter and the search still choose what's in the list at all, so a pinned
closed session doesn't appear under Running. The renderer holds the pinned
ids as one set rather than reading the flag off each row, since a live agent
whose transcript hasn't been written yet has no summary to carry it.

The pin shares the status dot's column rather than taking one of its own:
two indicator columns left every ordinary row — closed and unpinned, which
is most of them — with an empty gutter before its title. Exactly one of the
pair shows at a time. The dot at rest, the pin when the row is hovered or
pinned, so an unpinned, idle list carries no pin ink at all and the
affordance appears where the hand already is. A pinned row that is also
running would lose its dot that way, so the pin takes the dot's colour
instead — amber on a session that needs you — and goes on doing its job:
the shape says pinned, the colour says state.

The page is keyboard-first. ⌘K anywhere in the main window, terminals
included, switches to Sessions (opening it if needed) and focuses the search
field. `Shell.js` catches it in the capture phase so a focused terminal never
sees it, and `focusSessionSearch()` holds the request until the section has
mounted. The search dropdown lists
the top matches and then "start a new session in" the default folder (⌘↩),
recent folders or a chosen one (⌘O). In the table ↑↓ select, ↩ opens in a tab,
⌥↩ opens in the widget, ⌘⌫ archives (or stops a live session) and ⌘N starts a
new session. Archiving shows a toast with Undo. Right-clicking a row adds Peek,
Resume in Terminal, Copy folder path, Reveal in Finder and Pin/Unpin. Those go through
`sessionActions.ts`, which re-validates the renderer's ids and paths. Resume
in Terminal writes a `.command` file under `~/.clance/terminal` that runs
`claude attach <agent>` or `claude --resume <session>` in the session's folder
through the login shell, and opens it; scripting Terminal with AppleScript
would need the Automation permission. Loading shows skeleton rows; an empty
history shows a New session and Choose folder… prompt.

### Peeking at a session

Space, or Peek in a row's menu, opens the session's transcript over the table
— what was said and where it got to, without attaching a terminal to it.
Read-only: everything that changes a session stays in the row's menu. Space
again, Escape or a click outside closes it, and Open / the pop-out button
carry on into the session itself.

It opens scrolled to the end of the conversation, since where a session got
to is what a peek is read for; scrolling up walks back in time. ↑/↓ read it
from the keyboard — handled rather than left to the browser, so they work
wherever focus sits and can't reach the table underneath — while the
scrolling region itself holds focus, so Page Up/Down, Home and End scroll it
natively. Showing tool
output grows every turn at once, so the view sticks to the end only for a
reader who was already there, and otherwise keeps their place.

`peekSession()` in `chatHistory.ts` does the reading, keyed by session id
because a live row only knows its id. It streams the JSONL rather than
holding it whole — the largest transcript on the author's machine is ~115 MB,
almost all of it tool output — and bounds what it returns: 4 000 characters
per message, 220 per tool result, and 500 blocks, trimmed from the *front* as
it reads so what survives is the end of the conversation, with a line above
them saying the earlier messages aren't shown. The whole file is still read
(451 ms for that 115 MB one, a few ms for a normal session), which is what
lets the header count every message and date the session from its real
start.

What it keeps is what a person said and what Claude replied. A tool call
collapses to its name and its one identifying argument — the path for
`Read`/`Edit`, the command for `Bash`, the pattern for `Grep` — with the
result attached from the matching `tool_result` entry (by `tool_use_id`,
which arrives in a later entry) and shown only behind the footer's toggle.
Paths are printed relative to the session's own `cwd`. Consecutive calls are
drawn as one indented cluster rather than as separate lines, so a stretch of
work reads as a stretch of work. A slash command
collapses to its name, since the CLI records its expansion as an ordinary
user message. Skipped entirely: `isSidechain` entries (a subagent's own
conversation, which belongs to the `Task` chip that spawned it), `isMeta`
ones (context the CLI injected as if the user had typed it), and `thinking`
blocks — the CLI writes those with their text empty, so there is nothing in
a log to show.

The header prefers the CLI's own `ai-title` over the first message's opening
words, and carries the project, git branch (unless it is a detached `HEAD`),
model, message count, how long the conversation ran and when it last moved.
Claude's replies render through `markdown.js`, which escapes its input before
introducing any tag of its own; the user's own messages are shown as typed.

## Terminals

### Main process

`ptyManager.ts` maps each `terminalId` to `{ proc, win, outputBuffer }`:

- `createPtySession` is idempotent per id, so a renderer that remounts or
  reloads re-attaches to the running pty instead of spawning another.
- The last 200,000 characters of output are buffered and replayed into a
  fresh xterm after a window reload.
- `reparentPty` retargets a pty's output to a different window — how "Open
  in App" moves a live popup terminal into the main window without
  restarting it.

### Renderer

- xterm.js uses the app's light palette. A `ResizeObserver` keeps
  `fitAddon.fit()` and the pty's `cols`/`rows` in sync; resizes are always
  forwarded. Every client attached to one agent shares that agent's single
  terminal size, so the same session open in two panes reflows both — an
  accepted edge case.
- `TerminalSection.js` keeps each xterm instance and its DOM node in a
  module-level registry outside Preact. Unmounting (switching tabs, moving a
  tab between panes) parks the node off-screen; only closing the tab
  (`destroyTerminal`) kills the pty. This is what keeps plain shell tabs —
  where the pty *is* the process — alive across tab switches.
- On reload, shell tabs keep their `terminalId` and replay the buffer; agent
  tabs get a fresh id and a fresh `attach`, which repaints on its own.
- **File drop.** The preload resolves a dropped file's path with
  `webUtils.getPathForFile`, main copies it into `~/.clance/dropped-files/`,
  and the copy's path is bracketed-pasted into the input, unsent. The copy is
  needed because files dragged from macOS UI (the screenshot thumbnail, for
  one) are often file promises whose staging copy is deleted moments after
  the drop. It narrows that race; it can't close it.

## Popup widget

`src/main/popupWindow.ts`, `src/popup/`.

### Window

Frameless, transparent, always on top, resizable (minimum 360×220). The
toolbar is the drag region, with its buttons opted out. The window opens
near the cursor until the user drags it, after which it stays put (the
`move` event from Clance's own `setPosition` is ignored). It is never
destroyed, only hidden, and IPC to it waits on `did-finish-load` — a message
sent before the renderer attaches its listener is silently dropped.

### Opening

1. `captureFrontmostWindow()` runs alongside window preparation, before the
   popup takes focus. Nothing captured is shown to the model; it only sets the
   default target for the read tools, `write_field` and `click_element`.
2. The window is revealed immediately in a loading state.
3. The pool spare is claimed, or a session minted, and the popup receives
   `["attach", id]`.

An `opening` flag stops a second hotkey press from minting twice. If the
popup is dismissed while a mint is in flight, it isn't re-shown and the
minted session is cleaned up.

Sessions are minted with a static system prompt (`localToolsSystemPrompt`)
via `--append-system-prompt … --system-prompt-snapshot off`, naming the local
tools and saying when to reach for them. Because it's the same text for a
given surface, a pool spare can carry the popup's copy. It's omitted when
local tools aren't available.

It takes a surface — `popup` or `window` — because the aiming rule differs.
The popup records the app it was opened over, so its reads need no `app`
argument; a main-window tab has no such record and Clance is the frontmost
app, so that copy tells the model to name an app from `list_open_windows`
instead. Main-window sessions get the prompt too (`sessionMintArgs`), both
on a new session and on a resume that respawns.

The prompt also states precedence against the model's *own* tools, which is
the part that decides whether these get used at all. A session usually also
has a browser-driving MCP server and a shell, and defaults to them out of
habit — fetching a URL to answer a question about a page the user already
has open. The line drawn is "what is on screen now" (Clance's tools, which
are also the only ones that can see a non-browser app) against "navigate or
automate the web" (the browser's own).

The screen is deliberately not captured on open. The model calls
`look_at_screen`/`read_selection` when a request needs them; a snapshot on
every open would cost latency and be stale or irrelevant most of the time.

### Dismissing

- **Close** (the ✕, or ⌘W on the widget — both call `closeWidget`) hides the
  window, forgets the session, and removes it if it never got a real user
  message.
- **Hide** (and ⌥Space while open) keeps the session live. It calls
  `popup.hide()` then, if the widget had focus, `focusTarget()` to refocus the
  window the user came from. `app.hide()`
  isn't used: it deactivates the whole app, and the next reveal reactivates
  it, which reopens the main window alongside the popup. The next ⌥Space
  re-captures the frontmost window and reveals the same conversation, with
  focus in the terminal rather than whichever toolbar button last had it.
- The popup never hides on blur. It used to, and vanished mid-drag or
  whenever another app briefly took focus.
- `index.ts`'s `activate` handler only opens the main window when no other
  window exists, and doesn't count the HUD — otherwise a Dock click after one
  dictation would do nothing.

### Moving between popup and main window

- **Open in App** reparents the popup's pty into a new main-window tab.
  The tab title comes from the session id: `resolveSessionId` for attached
  sessions, or, for a session with no id yet, the transcript whose file
  birth time matches the pty's spawn time (`findRecentClanceSessionId`).
- **Open in Widget** (a button on a main-window session tab) opens that
  session's attach args in the popup. It isn't offered on shell tabs.
- **Open in…** resumes any session through `resolveOpenArgs`, or mints a new
  one in a chosen directory (never pooled — the directory isn't known in
  advance). Nothing is typed into a resumed session. It's the toolbar title
  itself: a status dot, the session's folder and title
  (`popup:session-info`), and a chevron. ⌘K anywhere in the widget, terminal
  included, opens it with its search focused; ⌘K again or Esc closes it and
  returns focus to the terminal.

If a session fails to start — a spawn error, or the CLI exiting non-zero
within 8 s — the popup swaps the terminal for an error state with Try again
(`popup:retry`) and Open Settings, rather than leaving a dead terminal. A
hint bar under the terminal shows the hide and ⌘K shortcuts and the
session's folder.

### Keeping the widget out of the frame

The widget sits on top of whatever is being asked about, so no screenshot
Clance takes may include it. `screenCapture.ts`'s `withWidgetConcealed` sets
the window's opacity to 0 — not `hide()`, which hands focus to whatever
macOS considers "next" and drags in a pile of window-activation side
effects — waits 150 ms for the window server, and restores it afterwards,
including when the capture throws. It wraps `captureActiveDisplay` itself,
so every caller is covered, and nests if one conceal ends up inside
another: only the outermost restores. An already-hidden widget costs
nothing — no wait, no restore. The window registers itself with
`screenCapture.ts` rather than being imported by it, since `popupWindow.ts`
already imports `localToolsServer.ts`, a caller of the same capture.

Clance used to hand the screen over by itself: ⌘⇧R captured the frontmost
window's title, the selection and a screenshot, pasted the image into the
terminal and typed a preamble describing it, unsubmitted, for the user to
add their question to. That's gone. A session reads the screen through the
local tools instead, when it decides it needs to — which costs an image
only when one is wanted, gives the model the question before it looks, and
works from any session rather than only the widget. The preamble was its
own evidence: `chatHistory.ts` had to strip it back out so it wouldn't
become the session's title, and still does for transcripts recorded before
the change.

## Local tools server

`src/main/localToolsServer.ts` gives sessions tools that act on the GUI, next
to the CLI's own file and shell tools. Handlers are in `frontApp.ts`.

### Tools

| Tool | Tier | Mechanism |
|---|---|---|
| `look_at_screen` | auto | `desktopCapturer`, display under the cursor, longest edge resized to 1568 px, returned as an MCP image block. The widget is concealed for the capture. Reports that Screen Recording is off rather than failing opaquely. |
| `read_selection(app?)` | auto | `AXSelectedText` from the accessibility tree — no clipboard, no keystroke |
| `read_focused_field(app?)` | auto | The focused field's text, selection and caret. Says so and stops when the field is a password one. |
| `read_window_text(app?, maxChars?)` | auto | A window's text from the tree rather than a screenshot to interpret |
| `list_open_windows` | auto | Apps and their window titles, from the accessibility tree, with the frontmost marked. Falls back to window-server titles without it. |
| `click_element(target, app?)` | auto | Finds a control by its visible text in the tree and `AXPress`es it; clicks its frame's centre when it offers no press action. Names the near matches rather than clicking the wrong one. |
| `click_at(x, y)` | auto | Click at fractions (0–1) of the display under the cursor. Reads what is under the point first and reports it, so a coordinate guess is checkable. |
| `write_field(text?, mode?, app?)` | approval | `AXValue`/`AXSelectedText` where the app allows it, clipboard-and-keystrokes where it doesn't, then reads the field back either way |
| `activate_app(app)` | approval | Focus a window by title |

`LOCAL_TOOLS` is the single list the server registration, the Clance tools
UI and the CLI arguments all read from.

Acting on an app went from four tools to two. The three former
text-writing tools were one capability split three ways — three approval prompts and three descriptions for "put text in
a field" — and are now `write_field`'s three modes: replace, insert at the
cursor, clear. It tries the accessibility route first, since that needs no
focus, no clipboard and no keystrokes and so can't disturb what the user is
doing; it falls back to the old clipboard-and-⌘A route when that doesn't
take. **Both paths are verified by reading the field back**, because an app
can accept a write and ignore it — Chromium reports success on a text field
it never changes — so the return code is not evidence. The tool reports
which route worked, refuses a field that isn't editable rather than writing
into a button, and refuses a password field outright.

Reading a selection is its own search, not a special case of reading a
field. Text selected by *reading* — a passage in a page, a PDF, a mail
message — sits on a web area or a static-text node, which is neither a field
role nor necessarily focused, so the original implementation (ask for the
focused field, take its `AXSelectedText`) could only ever find a selection
inside a text box. The `selection` op checks the focused element first and
otherwise walks the window for any element carrying a non-empty
`AXSelectedText`, refining into the first branch that matched rather than
scanning the rest of the window: a selection exists in one place, so the
tightest carrier is always a descendant of a broader one and never a
sibling, and continuing would cost an accessibility round trip per node
across thousands of them to learn nothing. A selection inside a password field is reported as present
and withheld, like every other secure read.

### Apps that publish nothing

Chromium builds no accessibility tree for its web content until it believes
an assistive technology is listening. This is not a niche case: it covers
Chrome and every Electron app — Slack, VS Code, Obsidian, Notion — which is
much of a modern desktop. Until then such an app answers a tree walk with
its window frame and traffic lights and nothing else. Measured on a fresh
Chrome showing a 1,200-element page: 37 nodes, no web area, no selection,
and a `read_window_text` that returned the window title as though that were
the page. This, not any preference of the model's, is why reading the screen
as text looked useless and a screenshot always looked better.

`EnableWebAccessibility` (native/ax/ax.mm) wakes the app once per app per
run. It takes three things together, established by isolating them against
fresh Chrome instances: setting `AXManualAccessibility` (Chromium's own
opt-in — Electron honours it, Chrome reports it unsupported), setting
`AXEnhancedUserInterface` (the older screen-reader signal — Chrome reports
it not implemented and honours it anyway), and enumerating the application
element's attributes, which is how a screen reader announces itself. Neither
set's return value means anything, and dropping `AXEnhancedUserInterface`
left Chrome asleep for a full measured run, so all three are load-bearing.
Readiness is then polled for up to 4s, which is what a cold app costs on its
first read; afterwards reads run in about 300ms.

Two things about that are easy to get wrong and were:

- The readiness check has to look deep enough to find what it is checking
  for. Chrome nests its web area seven groups below the window, behind the
  toolbar and tab strip; a six-deep search never matched, so every read —
  including reads of an app that was ready the whole time — burned the full
  timeout. Fixing the cap took a warm read from 4,951ms to 280ms.
- `AXEnhancedUserInterface` is a real side effect, the flag some toolkits
  watch to change their own behaviour. It is set only on an app a session
  was actually asked to read, not broadcast to every app the way a screen
  reader does.

Because the wake can still fail, the reads distinguish "this window has no
text" from "this app told us nothing" and say which. The signal is precise
rather than a node-count threshold — an app that published nothing still
yields one line, its window title, and a tree that *has* been built differs
from an unbuilt one by only a handful of nodes. `windowText` therefore
reports its line count and the window title, and publishing nothing means
one line that is the title.

`click_element` is the counterpart on the pointing side: a control found by
the text on it, pressed through `AXPress`, which needs no focus and can't
land on whatever happens to be under a coordinate. Ambiguity and absence are
both reported with the labels that *are* there, rather than resolved by
guessing. `click_at` stays for canvases, games and anything else with no
usable tree, but now reads what is under the point before clicking and says
what it hit.

### Reading the screen as text

`native/ax` is an ObjC++ N-API addon over `AXUIElement` — the API behind
VoiceOver — and `ax.ts` is its typed face. It exports two functions, `call`
(async) and `callSync`, each taking one JSON request naming an operation and
returning one JSON response, so a new tool costs a branch in the addon and
no N-API boilerplate. Operations: `isTrusted`, `frontmostApp`, `appByName`,
`focusedElement`, `focusedField`, `focusedWindow`, `elementAt`, `describe`,
`attributes`, `tree`, `windowText`, `setValue`, `setSelectedText`,
`performAction`, `release`.

In-process rather than a helper binary: accessibility trust is granted per
binary, so a separate process would need its own entry in System Settings.
An AX read is synchronous IPC to the target app, so `call` runs on a libuv
worker — Electron's main thread never waits on a wedged app — and every
element gets a 0.4 s messaging timeout against macOS's 6 s default. Elements
can't cross into JavaScript, so ones a caller may act on later are retained
in a bounded handle table that evicts oldest-first.

Three things this had to get right:

- **Password fields are never read.** A secure field is recognised by role
  *and* subrole — AppKit uses the role, a web password input under Chromium
  carries it as a subrole — and its value, selection and range are withheld
  from every path: element reads, tree walks, window text, and the generic
  `attributes` read that could otherwise ask for `AXValue` by name. The
  element is still reported, marked `secure`, so a tool can say a password
  field is there without saying what is in it. The guard is in the addon, not
  the tools, so nothing built on it later can reach around it.
- **The app to read is not the frontmost one.** Clance is frontmost whenever
  someone is typing to Claude, so the read tools target the app recorded when
  the widget took focus (`capturedAppInfo`, alongside the window capture that
  already happened at that moment), and take an `app` override. Reading our
  own process is useless; *writing* to it deadlocks — a `setValue` against
  Clance's own field hung for tens of seconds past the messaging timeout — so
  the addon refuses writes to its own pid outright.
- **An inactive app has no keyboard focus**, so `AXFocusedUIElement` comes
  back nil for exactly the app worth reading. `focusedField` falls back to a
  bounded search for the element the app still marks `AXFocused`, preferring
  editable roles so a marked container can't shadow the real field. `via`
  reports which answer it is.

Coverage is uneven by nature: native apps publish rich trees, some apps
publish almost nothing. `read_window_text` says so and points at
`look_at_screen` rather than returning an empty result that reads like "the
window is empty".

The addon is built by `npm run build` (`scripts/build-native.mjs`), which
skips the build when the binary is newer than its sources and the installed
Electron hasn't changed. A failed build is a warning, not a build failure:
without the toolchain the app still runs and `ax.ts` reports the tools
unavailable rather than throwing.

### Approval and targeting

- **Tiers** map to CLI flags at mint time (`sessionMcpArgs`): enabled `auto`
  tools go in `--allowedTools`, so the CLI never prompts for them; `approval`
  tools keep Claude Code's Allow / Deny / Always allow prompt; tools the user
  switched off go in `--disallowedTools`, so they're refused outright.
- **Switched-off tools are also refused per call.** The flags are fixed at
  mint, so the server checks `enabledLocalTools` on every call and returns a
  tool error for a disabled tool; a Settings change reaches existing
  sessions immediately.
- **Why this split.** Reading the screen is non-destructive, and a click can
  only land on something already on screen. `write_field` and `activate_app`
  can reach an app the user never mentioned — auto-allowing them would let
  instructions the model read off the screen act on an unrelated app with no
  human in the loop, and `write_field` destroys what was there.
- **Accepted risk:** a pre-authorized `click_at` can still press a Send or
  Delete button that's already visible in the frontmost app. Per-call
  approval of every click was judged too much friction; multi-step
  computer-use approval beyond per-call prompts isn't designed.
- **`app` hints** match window titles exactly first, then by substring, and
  only a *unique* match at either tier counts; ambiguity matches nothing.
  Titles are attacker-controlled, so a window can't win a hint aimed at
  another app just by being listed first. Matching and `list_open_windows`
  share one normalisation (trim, lowercase), so a title copied from the tool's
  output always matches exactly.
- **Default target.** Without `app`, text and field tools act on the window
  captured when the popup opened. Sessions started elsewhere have no capture,
  so that default can be stale or empty; the model can always pass `app`.

### Server

- **Started at launch, local, authenticated.** `index.ts` starts it when the
  app is ready, since sessions from earlier launches can call in at any time.
  Listens on `127.0.0.1` and rejects non-loopback peers. Every request must
  carry the bearer token (compared in constant time) and a matching
  `Host`/`Origin`, which also blocks DNS rebinding from a browser.
- **Nothing per-launch in a session's config.** The CLI persists a background
  agent's `--mcp-config` and reuses it on every restart, so:
  - **Port:** saved once per install in `local-tools.json`. If another app
    has taken it, the server picks a new random port, saves that, and records
    the old one so Settings can explain it (see "Port changes"); sessions
    minted with the old port lose their tools.
  - **Token:** new every launch, but never put in the config. The config
    carries `headersHelper: "cat '<local-tools-headers-<port>.json>'"`, a
    command the CLI runs to get request headers. The file is written only
    after the server is listening, so a second Clance that fails to bind
    can't overwrite the token the running one checks; it's written to a temp
    file, created `0600`, then renamed. It's named after the port it belongs
    to, and every other token file for the same build channel is deleted, so
    a session still configured for a port Clance has given up has no token
    to send to whatever listens there now.
  - **Server key:** `clance-<suffix>`, with a random suffix saved once per
    install. `--allowedTools` authorizes by name (`mcp__<key>__<tool>`),
    `--mcp-config` is additive, and sessions run in real project
    directories — a project's `.mcp.json` defining a server with a guessable
    name could otherwise collide with the pre-authorized tool names.
- **Gated on Accessibility.** The whole server is left out of `--mcp-config`
  unless Accessibility is granted, so the CLI never sees tools that would
  fail. MCP servers the user configured in Claude Code aren't affected.
- **Health check.** Settings → clance tools shows whether the server is
  running and can send a real `initialize` using the token from the headers
  file (the same path the CLI takes), then ends that session. It reports a
  headers file that doesn't match the running server.
- **Logging.** Every request and tool call is logged with timing. `text`
  arguments are redacted to their length; results are never logged.

### Port changes

Losing the saved port breaks every session minted with it, with nothing on
screen to explain why, so `local-tools.json` records `portChangedFrom` and
Settings → Local tools shows a notice ("Another app was using port X, so
Clance switched to Y…") until the user dismisses it, which clears the field.

### Why this shape

Everything above follows from one constraint: the CLI persists a session's
`--mcp-config` and reuses it on every restart, while the server lives inside
Clance and restarts with it. Alternatives, and why they lost:

| Option | Why not |
|---|---|
| Per-launch port and token (the original) | Only sessions minted in the current launch can connect — the bug this replaced |
| Stateless server (no session ids) | Also survives restarts, but gives up session identity, which `GET` notifications, elicitation and per-session state would need |
| Token saved on disk instead of `headersHelper` | Simpler, but a token that never changes; `headersHelper` keeps rotation |
| Register the server in Claude Code's own user config | Read fresh at session start, but adds Clance's tools to every Claude Code session on the machine, and running sessions still need the work above |
| Stdio helper per session, forwarding over a Unix socket | Doesn't depend on the CLI's reconnect behavior at all, and needs no port. But a helper process per session, a helper that must track the tool list, and files outside the bundle — kept in reserve if the CLI's behavior changes |
| A relay outside the Mac (edge function) | Screen content, selections and typed text would leave the machine, and tools would need the network — against `background.md`'s local-first principle |

### Surviving restarts

Sessions keep their local tools when Clance quits or restarts while they're
running. Verified against Claude Code 2.1.274 with the real server under
repeated restarts and a 3.5-minute outage:

- **Token changed (every restart).** The session's next call gets **401**.
  The CLI re-runs `headersHelper`, reconnects from scratch (`initialize`,
  new session id) and retries once; the call succeeds.
- **Session lost, token unchanged.** A `POST` or `DELETE` with an unknown
  `Mcp-Session-Id` gets **404** with a JSON-RPC "Session not found" body. The
  CLI treats 404 as an expired session, re-initializes and the call
  succeeds. A 400 here leaves the session broken for good — the CLI never
  reconnects.
- **Clance not running.** Calls fail with "Unable to connect"; the first call
  after Clance is back succeeds. The CLI doesn't give up after repeated
  failures.
- **Idle sessions expire.** A restart can create two or three sessions per
  `claude` process (its background reconnect races the tool call's own), so
  sessions idle for an hour are closed, checked every 10 minutes.

A request with no session id that isn't `initialize` still gets 400 — the
CLI sends a `server/discover` probe like that before initializing, and the
400 is harmless.

Three more transport details, all found by testing against the real CLI:

- **Stateful sessions.** Transports are kept per `Mcp-Session-Id`, created on
  `initialize`. A stateless server can't give `GET` or `DELETE` a session to
  belong to, and later per-session features (notifications, elicitation,
  per-session approvals) need one.
- **`GET` returns 405.** The server has nothing to push, and an idle SSE
  stream gets timed out by the client, which then marks the whole server
  broken and stops sending tool calls. The SDK client treats 405 as "no
  stream offered" and carries on with POST only.
- **Keep-alive raised to an hour.** Node's default 5 s `keepAliveTimeout`
  closes the CLI's persistent connection between messages, and the next tool
  call fails instantly with "Unable to connect". `headersTimeout` must exceed
  it.

## Extensibility

Sessions are ordinary Claude Code processes, so skills, hooks, plugins and
MCP servers configured in `~/.claude/` or a project's `.mcp.json` just work.
Clance doesn't list or manage any of them: it's for engineers, who manage
them with the `claude` CLI. The only thing Clance adds to a session is its own
local tools server, merged in with `--mcp-config`.

Settings has a "clance tools" group for it, collapsed by default because the
tool list is long: one summary row (how many tools are on, whether the server
is running) with Show/Hide. Expanded, it shows the server's address and health
check and an on/off switch per tool (`config.enabledLocalTools`, default
`"all"`).

## Main window

### Shell and navigation

`Shell.js` renders a floating launcher in the top-right corner — Sessions,
Changes, Dictation, Settings, and a plain terminal — rather than a
sidebar, so it takes no layout space. Sections are singleton tabs: opening
one that's already open focuses it, in whichever pane it's in. The terminal
button opens `$SHELL -il` in the default directory.

- The launcher's status dot shows whether Claude is signed in, re-checked
  whenever the window gains focus. While it isn't, a banner under the
  launcher pane's tab bar offers Sign in.
- Session tabs show a live dot, and a status line under the terminal gives the
  agent's folder, when it started, and a Pop out button that moves it to the
  widget. There's no ⌥↩ inside a terminal: the CLI uses it for a newline.
- Other windows open a section through `openMainWindowSection`, which waits for
  the renderer before sending `open-section` (the HUD's "open settings", the
  popup's error state).
- A session tab opens before its conversation has a name — "New Chat" — and
  takes the transcript's title once the first message lands. Nothing pushes
  that: the CLI writes the file, so an unnamed tab asks
  (`sessions:title-for-args`) every 3 s until it has a name, and the poll
  stops once every tab has one. The lookup resolves the tab's launch args to
  a session id in the main process, since a tab knows only its agent id.
  Which tabs are still unnamed is a `named` flag the rename sets, not a
  check against the placeholder's wording — matching label text is how a
  second, differently-worded placeholder once slipped through unrenamed.

Tab keys live in the app menu's Window items (`appMenu.ts`) rather than in a
renderer key listener: a menu accelerator is handled before the window sees
the key, so a focused terminal can't swallow it, and the bindings stay where
macOS users look for them. Each sends a `window-command` to the main window,
which `Shell.js` applies to the pane that has focus.

- **⌘W** closes the active tab, ending its pty the way the tab's own ✕ does
  (the background agent behind a session goes on running either way). A
  pane's last tab takes the pane with it. The layout store keeps the window
  from ever being empty, so ⌘W on the last tab of the only pane closes the
  window instead, as it does in every other macOS app — which is why plain
  ⌘W is no longer the `close` role and **⇧⌘W** is Close Window now.
- **⌃⇥ / ⇧⌃⇥** cycle the focused pane's tabs, wrapping at either end. A pane
  is its own tab strip, so cycling stays inside one rather than wandering
  across a split.
- ⌘W on the widget is its ✕, exactly: `closeWidget` in `popupWindow.ts`, the
  same function its close button goes through, so the two can't drift. The
  widget's own window is never destroyed — its live session and xterm state
  are what make the next hotkey press instant. Tab commands elsewhere no-op.

### Tab labels and names

A pane can be a quarter of the window, which is not enough for a tab to say
"Changes" — it says "Cha". `PaneLeaf` drops the labels instead, leaving the
icons, and the full name moves to a tooltip after two seconds.

The decision is made from the tab row's own width divided by the number of
tabs, never from how wide the rendered tabs turned out to be. A
`ResizeObserver` that measured its own content would feed the result back
into what it was measuring, which is the same trap the Changes history strip
had to avoid. The row's width already excludes the launcher cluster, so the
number being divided is the room tabs actually have.

The label is hidden in CSS rather than left unrendered, so the measurement
doesn't change when the answer does. The close ✕ keeps its reserved space
(`visibility`, not `display`), so a tab doesn't change width under the
pointer.

The tooltip is `position: fixed`: the tab row scrolls and clips its own
overflow, so anything inside it would be cut off. Nothing between a pane and
the window has a transform, which would otherwise make `fixed` position
against that ancestor instead of the viewport. It is clamped off the right
edge of the window, and its timer is cleared on leave and on pointer-down, so
skimming across a row leaves no trail of tooltips behind it and starting a
drag doesn't strand one.

A file tab's name is its whole path, home-shortened. Its label is a basename,
and a window holding two files called `index.ts` otherwise shows the same tab
twice.

### Panes

`state/layoutStore.js` is a small hand-rolled store (state, subscribe,
dispatch over a pure reducer) holding a tree of leaves (`{ tabs, activeTabId }`)
and splits (`{ direction, sizes, children }`, always two children).

- **Shape rule.** The root may split once, and each half may split once more,
  perpendicular to the first — so at most a 2×2 grid (`MAX_PANES = 4`).
  Reducers build the candidate tree and `isValidShape` validates the result;
  `canSplitAt` runs the same check so the UI only offers drop zones that will
  work.
- **Moving a pane's only tab** removes that pane and collapses its parent, so
  it never adds a pane. When the drop target was the root that just
  collapsed, the drop re-resolves to the new root rather than being rejected.
- **Tab drag uses Pointer Events, not HTML5 drag and drop.** Native DnD
  locked up after the first cross-pane move, because dropping unmounts the
  dragged tab while Chromium is still inside the OS drag session. Past a 4 px
  threshold a ghost element follows the pointer. Hit-testing is geometric,
  against elements that always exist, because the drop-zone overlays may not
  have painted yet on a fast drag. Only drag start and end touch Preact state;
  the ghost, preview and reorder highlight are updated on the DOM directly.
- **Persistence.** The tree is written to `window-layout.json`, debounced
  400 ms, and restored on launch. Restored agent tabs re-attach with their
  saved args.

### Changes pane

`sections/ChangesSection.js` over `src/main/git.ts`. A monitor, not a reader:
it says what is moving in a repository right now, and hands the reading to a
file tab. It opens in a pane of its own on the right — `openSection` opens the
tab, splits it away, and resizes that new split to `CHANGES_PANE_PCT` (25)
rather than the even half `wrapAsSplit` gives by default. It does this only
when the pane it landed in has another tab to split from and the window isn't
already at `MAX_PANES`; otherwise it stays a tab where it is rather than
refusing. A sidecar that covered the work it sits beside would be pointless.
The resize applies only to the split that just created the pane: reopening
Changes while it's already open focuses it instead of splitting again, so a
width the user has since dragged is never overwritten.

Because reading moved out, the pane fits a narrow column honestly: a bar with
the repository, branch and a live dot when a session is working there; one
mono line of counts; the file list; and a commit box that appears only when
there is something to commit. An earlier version put a full-width diff and a
permanent commit slab in the same surface, and the result was a file picker
pretending to be a review tool.

**Running git.** `git.ts` shells out to the `git` binary through `execFile`
rather than linking a library — git is already on any machine with a repo to
look at, and a native addon would be another thing to rebuild for Electron,
the same reasoning that chose `node:sqlite` for dictation. Commands run with
the resolved login-shell `PATH` (so a credential helper is found),
`GIT_TERMINAL_PROMPT=0` (a push that wants a password must fail rather than
block a main-process subprocess on a tty nobody can type into) and no pager
or editor. Reads use `--no-optional-locks`, so looking at a repo never takes
`index.lock` away from an agent running git in it at the same time. A
non-zero exit is returned rather than thrown, because `diff --no-index`
exits 1 by contract every time it's called.

**Trusting nothing from the renderer.** Every entry point re-derives the repo
root with `rev-parse --show-toplevel` from the directory it was handed, and
file paths are kept only if the current `status` — or `ls-files`, for a file
nobody has touched — is already reporting them. So a command can't be pointed
at a path outside the repo, and `execFile`'s argv means a name with a space or
a quote in it can't become an argument. Same posture as `sessionActions.ts`.

**A leading dash still can, though**, which is why every path handed to git is
preceded by a `--` separator — including in the blob-versus-worktree form a
rename uses (`diff HEAD:<old> -- <new>`), which is the one place that lacked
it. argv keeps a path whole, but git reads an element beginning with `-` as an
option wherever one is allowed, and a file really can be named
`--output=pwned.txt`: git reports that name in `status`, so being in the
listing is no guarantee at all — the listing is where such a name comes from.
Without the separator, opening that file's diff ran
`git diff HEAD:<old> --output=pwned.txt` and git wrote the diff to that path.
Branch names are safe by git's own rule (it refuses to create one starting
with `-`) and a commit message is safe because `-m` consumes its operand
whatever it looks like, but neither is a reason to drop a separator.

**Status.** `status --porcelain=v2 --branch -z`: the only format with both a
stable machine-readable shape and the branch/ahead/behind header, and
NUL-separated because a filename can contain anything, newlines included —
the line-based format quotes those instead, and unquoting is a second parser
to get wrong. A rename's source arrives as its own NUL field and is consumed
there rather than found by splitting the record. Line counts come from
`diff --numstat` for both the staged and unstaged halves, summed. An untracked
file is in neither diff, so its lines are counted by reading it (with a size
cap, and a NUL byte in the first 8 kB meaning binary, which is git's own
guess).

**Diffs** are always HEAD → working tree. An untracked file has nothing in
HEAD to compare with, so it goes through `diff --no-index` against
`/dev/null`. A renamed file is diffed as `HEAD:<old> <new>` — rename detection
switches off once a pathspec limits the diff, so asking for both names gives a
delete and an add instead of one moved file. The unified-diff parser tracks
file headers rather than assuming they only appear at the top: a patch can
cover more than one file, and a header read as content shows up as garbled
context lines.

**Watching.** `watchRepo` is what makes the pane live rather than something to
refresh by hand. One recursive `fs.watch` per repo — on macOS that's FSEvents,
so a whole worktree costs one watcher — debounced 300 ms, because a commit or
an `npm install` emits thousands of events. Everything under `.git` is ignored
except the few paths that mean the repo actually moved (`HEAD`, `index`,
`refs/`, the in-progress heads), as are `node_modules` and `.DS_Store`. If a
watch can't be established (a network mount, the descriptor limit) it falls
back to a 4 s poll rather than leaving the pane silently frozen on a stale
listing. Watchers are shared per root and reference-counted; the main process
keys subscriptions by the renderer's id and drops them when it goes, since a
reload sends no unwatch.

**What the pane does.**

- **New since you looked.** Each file carries a signature (its porcelain codes
  and line counts). The first listing after opening a repo is the baseline, so
  opening the pane never lights every row up; after that, a file whose
  signature moved gets a signal-orange dot, and the header offers to clear
  them all. Opening or peeking at a file clears its own — looking at it is
  what "seen" means.
- **Claude is working here.** The running agents are polled every 5 s and the
  bar carries a live dot when one is working in this repo, because the listing
  underneath is then a moving target.
- **Staging is file-level**, and its checkbox is a hairline box that fills in
  only when it's on. A column of solid ink for a side errand was the loudest
  thing in the pane. A file that is staged *and* changed again since stages
  the rest rather than unstaging what's there — the commit box's count would
  otherwise be a quiet lie.
- **The inline peek** draws at most 120 lines. A peek is a glance; a 900-line
  diff in a narrow pane is neither, and the file tab is one click away.
- **Discard** is the only destructive action and confirms on the row itself,
  where the thing being destroyed stays on screen while it's asked about. An
  untracked file is deleted outright, which git can't undo.
- **Failures are reported in git's own words.** `commit` passes `-m` and
  nothing else — no `-a`, so what's committed is exactly what the list showed
  as staged, and no `--amend`. `pull` is `--ff-only`: a pull needing a merge
  is a decision, not a button.

**History.** Recent commits sit under the commit box and take whatever height
the file list doesn't want, which is what stops the pane being mostly
empty — a clean tree with nothing staged is its most common state, and until
this it showed a bar and the words "Working tree clean." The strip is status,
not a history browser: it answers "did that land" and "what just happened
here", the pane's own question asked about commits instead of the working
tree. It re-reads on the same watcher tick as the status, since a tick may
have been a commit. A repo with no commits exits non-zero from `git log`,
which is an empty history rather than a failure, and says so.

How many it shows is measured, not fixed: `HISTORY_FETCH` (60) commits are
read and the strip renders `floor(height / COMMIT_ROW_HEIGHT)` of them, so it
fills the gap between the commit box and the remote button exactly and never
scrolls. A `ResizeObserver` re-measures when the pane is resized. Both the
strip and its list use `flex-basis: 0` rather than `auto`: with a
content-sized basis the number of rows fed back into the layout that decides
how many rows fit, which is a `ResizeObserver` loop. With no room for even one
row the heading goes too — a "recent" label over nothing is worse than no
label — but the list element stays mounted, since it is what gets measured and
unmounting it would leave nothing to re-measure when the pane grows again.

**The remote button** opens the repo's origin in a browser, and is absent when
there's nothing to open. Deriving that URL is the one place here that turns
repository content into something handed to another program: `.git/config`
travels with a clone, so a remote URL is untrusted input. Only `https`, `http`,
`ssh` and `git` remotes convert — a local path, or a helper scheme like
`ext::sh -c '…'`, gets no button. The URL is rebuilt from the parsed host and
path rather than mutated, which drops any embedded credentials: an https
remote can carry a token, and opening that in a browser would write the token
into history. scp-like syntax (`git@host:path`) has no scheme to check, so its
host must look like a host — without that test the shape swallows any
`scheme:rest` string, and `javascript:alert(1)` parsed as host "javascript".
The renderer asks to open *this repo's* remote and never passes a URL; the
main process re-derives it from the repo and opens it with `shell.openExternal`.

**Branches** are shown, never changed. `listBranches` is one `for-each-ref`
over `refs/heads`, sorted by commit date, carrying each branch's upstream,
ahead/behind (parsed out of `%(upstream:track)`'s `[ahead 2, behind 1]`),
tip subject and whether it's the checked-out one. Newline-separated records
are safe here in a way they never are for paths: git's own ref-name rules
forbid control characters, so a branch name can't contain one.

The picker is read-only because a checkout with a dirty tree either refuses or
carries the changes across, and that is a decision rather than a button. What
a row can usefully do instead is hand over the name to paste into a checkout,
so clicking one copies it. The header's branch and repo are two controls over
one menu slot (`menu` is `"repo"`, `"branch"` or null), so opening one closes
the other without a second piece of state to keep in step.

A **detached HEAD** is labelled `detached <sha>` in the warning colour rather
than rendered as a bare short sha, which read exactly like a branch named that
and quietly hid the fact that a commit there would be on no branch. Nothing is
marked current in the picker while detached, which is the truth.

**The repo switcher** offers the default session directory, the recent ones
and wherever the running agents are working, deduped through `findRepoRoot` —
no configuration of its own, because Clance already knows where the user
works — plus a folder picker. The chosen repo is remembered in
`config.json`'s `lastGitRepo`. Its menu is pinned to both edges of the repo
button rather than sized by its contents — `.menu`'s own `min-width` plus the
full paths inside pushed it past the pane's right edge, where it was clipped —
and it closes on a click outside or Escape, since a menu that only closes by
pressing the thing that opened it is a trap.

### Files explorer

`sections/FilesSection.js` over `src/main/files.ts`. A sidecar like Changes,
and read-only like it, but pointed at a *folder* rather than a repository:
⌘P is a recall tool that needs a filename already, and looking around a
project is a different act from remembering a file in it.

**Why it isn't part of the Changes pane.** It was going to be, swapped with
the recent-commits strip. That strip is sized to whatever height the file
list doesn't want and never scrolls, which works because commits there are
status rather than content — showing three instead of eight loses nothing. A
tree has real content height and must scroll, and at "whatever's left over"
it gets two rows on a dirty repo. A pane of its own costs a launcher entry
and gains a layout that doesn't fight itself.

**Sidecars.** `SIDECARS` in `Shell.js` is the set of sections that open
beside the work instead of over it, and `openSection` treats them alike: a
quarter of the window (`SIDECAR_PANE_PCT`), only when there's a pane to split
from and the window isn't at `MAX_PANES`, and only on the split that created
it, so a width the user has dragged survives. The second sidecar to open
joins the first's pane as a tab rather than taking another quarter — both are
read alongside the work, and two quarter-width columns leave half a window to
work in. `paneForFileTabs` asks the same question, so a file opened from
either one lands beside both.

**Containment.** Inside a repository `ls-files` is what keeps a file tab in
the tree: git will not name a path outside it, so escaping is structurally
impossible. A chosen folder has no such authority, so `files.ts` checks
every path itself — and checks it *after* `realpathSync`, not before. A
symbolic link sitting inside the folder and pointing at `~/.ssh/id_rsa`
passes every test that can be made on a path as text. Links are listed and
never walked into, which also stops a link pointing at its own ancestor from
becoming an infinite tree.

**Listing.** One directory per call, never a walk: a folder nobody has
expanded costs nothing. Inside a repository the entries go through
`checkIgnore`, which is `git check-ignore -z --stdin` — `-z` is what keeps a
newline inside a filename from splitting one path into two, and git only
accepts it with `--stdin`, so this is the one git call here that needs a
child's stdin and the one that spawns rather than `execFile`s. It returns
null rather than an empty set when git fails, because "git could not tell"
and "nothing is ignored" are indistinguishable to a caller that can't tell
them apart, and the second one quietly puts `node_modules` on screen. The
tree then lists everything and says why.

**Opening a file.** `resolveFile` returns the `(root, path)` a file tab opens
with, and a file inside a repository resolves against the *repository* rather
than the chosen folder. So a file reached from Files and the same file
reached from Changes are one tab rather than two, and it arrives with its
changes marked in place whichever side it came from.

**Truncation.** A row shows a basename and truncates at the end. Truncating
at the start reads better for a long name and is one line of CSS
(`direction: rtl`), but it hands the line to the bidi algorithm, and a
leading dot is a neutral character: `.gitignore` renders as `gitignore.`.
Dotfiles are the one thing a file tree must not misspell.

### File tabs

`sections/FileSection.js`. Clance is a read-only viewer over the code its
sessions write: the person's job is reading, and reading a change means
reading the code around it, which a diff alone can't give. So a file opens as
an ordinary tab — draggable into a split, one per file, keyed
`file:<root>:<path>` so opening the same file twice focuses the tab that is
already there.

**Readers.** A tab draws whatever `openFileView` hands it, not a file it
assumes is text. There are three: text with syntax highlighting and diff
marks, images, and markdown. The envelope is a union, so a table over a CSV
or a JSON tree is a new arm of it rather than a rework of file tabs. The
shape had to change before the second reader could exist at all: a file view
was a list of `DiffLine`s with a binary flag and a 20,000-line ceiling, none
of which an image has an answer for.

Markdown is the cheap case and shows why the split is where it is. It isn't
a separate payload — it is the text reader with `renders: "markdown"` set, so
Raw keeps the diff marks and Rendered is a second view over the same read,
the way Diff / Clean already was. `shared/markdown.js`, written for the old
chat UI and dead ever since, does the rendering: it escapes every character
before it introduces a tag, which is exactly the property a reader needs when
the document may have been cloned a minute ago. Reviving it needed three
fixes, all from its old caller being chat rather than documents — a
hard-wrapped paragraph now flows instead of breaking at every newline, an
indented line under a bullet continues that bullet instead of becoming a
stray paragraph, and links exist (http, https and mailto only; anything else
stays the text it was, and the main process re-parses the URL before opening
it).

Nothing is fetched or read to render a document: a picture referenced inside
a markdown file renders as its alt text. Resolving those references would
mean one file's contents deciding what other files get read, and a remote one
would mean opening a document quietly calls out to whoever wrote it. An image
is looked at by opening it, which is its own tab.

The image reader reads bytes and hands over a `data:` URL, drawn by an
`<img>`. That is the safe way round: an SVG loaded as an image cannot run the
script SVG is allowed to carry, where the same bytes inlined as markup can.
SVG is also the one image format with a source worth reading, so it is the
one that offers Raw — the toggle appears when a reader has two views, not on
a schedule.

Three things follow. *Diff is a capability, not a universal*: the change
count, the jump controls and the Diff / Clean choice hang off `view.changed`,
which is false for every file outside a repository, so the toggle is absent
there for the same reason it would be absent on a photograph rather than as a
special case. *Limits belong to a reader*: 16 MB and 20,000 lines are right
for text and wrong for a 20 MB photograph. And *"binary" stops being a
verdict* — it is now just a file no reader claimed, and the fallback says its
name and size instead of the words "Binary file".

The reader is picked in the main process, next to the containment check and
the size limit, so a path is checked in one place rather than once per
reader. A reader never executes what it reads: content is drawn, never turned
into markup. SVG and HTML are the two formats that look like the easiest win
and both carry script, and Files browses any folder on the machine.

**One payload, two views.** The Diff / Clean segmented control picks between
them. `getFileView` runs `diff -U<20000>`, a context
size larger than any real file, so git emits the whole file as a single hunk
instead of islands around each change. The "Clean" button is then a rendering
choice over that one read: hiding the deleted lines and the marks leaves
exactly the working-tree file. Two separate reads could disagree about what
the file says; this can't. A file with no changes is read from disk as all
context, an untracked one as all addition, a deleted one from `show HEAD:`.

**A branch switch under an open tab.** The watcher covers `.git/HEAD` and
`refs/`, so checking out elsewhere reloads every open file tab. When the file
isn't on the new branch, `getFileView` asks `rev-list --all -- <path>` whether
git has ever known it and says "Not on this branch" rather than "isn't in this
repository any more" — the file is fine, it just isn't here. That question is
only asked when the path is missing from the current tree, so it costs nothing
normally.

**Where files open.** `paneForFileTabs` picks a pane that isn't the one
holding Changes, preferring one that already has a file in it, so reading a
second file doesn't split the window further and the sidecar stays visible.

**Windowed.** Rows are a fixed 20 px and only the visible slice plus 40 rows
of overscan is in the DOM, so a 10 000-line file costs what a short one does.
The line-number gutter is `position: sticky`, so scrolling a long line
sideways doesn't lose the margin.

**Width follows the pane.** Rows fill the pane and track it as it's resized,
and grow past it only when a line is genuinely longer, which scrolls the
viewer horizontally rather than wrapping. Two things make that work, and
leaving out either breaks it in opposite directions: the rows' container is
`width: auto; min-width: max-content` (shrink-wrapping to the longest line
instead left a changed line's tint stopping halfway across the pane), and
`.file-section` and `.changes-pane`, as flex items of `.content-flush`, carry
`min-width: 0` (without it a flex item's automatic minimum is its content's
max-content width, and one long line pushed the whole viewer wider than the
pane instead of scrolling inside it).

The pane packs to the top: the file list takes the height its rows need, so
the commit box sits under it rather than at the floor with a hole above, and
shrinks to scroll once the rows outgrow the pane so the commit box stays on
screen.

**⌘P** opens any file in the current repository by name, over `ls-files`
(tracked, plus untracked files git isn't ignoring). Matching is on any
subsequence of the path, ranked by how tight the match is and whether it
landed in the filename rather than a directory. Without it the only readable
files would be the ones an agent happened to touch, which is a diff viewer
wearing a hat.

### Syntax highlighting

`src/shared/syntax.js`, hand-rolled, for the same reason the icon set and the
layout store are: the job is narrow — colour code that is only ever read,
never edited — and every alternative is a vendored parser per language. It
recognises comments, strings, numbers, keywords and call sites, and leaves
everything else plain. Being wrong should mean an uncoloured word, never a
missing one.

It escapes every chunk before introducing a tag of its own, the order
`markdown.js` uses, and emits nothing but its own fixed set of
`<span class="tok-*">` — which is what makes the viewer's one
`dangerouslySetInnerHTML` safe. A block-comment flag is threaded down the file
so a multi-line comment stays one colour; it's computed for the whole file
rather than per visible row, because a window starting mid-comment would
otherwise highlight it as code, and a deleted line doesn't carry its state
forward, since it isn't part of the file the next line belongs to.

The token colours are muted enough to sit on paper and on a diff tint without
shouting, and each clears 4.5:1 on paper.


### Visual design

The design language is **Quiet instrument**: ink on off-white paper, flat,
keyboard-first, with a single live-signal colour. The reference mockups are
page 5 of the design canvas
(https://claude.ai/artifact/15LuB45Mh6gZq4Xz3q8WaS).

Everything lives as custom properties in `src/shared/theme.css`, and shared
controls (buttons, fields, menus, toggles, status, toasts) in
`src/shared/components.css`, which all three windows load. UI code uses the
properties, never literal colours, font sizes or weights; `npm run
check:design` fails on any that slip in. xterm.js can't read CSS variables,
so the terminal themes in `popup.js` and `TerminalSection.js` repeat the palette as literals
(the check skips them) and must be kept in step.

**Colour**

| Role | Property | Value |
|---|---|---|
| Paper (window background) | `--app-bg` | `#FAFAF7` |
| Wash (tab bar, selected row, hover) | `--surface-bg` | `#ECEBE5` |
| Surface (cards, menus, inputs) | `--surface-card` | `#FFFFFF` |
| Line | `--surface-border` | `#E9E8E3` |
| Ink: text and the action colour | `--text-primary`, `--accent` | `#171614` |
| Secondary text | `--text-secondary` | `#5F5D57` |
| Tertiary text (hints, timestamps, labels) | `--text-tertiary` | `#75726B` |
| Signal: live things only | `--signal` | `#E2632F` |
| Recording dot | `--recording` | `#C8412F` |
| OK / attention / danger | `--success`, `--warning`, `--danger` | `#2F7D4F`, `#9A5C00`, `#B3362B` |
| Diff row tints | `--diff-add-bg`, `--diff-del-bg`, `--diff-hunk-bg` | `#E8F2EA`, `#FBECEB`, `#EEF0F3` |
| Syntax tokens | `--tok-keyword`, `--tok-string`, `--tok-number`, `--tok-call`, `--tok-comment` | `#8A3B6B`, `#7A5320`, `#2F5FA8`, `#3A5A7A`, `#75726B` |

Rules:
- Every text colour clears 4.5:1 on paper.
- Ink is the action colour: primary buttons and switches are ink.
- Signal orange marks only something live (a running session, focus, the text
  cursor, a drop target) and is never used for text.
- Amber means the user must act; red means something failed or will be
  destroyed.
- An optional thing that's off is neutral grey, never a warning.

**Type.** Geist for UI and Geist Mono for anything technical (paths,
timestamps, shortcuts, states, tool names), both vendored variable `.woff2`
files under the SIL OFL. There are seven sizes (`--text-xs` 11 … `--text-2xl`
28): 13 px is the UI base, 24 px page titles and 28 px setup headings, at
−0.03em tracking. Three weights, as properties: `--weight-regular` 450,
`--weight-medium` 550 (titles, buttons) and
`--weight-semibold` 600 (headings). Every window renders text with grayscale
antialiasing (`-webkit-font-smoothing: antialiased`), which is lighter than
macOS's default smoothing; the in-between weights (450, not 400) make up for
it. Sentence case everywhere; labels are lowercase mono, never all caps.

**Space and shape.** Spacing comes from `--space-1`…`--space-7`
(4, 8, 12, 16, 24, 32, 48). Radii: 4 small controls, 6 buttons, 10 cards and
inputs, 12 windows. Four shadows: `--shadow-menu`, `--shadow-window`,
`--shadow-overlay`, and `--shadow-field` for inputs.

**Components.**
- Buttons come in four kinds: primary (ink), secondary (white with a line),
  quiet (text only) and destructive (red text; red fill only inside a
  confirm). A primary action that Enter triggers shows a ↩ key hint.
- Status is shown as a dot plus a mono word (`granted`, `needs you`,
  `off · optional`) rather than icons.
- Keyboard shortcuts render as keycaps.
- Value choices — Dictation's date ranges, a file tab's Diff / Clean — are a
  segmented pill. A view toggle is a choice between two states, not an
  action, so it isn't a button.
- Menus are white with `--shadow-menu`: a lowercase mono section label, an
  optional right-aligned mono detail and shortcut, and a wash highlight.

**Layout.** The main window keeps tabs on the left of a 40 px bar, as
rounded-top cards whose active one joins the page below, with the
launcher icons and Claude status dot pinned to its top-right corner. The tab
row has no scrollbar, which would take its height out of the tabs; when it
overflows it scrolls by trackpad or wheel and keeps the active tab in view. Content
columns are 880 px, centred. The dictation overlay is a 36 px white pill: a
recording dot, an ink level meter and a mono timer while listening; a coloured
dot and a short label otherwise.

The menu-bar menu (`tray.ts`) is native, so it looks like macOS: Open Clance
and Dictate with their current shortcuts shown, Open Dashboard, a disabled
"Claude: connected / signed out / not installed" line kept current by the
setup status check, and Quit.

Icons are inline SVG in `src/shared/icons.js`; nothing loads from the network.

The logo master is `packaging/clance-logo.svg`, drawn as shapes so it needs no
font. `packaging/icon.png` (1024 px, Apple icon grid) is the app icon.
`src/shared/brand/trayTemplate*.png` are heavier-stroked template images for
the menu bar, which macOS recolours for light and dark. `Logo()` in
`icons.js` renders the mark in `currentColor` inside the UI.

## Dictation

### Flow

1. The dictation shortcut calls `toggleDictation()` (`dictation.ts`), which
   checks for the engine, an installed model and microphone access; if one is
   missing the HUD says what to do.
2. The HUD appears. The frontmost window title is read in parallel — it's
   only metadata for the history row, so it isn't on the critical path.
3. The HUD renderer records: `getUserMedia` → an `AudioWorklet` that
   downsamples to 16 kHz mono and computes RMS for the level meter and
   silence detection. Auto-stop arms only after speech is heard. The input is
   macOS's default unless Settings names a microphone (`dictation.inputDevice`,
   `{ id, label }`). That one is used when connected, matched by id and then by
   name, since an id can change when a Bluetooth device re-pairs; if it's
   missing or won't open, recording falls back to the default. Following the
   default alone broke dictation with Bluetooth headsets: macOS moves the input
   to the headset's mic, which often records silence from Chromium while it
   switches into call mode.
4. On stop, PCM goes to main, is written as a WAV, and `whisper-cli` runs.
5. The text is pasted at the cursor (`pasteAtCursor`), or copied when
   `insertMode` is `clipboard` or Accessibility is off. Then the transcript is
   saved to history.

State is `idle → recording → transcribing`. Every exit path goes through
`settleToIdle()`, which releases the temporary Escape hotkey, the max-duration
timer and the menu-bar indicator. Pressing the shortcut or Escape while
transcribing kills `whisper-cli` and skips both the paste and the history
write.

`pasteAtCursor` doesn't refocus anything and doesn't touch the popup's
captured window: the HUD never takes focus, so the user's app is still
frontmost, and refocusing would move the text somewhere else.

### HUD window

`dictationWindow.ts`:

- `focusable: false` and only ever `showInactive()` — the most important
  constraint in the feature. If the HUD took focus, the transcript would paste
  into it.
- Bottom-centre of the work area on the display under the cursor, just above
  the Dock.
- Visible on all workspaces with `skipTransformProcessType: true` — without
  it Electron briefly hides the Dock icon — and `backgroundThrottling: false`,
  since it sits hidden between uses and must paint the meter immediately.
- The meter is driven by worklet messages, not `requestAnimationFrame`, which
  throttling would pause. Worklet output goes through a zero-gain node so the
  graph runs without macOS marking Clance as playing audio.
- The window is resized to its content (`dictation:resize`, 120–560 px,
  re-centred): a fixed width while recording, otherwise the label plus any
  action. Labels are short — "Typed into <window>", "Copied · paste with ⌘V",
  "Didn't catch that", "Install a speech model first" — and a missing model,
  engine or microphone permission adds an "open settings" link
  (`dictation:hud-action`), which opens the right Settings or System Settings
  page and hides the HUD.
- `warmDictation()` at startup pre-creates the HUD, loads the nut-js addon,
  and resolves the binary and machine specs, taking the first dictation from
  ~1 s to ~100 ms. The microphone is only opened on start.

### Engine

Homebrew's `whisper.cpp` is a cask dependency, not bundled.
`resolveWhisperBinary` checks Homebrew's prefixes, then the login-shell
`PATH`. Bundling needed a static build before every release and a second
signed binary.

Alternatives rejected: WhisperKit (Swift/CoreML, its own model format and
signing; whisper.cpp already clears the latency bar), Apple's Speech framework
(no model choice, needs a Swift helper), and cloud speech-to-text (audio would
leave the machine).

Invocation: `-m <model> -f <wav> -l en -t <perf cores, 2–8> -bo 1 -bs 1 -nt -np -otxt -of <base> --prompt <vocabulary>`.

- **Greedy decoding** (`-bo 1 -bs 1`) was faster than the default beam search
  with identical output on every test clip.
- **`--prompt` vocabulary seeding** recovers identifiers and jargon (camelCase
  names, `src` rather than "source") for about 90 ms. It primes vocabulary;
  it is not an instruction, and the settings copy says so. The default list is
  `DEFAULT_VOCABULARY` in `config.ts`, and it's editable in Settings.
- **Spawn per utterance.** A warm process would save ~350 ms of ~740 ms but
  hold ~720 MB resident.

Measured on an M2 (8 GPU cores, 8 GB), ~11 s clips, greedy decoding:

| Model | Latency | Peak RSS | Verdict |
|---|---|---|---|
| `tiny.en` | 288 ms | 250 MB | Mangles technical vocabulary |
| `base.en` | 380 ms | 360 MB | Mangles technical vocabulary |
| `small.en` | 853 ms (737 ms with the shipping config) | 760 MB | Recommended — first tier that gets code vocabulary right |
| `large-v3-turbo-q5_0` | 2,386 ms | 742 MB | Lighter than `small.en` but 2.6× slower; no more accurate on code terms |

The clips were synthesized with `say`, so latency, memory and tier ordering
are reliable but absolute accuracy isn't (see open questions).

### Models

`whisperModels.ts` holds the catalog — `tiny.en`, `base.en`, `small.en`,
`large-v3-turbo-q5_0` — with byte sizes and pinned SHA-256 hashes, downloaded
from Hugging Face into `~/.clance/models/`.

**Recommendation** keys off GPU core count (from `system_profiler`), because
GPU throughput, not RAM, decides whether a tier is usable:

| Machine | Recommended |
|---|---|
| Apple Silicon, ≤ 10 GPU cores | `small.en` |
| Apple Silicon, > 10 GPU cores | `large-v3-turbo-q5_0` (unmeasured, see open questions) |
| Under 4 GB RAM, or under 2× the model's size free on disk | One tier down |

**Install** checks free space (remaining bytes plus 200 MB), downloads to a
`.part` file with Range resume, verifies SHA-256, renames atomically, then
runs one throwaway inference. That last step matters: the first run on a
machine compiles Metal shaders for ~18 s, and without the warm-up the first
real dictation looks hung. Progress is broadcast to every window, and a pane
opened mid-download re-attaches via `getActiveInstalls()`. Cancelling returns
`"cancelled"`, so a cancelled model is never made active.

`reconcileActiveModel()` runs at startup and adopts an installed model when
the config names none (hand-copied weights, a reset config) — the
recommended one if present, otherwise the largest installed.

The dictation shortcut is registered only while at least one model is
installed, so users who never set up dictation keep ⌥D.

### History

`dictationStore.ts` is the only code that touches `dictation.db`:

```sql
CREATE TABLE transcripts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,          -- epoch ms
  duration_ms   INTEGER NOT NULL,          -- audio length
  transcribe_ms INTEGER NOT NULL,          -- engine wall time
  model         TEXT    NOT NULL,
  target_app    TEXT,                      -- frontmost window title
  inserted      INTEGER NOT NULL DEFAULT 0 -- whether the paste happened
);
CREATE INDEX idx_transcripts_created_at ON transcripts(created_at DESC);
CREATE VIRTUAL TABLE transcripts_fts USING fts5(text, content='transcripts', content_rowid='id');
-- plus insert/delete/update triggers keeping FTS in sync
```

- `node:sqlite` is still flagged experimental upstream, which is why all
  access is behind one module.
- Migrations are forward-only, versioned with `PRAGMA user_version`. Version
  2 strips emoji from stored window titles: browsers append a speaker glyph to
  the titles of tabs playing audio. `windowTitle.ts` removes pictographs and
  emoji modifiers at capture, keeping accented, CJK and Cyrillic text.
- Queries and deletes share one `buildQuery` (search, date range, or a single
  `id`), so "delete all" deletes exactly what the filter matches, not just the
  loaded page, and deleting one row goes through the same path. The confirm step reuses the filter the visible list was built from,
  so editing the search box mid-confirm can't change what gets deleted.
- Date presets resolve at query time, and dates are formatted from local
  components (`toISOString()` would shift the day).
- The Dictation tab is history only. Setup — microphone, models, prompt,
  preferences — is the same `DictationStep` component the wizard uses,
  rendered in Settings.

## Assistant

⌥A opens a listening session: Clance transcribes on the Mac, decides what
each command meant, and performs it. What it does is in `assistant.md`; this
is how.

### Shape

```
whisper ──partials──> transcript ──stable prefix──> decide ──> act
  (local)               buffer                      (Jev)     (AX + Clance)
                           ^                                       |
                           └────────── commit point ───────────────┘
```

Five parts, each replaceable on its own:

| Part | Module | Owns |
|---|---|---|
| Session | `assistant/session.ts` | The state machine; the only thing that knows the mode |
| Transcript | `assistant/transcript.ts` | Partial buffer, stability, commit points |
| Deciding | `assistant/decide/` | A stable phrase plus context to a resolution |
| Intents | `assistant/intents/` | What kinds of thing exist, and how each resolves its target |
| Acting | `assistant/act/` | Performing, risk, undo |

Below them, `capabilities/` — extracted from `localToolsServer.ts` — is the
shared implementation the MCP server and the assistant both call.

### The transcript buffer

Streaming transcription emits a partial every few hundred milliseconds and
revises what it already said. Deciding on every partial would be jittery and
wasteful, so the buffer exposes a **stable prefix**: the longest leading run
of the transcript that hasn't changed for ~200 ms. Only stable prefixes are
decided on.

When a decision fires an action, the buffer takes a **commit point**: the
consumed prefix is dropped and whatever follows carries forward. That is
what makes one ⌥A press hold a conversation — the user never stops talking,
and each finished command clears itself out of the way.

A stable prefix that the decider calls incomplete is held. Silence past a
threshold with an uncommitted prefix discards it rather than guessing.

### Deciding, in one round trip

A flat choice over everything a Mac can do is both too large for a single
`choice` (255 options) and the wrong shape. Deciding is two questions:

1. **Intent** — which of ~15 kinds of thing is this? Launch, switch, menu
   command, navigate, window, focus, press, type, dictate-into, Clance,
   ask-Claude, undo, cancel, stop, none.
2. **Target** — resolved *within* that intent, from the provider that owns
   it: the app list for launch, this app's menu tree for a menu command, the
   window's controls for press.

Two questions would normally mean two round trips. Jev prices a batch of
questions at roughly the cost of one, so both stages are issued **in a
single speculative fan-out**: the intent question, plus the target question
for each of the two or three intents most likely given the app in front. One
call, ~100 ms, and the resolution is already in hand when the intent lands.
Where the speculation misses, a second call resolves it — rare, and still
inside budget.

```ts
type Situation = {
  utterance: string;              // the stable prefix only
  app: { name: string; bundleId: string; windowTitle: string };
  candidates: Record<IntentId, Candidate[]>;
  mode: "command" | "dictating";
};

type Decision =
  | { kind: "wait" }
  | { kind: "resolved"; intent: IntentId; candidateId: string; confidence: number }
  | { kind: "ambiguous"; intent: IntentId; among: Candidate[] }
  | { kind: "escalate"; prompt: string }
  | { kind: "none" };

interface Decider { decide(s: Situation): Promise<Decision>; }
```

A decision **names** an intent and a candidate; it never builds the action.
Turning a candidate into something performable is the resolver's job, one
step later, in the session. That seam is what lets a decider be swapped
without knowing how anything is performed — and it is why no `Decider` ever
holds a function that could act.

**Candidates are ids; their text lives in the state.** The obvious encoding
— the label as the option key, its detail as the description — sends every
candidate's words twice and makes two controls called "Send" impossible to
tell apart. Instead each candidate gets a short id, the options are bare ids
with no description, and one table in the state says what each id is:

```
e12 menu "New Tab" · File > New Tab
e13 target "Jon Stewart - Wikipedia" · AXLink, scrolled out of view
```

Measured on a live window, that took the target questions from carrying
their own prose to 0.2–1.1 kB each.

**The request has an element budget, not just a per-question one.** A dozen
questions each comfortably under the per-question cap still produced a
219-line, 10 kB table for "quit Discord" — most of it the Apple menu's
Recent Items and every installed app. A global cap of 120 fixed that: 19.1
kB to 8.7 kB, table 10.0 kB to 2.3 kB. When the budget runs out, **whole
questions are dropped rather than lists truncated**, so every question that
is asked offers a complete set and a missing answer means "not asked" rather
than "silently unavailable".

**Every question offers a way out.** `None of these` is an option on the
intent question and on every target question, because the user can always
name an app that isn't installed or a button that isn't on screen. Without
it a `choice` is a forced choice and the model has to name *something* —
which is precisely how "quit Discord", with Discord absent, becomes a press
of whatever was nearest.

**A list too big for one question becomes two.** `choice` takes at most 255
labels and a large menu bar passes that alone (Chrome offers 292). Trimming
the list to fit is the obvious fix and the wrong one: a target that was
never offered is indistinguishable, from the answer, from one that was
offered and rejected — which is why "omit candidate values that the model
cannot choose" is on TypeSafe's own list of things not to do. A menu bar is
already a tree, so it is asked as one: which menu, then which command in it,
with the commands of the two likeliest menus riding along speculatively.
Measured against a synthetic 401-command menu bar, every command stays
reachable and the largest single question drops to 42 options.

`JevDecider` is one implementation. `KeywordDecider` — string matching over
the same candidate lists — is the other, and is not a toy: it is the test
double, it is what runs with the decision service switched off in Settings,
and it is the fallback when Jev is unreachable. The assistant degrades to
"the commands it can recognise locally" rather than to nothing.

A phrase whose verb named an intent is answered **only** from that intent.
Several cues can legitimately fire on one phrase — "go to the top" is both a
`switch` and a `navigate` — so a cue that finds nothing hands on to the next
one, but none of them hand on to the uncued menu search. That rule exists
because its absence was caught in a log: "quit Discord", with Discord
momentarily missing from the running-app list, fell through to a Recent
Items entry called "Discord" and *pressed* it — `safe` risk, no
confirmation. Having understood the verb, the honest answers are "that isn't
here" or "ask Claude"; never "here is something with a similar name".

### Pursuing a goal, not performing a command

The assistant does not decide once and act once. It **perceives, decides,
acts, and looks again**:

```
goal = "search for Jon Stewart and open the first result"

┌─► read the window (AX + frames)     ~200 ms
│   one batched call:                 ~400 ms
│     • has the goal been reached?          (noul)
│     • what kind of thing is the next step? (choice)
│     • which target / which span?          (choice)
│   perform one step                  ~100 ms
└── not finished? go again
```

~700 ms a step, so a two- or three-step task lands inside two seconds. That
is only possible because a batch of typed judgements costs about what one
costs — a planner would be slower *and* more brittle.

Nothing is planned in advance, and that is the point: every turn decides
against what is **actually on screen now**. If a page loads differently, a
click misses, or a dialog appears, the next turn simply sees it. A plan made
up front would have to be repaired; a loop has nothing to repair.

**The goal lives in code**, in a `Pursuit`, alongside the steps taken so
far. The decider is handed both fresh every turn and never needs memory of
its own — which is what keeps it a pure function of what it is shown, and
keeps `KeywordDecider` a viable substitute.

Three things bound it, because a loop is the one failure mode here that
could act on the user's machine indefinitely:

| | |
|---|---|
| A step cap | six, ending loudly and saying how far it got |
| Repeat detection | the same step twice running means it is already done |
| Escape | breaks out at any point, mid-step included |

A question — a confirmation or an ambiguity — carries the `Pursuit` with it,
so answering "yes" halfway through resumes the task rather than ending it.

Choosing the same step twice is read as **success**, not failure. It was
briefly reported as "didn't seem to change anything", which was alarming and
wrong: the click had worked and the page had navigated, and the only thing
that hadn't kept up was the `finished` judgement, which sits at 0.41–0.53
immediately after a click while the page is still settling. Re-deciding the
same action is the clearest evidence there is nothing left to do.

**"Has it finished?" is its own call**, asked between steps before the
screen is read at all. It needs the goal and what has been done and none of
the hundred-odd candidates that deciding a *next* step requires — one noul,
about three hundred tokens. Folded into the main fan-out, as it first was,
every single-step command paid a full window read and a five-thousand-token
call to be told it had already finished: measured at ~200 ms of model time
on top of ~300 ms of reading, on every command.

`KeywordDecider` cannot judge progress: comparing a screen against an
intention is exactly what string matching can't do. It reports the goal
finished after its single step, so with the decision service off the
assistant degrades to the voice command line it was before the loop existed.

### Intents and resolvers

An intent is a kind of thing to do; a resolver turns a phrase into a target
and a way to perform it.

```ts
type Resolution = {
  intent: IntentId;
  label: string;                  // what the HUD shows: "New Note — Notes"
  risk: Risk;
  perform(): Promise<Outcome>;
  undo?(): Promise<Outcome>;
};

interface Resolver {
  id: IntentId;
  candidates(ctx: Context): Promise<Candidate[]>;   // fed to the decider
  resolve(c: Candidate, ctx: Context): Resolution;
}
```

| Resolver | Candidates from | Notes |
|---|---|---|
| `launch` / `switch` / `quit` | Installed and running apps | |
| `menu` | The frontmost app's menu tree | The reason this generalises — see below |
| `navigate` | A fixed verb set | Scroll, page, top, bottom, back, tabs *(new)* |
| `window` | The app's windows | Move, resize, fullscreen, arrange *(new)* |
| `target` | The window's controls | Focus or press, by label or by position |
| `site` | Known websites, plus any domain actually spoken | "Open YouTube", "go to github dot com" |
| `search` / `find` / `type` | **Spans of the utterance itself** | See "Filling an argument" |
| `text` | Stored values, dictation | Hands the microphone over; the words aren't said yet |
| `clance` | Clance's own verbs | New session, open a section, start dictation |
| `claude` | — | Always available; see "Handing off" |

Adding a capability is adding a resolver. The session, the decider and the
actuator don't change, which is what keeps the *(new)* list in
`assistant.md` a matter of work rather than redesign.

### Filling an argument

"Search for Jon Stewart" is a verb and an argument, and the argument is in
no list of things that exist on the Mac. It is in the sentence the user just
said. That is the whole gap between an assistant that picks nouns and one
you can talk to.

Jev cannot write text, and that is the feature rather than the obstacle.
Code over-generates every plausible slice of the utterance, Jev picks one,
and code copies it **verbatim**:

```
"search for Jon Stewart."  →  ["Jon Stewart", "Stewart", "Jon"]
                               ↑ Jev picks; code copies
```

The value that comes back is a substring of the transcript. It cannot be an
invented name, a dropped word or a transposed digit — TypeSafe's find-and-pick
guarantee, and the reason this is safer than asking a generative model to
extract the same thing.

**It needed no new machinery.** A span *is* a candidate: `candidates()`
builds the list, the decider names one by id, a resolver turns it into a
`Resolution`. The only addition was `utterance` on `Context`, so a resolver
whose candidates are slices of the sentence can see the sentence.
`spans.ts` generates them longest-first — a complete phrase is nearly always
the intended argument where a fragment of it is not — trimming leading and
trailing function words and whisper's trailing full stop, which would
otherwise be searched for along with the name.

**A command often carries its own destination, and the destination is not
part of the argument.** "Type hello world *into the search box*" ranked
`"hello world into the search box"` top, because it was the longest, so the
assistant would have typed the instruction along with the text. Spans from
the payload alone now rank above spans from the whole sentence — both stay
available, since the phrase might genuinely have been meant, but the shorter
one leads. Only trailing, and only before a word that names a destination,
so an argument containing "in" or "on" in the middle is untouched.

**`type` and `text` are separate intents on purpose.** They look alike and
are opposites: `type` writes words the user has *already said*, `text` hands
the microphone over so they can say them *next*. Live traffic showed what
merging them costs — "Type John Stewart" landed on "Dictate into Address and
search bar" at p=0.49 with the no-match outcome right behind at 0.29, which
is the model saying the right option was not on the menu. It wasn't.

**The site resolver** exists because "open YouTube" is not a launch.
YouTube is not an application, and the assistant used to search all
seventy-nine installed apps, find nothing, and hand the request to Claude.
Code owns every URL and the decider only picks a *name*: a model that cannot
type a URL cannot mistype one. A domain is only offered when it was actually
spoken — "github dot com" is rewritten, never invented — and it has to end
in a known suffix, not merely letters after a dot, or "search dot something"
navigates to a word somebody was using as a word.

**The menu resolver** is what lets the assistant work in apps Clance has
never seen. macOS apps publish their whole menu bar through the
accessibility API (`ax.tree({ root: "menuBar", includeEnabled: true })`), so
an app's commands are read rather than taught, and include whether each is
currently enabled. It is cached per bundle id and window title and
invalidated when either moves — a menu is a function of the app's state, and
a stale one offers commands that fail.

The *first* read of an app's menu bar is slow: ~4.4s measured against Finder
cold, against ~60ms for every read afterwards, because macOS populates the
menus on first access. That is far outside the latency budget, so the warm-up
runs on the ⌥A press itself, unawaited, overlapping the second or two of
speech that follows. It stays "on demand, never ambient" — the user has just
asked for the assistant. Nothing is read before they do.

An item that owns a submenu is a heading, not a command; its children are the
commands. A greyed-out item is reported as unavailable rather than pressed,
because `AXPress` on a disabled item succeeds and does nothing, which is the
worst possible answer.

Some apps refuse `AXPress` on an item they will happily run from the
keyboard — Chrome rejected Close Tab twice while accepting New Tab from the
same menu. Every item with a shortcut publishes it, so the shortcut is the
fallback: `AXMenuItemCmdModifiers` is a bitmask of what to add to Command,
with one inversion — bit 3 means there is no Command key at all, so 0 is a
bare ⌘, 1 is ⇧⌘, and 8 is the key on its own.

### Naming a thing on screen

A control's accessibility label is not what a person would call it. A search
result's runs to the headline, the full URL and the breadcrumb together —
`"John Stewart (character) Wikipedia https://en.wikipedia.org › wiki ›
John_Stewart_(charact…"` — and a hundred and thirty-nine of those made a
7,000-token question nobody could answer: the model picked between
near-identical walls of URL at p=0.31. Labels are now the first line, up to
the URL, capped at sixty characters, which is both what the user would have
said out loud and a 40% smaller question.

### One tree per command

Walking a window's accessibility tree costs ~300 ms on a large page, and the
resolvers that need it — press, focus, dictate-into — each used to ask for
their own, so a single spoken command paid for the same tree three times.
It is now walked once per gather and shared, by memoizing the *promise*
rather than the result, which is what makes sharing work when
`gatherCandidates` fires every resolver in parallel: the first caller starts
the walk and the rest wait on it. Measured: the second reader went from
334 ms to 0.

There is deliberately no expiry on that cache. It is dropped explicitly at
the start of each gather, so the tree is always exactly as old as the
command being decided — which matters much more in a loop, where the screen
has changed between one step and the next.

### Reading a web page

For every app but one, macOS's accessibility tree is the right source. For a
browser it is a lossy projection of something far better, and that is why
the assistant was worst at exactly the thing people use most:

| The DOM has | The accessibility tree gives |
|---|---|
| `getComputedStyle`, `checkVisibility()` | nothing — a hidden skip-link looks like the first real link |
| `href` | nothing — a link is only its text |
| `aria-label`, then `innerText`, then `value`, in order | all of them concatenated into one string |
| ids written into the page, surviving a re-render | handles that go stale |
| `element.click()` | a click at a coordinate |

That concatenation is what produced labels like `"John Stewart (character)
Wikipedia https://en.wikipedia.org › wiki › John_Stewart_(charact…"`, and a
hundred and thirty-nine of those is a question nobody could answer.

`capabilities/browser.ts` reaches the DOM of the browser the user already
has open, through AppleScript — no relaunch with a debugging port, no
extension to install. It runs a collector inside the page that applies the
checks above, writes a `data-clance-id` onto each element so it can be acted
on later even if the page has re-flowed, and returns them in reading order
with the page's own search box identified. Acting goes back the same way, by
id: `scrollIntoView` then `click()`, and typing uses the native value setter
plus `input`/`change` events, because a framework ignores a value assigned
behind its back.

It costs the user one switch — **View → Developer → Allow JavaScript from
Apple Events** — which Clance reports once per listening session rather than
silently degrading. Without it, browsers fall back to the accessibility
tree and behave as they did before.

### Describing a window, not a document

The accessibility tree is the whole document. The user is looking at one
screenful of it. Measured on a real page: **23 links in the tree, 3 on
screen.** Everything the assistant got wrong about "the first link" comes
from that gap — it was answering questions about a document while the
person asking was looking at a window.

Reading every control's frame closes it, and costs **+45 ms on a 666-node
tree**, measured. An earlier version of this document asserted the latency
budget had no room for that. It was wrong, and wrong in the direction that
mattered: this is the single cheapest thing that makes the assistant
understand what the user can see.

So controls are now **sorted the way a person reads** — visible first, then
the page's own content, then down and across it — rather than in document
order, which on a web page is often nothing like it.

Content before chrome matters as much as visible before hidden. Measured on
a real results page, the first eighteen controls in reading order were ten
tab-strip buttons followed by New Tab, Ask Gemini, Tab Search, Close, Back,
Forward and Reload, while only twenty-two of the page's own links were on
screen at all. A list capped for size then keeps the tab bar and drops the
page, which is exactly backwards: a command spoken at a browser is almost
always about the page. Off-screen controls are kept rather than
dropped, because "click Send" should still work when Send is just below the
fold; they sort last, and their description says they're scrolled out of
view, so that fact reaches the decider rather than being filtered out behind
its back.

Ordinal candidates — "the first link", "the last button" — ride alongside
the named ones carrying the same ids, so either route resolves to the same
control. They count only what is **visible**, and only what is **inside the
page**: a browser's Back and Reload sit outside the `AXWebArea`, and nobody
counting links on a results page starts at the toolbar.

What remains is the gap between *visible* and *meant*. "The first link" now
resolves to the topmost link the user can see, which is a good deal better
than a hidden skip-navigation link, but a human saying "the first link" on a
results page means the first **result** — a heading, a link and a snippet
read as one thing. Nothing here groups controls into results, and doing so
is app-specific in a way the rest of this design avoids.

### Risk and confirmation

Risk is a property of the intent, narrowed by the resolver — never a
judgement the decider makes about itself. Asking the component you don't
fully trust to decide whether it should be trusted is not a gate.

| | |
|---|---|
| `safe` | `navigate`, `window`, `switch`, `focus` — by construction reversible |
| `confirm` | `quit`, anything matching a destructive lexicon (delete, remove, trash, send, discard, erase, clear, reset), anything the resolver can't classify |

The default for the unclassified is `confirm`. A menu item Clance can't
place is confirmed, which is noisy and correct; the noise is answered by a
per-app allow list the user grows by saying "always allow this", not by
loosening the default.

Separately, confidence below a threshold asks even for a `safe` action, and
a third signal can raise risk: a `destructive` noul asked in the same call —
*would carrying this out delete, send or spend something?* It can only ever
**raise** risk, never lower it. Asking the component you don't fully trust
whether it should be trusted is not a gate; letting it raise an alarm over a
floor set elsewhere costs nothing.

Every number lives in `thresholds.ts`, in one file, because they are only
meaningful together and against a particular model version:

| | |
|---|---|
| `intent` 0.55 | confidence needed to act at all |
| `target` 0.45 | below this, ask which one rather than press a guess |
| `targetTopProb` 0.35 | and the winner must hold at least this much |
| `isCommand` 0.5 | were they addressing Clance at all? |
| `destructive` 0.5 | above this, confirm whatever the intent says |
| `quit` 0.8, `type`/`text` 0.65 | the only intents needing more than `intent` |

These replace a set roughly twice as high — `target` was 0.85, `menu` 0.8 —
derived by reasoning from TypeSafe's generic guidance, which is written
around decisions like approving a bank transfer. A floor of 0.9 is right for
moving money and wrong for clicking a link, and the result was an assistant
that asked permission while being perfectly certain. The values here are
still not measured; they are at least in the range that working
implementations of this exact task use.

**The model is pinned** to `jev-1.13.0`. Aliases move on release and every
number above is meaningful only against one version, so `jev-latest` meant
tuning against a moving target.

Where a decision came from two questions — an intent and a target — the
confidence the gate reads is the **weaker of the two**, not their product:
one wrong half is enough to spoil the result, which is the rule TypeSafe's
function-calling cookbook arrives at for the same reason.

### Acting

One serial executor. Commands are queued in the order they were committed
and run one at a time; a command spoken while the previous is still running
waits rather than racing it. Every outcome is reported — performed, refused
with the app's own words, or unavailable.

Undo has three tiers, tried in order: a `Resolution`'s own inverse where it
has one (switch back, refocus the previous field, put the window back); the
app's own undo where the app accepts it; otherwise Clance says it can't,
which is precisely the set of things that were `confirm`-risk on the way in.

Moving a window is **position, then size, then position again**. macOS clamps
a window's size to what fits on screen *from its current origin*, so growing
a window that is sitting low down silently comes back short — measured, a
request for 1470×923 landed as 1470×671 because the origin was still at
y=285. Some apps refuse outright (Chrome), which is reported rather than
retried.

### Handing off

`escalate` is both the path for anything needing reasoning and the fallback
for anything no resolver claimed, so the assistant never dead-ends.

- No suitable session running: mint one with `--append-system-prompt`
  carrying what the user said, the app and window, and the selection.
- A session already working where the user is: write the prompt into its
  PTY, which Clance already owns.

Matching a running session to the work in front of the user is the same
unsolved problem the Changes pane has (see Open questions); until it is
solved, escalation always mints.

### What leaves the Mac

The key lives in a gitignored `.env` read once at startup (`env.ts`,
`.env.example`), under the name the TypeSafe SDK reads anyway —
`TYPESAFE_API_KEY`. Deliberately not in `config.json`: that is the file a
user copies between machines or pastes into a bug report.

Settings shows what is *actually* deciding, not what is configured. The two
come apart on every fresh install — the toggle defaults to Jev, no key
exists, and local matching runs — and a toggle that silently means the
opposite of what it says is worse than no toggle.

State is kept to the three fields that bear on the decision — the utterance,
the app's name, and its window title truncated to 80 characters. "Large
state with irrelevant detail" is a documented Jev failure mode, and a
browser tab title routinely runs to a hundred characters of site name,
section and "Audio playing", none of which helps decide what was just said.

Questions are written for a **literal reader**, and each one has to carry
its whole meaning: a question's id is for code and is never sent to the
model. So each target question is a plain sentence that names the state it
is about and states its own premise — "If `utterance` is asking to open an
application, which one?" — rather than using Clance's vocabulary or relying
on a key called `target_launch` to supply the context. Most of these
premises are false on any given call, which is the point of asking them all
at once; saying so in the question is what stops a false premise being
answered as if it were true. The intent options carry `what`/`not_for`
pairs, structured criteria being TypeSafe's advice for exactly the case
here: options that genuinely risk being confused with each other, launch
against switch, menu against target.

The `Situation` type carries the command buffer, the app's identity and the
candidate labels. It has no field for document text, field contents or
anything dictated, and dictated content lives in a buffer no `Decider` is
handed — so content reaching a third party is a compile error rather than a
convention. The `dictate-into` intent resolves to *focusing a field and
handing off to the dictation path*; the words themselves never pass through
the decider at all.

### Surface

The HUD *is* `dictationWindow.ts`, not a copy of it — `focusable: false`,
`showInactive()`, always on top, pre-warmed at launch, excluded from Clance's
own screenshots — because the assistant's whole premise is that the app the
user was in keeps focus, which is the same premise dictation already has. Two
of them can never be up at once anyway: they are the same microphone. The
renderer keeps its capture code unchanged and swaps only what is drawn, on an
`assistant:view` message. It shows what is being heard, what is about to
happen, and what just happened; questions and confirmations render there and
are answerable by voice or Escape.

Listening is dictation with a `purpose`. ⌥D transcribes and inserts; ⌥A
transcribes and hands the text to the session instead of pasting it — same
whisper, same HUD, same silence detection, one flag deciding where the words
land. Until streaming lands (step 5), the session re-arms listening after
each utterance, which is what makes one ⌥A press hold a conversation rather
than take one command. With streaming the re-arm goes away: the microphone
simply never closes, and nothing above it changes.

**Dictating into a field** is where those two uses of one microphone meet.
"Dictate into the subject" focuses the field and hands over to the ordinary
⌥D path; the words the user then says are transcribed on the Mac and
inserted by `dictation.ts`, and never pass through a decider at all — which
is what keeps dictated content off the network by construction rather than
by policy.

The handoff is **awaited**: `dictateOnce()` resolves only when the dictation
has ended, however it ended. That is not incidental. The assistant re-arms
its own listening the moment a queued action returns, so a fire-and-forget
handoff means the session takes the microphone back milliseconds after
handing it over — `toggleDictation` sees a live recording, reads it as the
user pressing the key again, and stops it. The user gets no dictation at
all. Holding the assistant's turn open for the length of the dictation is
the fix, and it falls out of the serial queue for free: nothing else runs
while a command is still running.

The decision service is a single toggle in Settings → assistant, which says
in the UI exactly what is sent. Off, the assistant runs on `KeywordDecider`
and still works.

### Latency budget

Measured against live traffic through `jev-1.13.0`, not estimated:

| | | |
|---|---|---|
| Partial to stable prefix | ~200 ms | inherent to streaming ASR; not built yet |
| Gather every intent's candidates | 97–463 ms | measured |
| Decide — one fan-out call | 406–623 ms | measured |
| Dispatch through AX | 27–283 ms | measured; a launch costs the most |
| **Command complete to action begun** | **580–1250 ms** | measured |

The earlier version of this table guessed ~100 ms for the decide and ~350 ms
in total. Both were wrong by a factor of four or so. The decide is the whole
budget: Jev's published range is 70–500 ms and these calls sit at the top of
it, because a fan-out over an app's whole menu bar runs to four to six
thousand input tokens.

A speculation miss adds a second round trip of 330–480 ms, which is why the
fan-out is rationed by **cost rather than relevance**: every candidate list
of fifteen or fewer is asked about unconditionally, and only the large lists
— installed apps, on-screen controls, the menu bar — compete for the two
remaining slots. Live traffic made the case: `text`, four candidates, was
twice ranked out by word overlap and twice cost a full second pass, while
`menu_in:Apple` — sixty-one options of Recent Items — was sent five times
and used never.

The budget still has no room for walking a menu tree inline, which is why
menus are cached and warmed on the ⌥A press, nor for a second ASR pass,
which is why deciding runs on the stable prefix rather than a final
transcript. The local decider costs ~0 ms, so everything here is the network.

### What the log says

The assistant logs to the main process's stdout, in the same shape as
`localToolsServer.ts`, so a session's tool calls and a spoken command read
as one timeline. One command is one block:

```
[assistant …] listening — deciding with Jev
[assistant …] heard "quit Discord" in Electron — candidates in 579ms:
              launch 79, switch 11, quit 11, menu 97, …, target 135
[assistant …] asking about "quit Discord" in Electron — quit 11, menu 200 of 292
[assistant …] answered in 118ms (2104 in, 0 out, jev-1)
[assistant …] intent: quit (0.94) [then menu 0.04]
[assistant …] target: "Discord" (0.91) [then Code 0.03] → confidence 0.91
[assistant …] decided resolved in 121ms (712ms total)
[assistant …] asking before "Quit Discord" — quit is confirm and not on the allow list
```

`p=` is the chosen option's share of the distribution and `conf=` is how
concentrated that distribution was. Both are shown, and both are labelled,
because they are different scales: an earlier version printed confidence
bare next to the runners-up's probabilities and produced lines like
`"Dictate into Address and search bar" (0.17) [then Dictate here 0.23]`,
which reads as the model picking a less likely option and was nothing of
the kind.

One line in there is a diagnosis rather than a fact:

```
menu was certain but no candidate fitted — best "…" p=0.49, none p=0.29. Missing skill?
```

High intent confidence, low target confidence, and the no-match outcome
close behind is a signature worth naming. It is not the model being unsure
what the user meant; it is the model saying the right option was never
offered — a gap in the skill list, not a tuning problem, and the two have
opposite fixes. It is how `type` was found.

A low target confidence is now a **question, not a refusal**: the top few
candidates by probability become "which one?", answerable by voice. That is
where most of the old confirmation noise went — the assistant was treating
"several of these look alike" as a reason to stop rather than as the
obvious thing to ask about.

Three things it is built to answer:

- **What was asked.** The candidate counts per intent, and `200 of 292`
  where a list was trimmed for Jev's 255-label cap — so a target that was
  never offered is distinguishable from one that was offered and not picked.
- **What it nearly said.** The runners-up beside each choice. A confidence
  alone can't tell "the labels are ambiguous" from "the question is wrong",
  and those need opposite fixes.
- **Why it stopped.** A confirmation names which of the two reasons applied
  — a confidence below the floor, or an intent's risk — because one is tuned
  and the other is allowed.

API failures are one line carrying the status, the parsed body and the
request id, rather than a stack trace through the SDK's internals: a 401
means the key is wrong and a 400 means the *request* is wrong, and the body
is the only thing that says which.

The utterance is logged in full. It is by construction a command addressed
to Clance, and when the decision service is on it is already leaving the
Mac. What can never appear is a field's contents or anything dictated —
neither reaches this layer at all.

### Build order

1. **Done.** Extract `capabilities/` from `localToolsServer.ts` — pure
   refactor — plus the capabilities the assistant needs that Clance didn't
   have: menu commands, launch and quit, navigation, window arrangement,
   focusing a field.
2. **Done.** Intents, resolvers and the actuator, exercised by
   `KeywordDecider` over whole utterances from today's stop-then-transcribe
   flow. The assistant works end to end here, without streaming and without
   Jev.
3. **Done.** The HUD, risk gating, confirmation and undo.
4. **Written, unproven.** `JevDecider` behind the same interface. It has
   never run against the live API — there is no key on this machine — so it
   is the one part of this whose behaviour is a claim rather than a
   measurement.
5. **Not started.** Streaming partials and the commit-point buffer.
   `TranscriptBuffer` is built and unit-tested for revision, stability and
   commit points; nothing feeds it partials yet.

Steps 1–3 are shippable on their own as a push-to-talk assistant. Streaming
is what makes it feel alive, and it is deliberately last because it is the
only step that changes the dictation engine.

## Setup, permissions and shortcuts

### Setup gating

`setupStatus.ts` is the single definition of "set up": the `claude` CLI is
installed and signed in, Accessibility is granted, and shortcuts are
confirmed. Nothing is cached as done — auth and permissions are re-checked
live, since either can change outside Clance. Until complete, the main window
opens the wizard (`SetupWizard.js`: Claude → Permissions → Shortcuts →
Dictation) and the popup hotkey isn't registered. The wizard shows its steps
as a numbered row and every step after the first has Back. Dictation's hotkey
doesn't depend on setup. The same step components render in Settings
afterwards, as status rows (`StatusCard.js`: title, description, a mono status
word, an optional action) in one column of headed groups (access, clance
tools, general, shortcuts, dictation). Microphone access sits under Access with the other
permissions; the speech model is one row that expands into the model list.

Each section loads its own data at a different speed, so Settings stays hidden
until every section reports ready (`onReady`, at most 1 s) and then appears
whole instead of filling in row by row. The Claude row doesn't hold it up: it
starts from the last status any window checked (`setup:get-last-status`, set
at launch and on window focus) and re-checks in the background.

In the wizard, Enter presses the step's primary button unless focus is in a
text field, button or the shortcut recorder. Permissions are re-checked on
window focus and every 2 s while any is missing, so the step advances without
a Recheck button. The Dictation step offers the recommended model, a menu of
the others, and lets the user finish while the download continues.

### Claude CLI

`claudeAuth.ts` delegates to `claude auth login` and `claude auth status`.
Because an app opened from Finder or the Dock gets launchd's minimal `PATH`,
detection checks standard install directories first, then the login-shell
`PATH`, capped at 8 s since startup awaits it.

### Permissions

`permissions.ts`:

- **Accessibility** (required). "Grant" calls
  `isTrustedAccessibilityClient(true)`; checking with `false` never adds
  Clance to the list.
- **Screen Recording** (optional). There's no request API, and checking the
  status doesn't register the app. A throwaway `desktopCapturer` call on the
  user's button press does. macOS shows that prompt only once per app: after
  Clance's entry is removed, it never reappears on its own and has to be
  added with the list's + button, which the wizard explains. A new grant
  applies only after relaunch, so the step offers "Restart Clance".
- **Microphone** (dictation only). `askForMediaAccess`, with
  `NSMicrophoneUsageDescription` in `package.json` — without it macOS
  terminates the app on first microphone use.

A grant stored for an app with a different signing identity looks switched
on in System Settings but doesn't apply; removing the entry and granting
again fixes it (see "Signing").

### Shortcut recorder

`ShortcutsStep.js` records the pressed keys using `event.code` (`event.key`
reports ⌥G as "©"). While recording, Clance unregisters its own hotkeys so
pressing the current binding reaches the recorder instead of firing.
Validation, because a global shortcut applies in every app:

- Needs ⌘, ⌥ or ⌃, unless it's a function key — otherwise typing that key
  anywhere triggers Clance.
- ⌘ alone isn't enough; it needs ⌥, ⌃ or ⇧ too, or it steals an ordinary app
  shortcut.
- ⌘Tab, ⌘Space, ⌃⌘Q and ⌘⌥⎋ are rejected with a reason.
- Two actions can't share a binding — checked in the UI and again in
  `setup:save-shortcuts`, because `globalShortcut.register` fails silently for
  the second.
- `isValidAccelerator` in main has the final say: it tries to register the
  accelerator.

Escape cancels recording; Backspace resets to the default.

## Packaging and distribution

### Signing

macOS stores a permission grant against the app's *designated requirement*.
An ad-hoc signature's requirement is a hash of the app's contents, so every
build becomes a different app and grants silently stop applying. Clance is
therefore signed with a self-signed certificate, "Clance Code Signing", whose
requirement (`identifier "dev.damiensmith.clance" and certificate leaf = H"…"`)
stays identical across builds. It is not an Apple Developer ID, so there's no
notarization.

- `scripts/create-signing-cert.sh` creates and trusts the certificate in the
  login keychain (one-time, with password prompts). It refuses to create a
  second one, since a new certificate changes the identity. Back it up as a
  `.p12`; losing it means every user re-grants permissions once.
- Hardened runtime is off. Without a team identifier, library validation
  rejects the native addons (`node-pty`, nut-js) and the app won't launch. It's
  only required for notarization.
- `npm run package` builds `release/mac-arm64/Clance.app`.
  `npm run dev:packaged` is the dev loop: rsync `dist/` into that app,
  re-sign (with the certificate if present, ad hoc with a warning otherwise),
  install to `/Applications` and relaunch. Running from `/Applications`
  matters: grants for bundles rebuilt in a repo folder were unreliable, and
  the raw `electron .` binary shares one identity with every Electron app on
  the machine.

### Homebrew cask

Clance ships as a cask in a personal tap — `packaging/homebrew/clance.rb`,
copied to `github.com/damiensmith1/homebrew-tap` as `Casks/clance.rb` — not as
a formula, whose versioned `Cellar` path would change the app's location
every upgrade.

- `depends_on arch: :arm64`, `macos: :ventura` (Electron's floor) and
  `formula: "whisper.cpp"`.
- **Quarantine.** Homebrew quarantines every cask download, and an
  unnotarized app would be blocked by Gatekeeper on first launch. The cask
  removes the attribute in `postflight_steps`, so installing from the tap is
  the trust decision. Homebrew 7 requires the declarative `postflight_steps`
  and runs them in a sandbox; the `run` step must declare `writable_paths` or
  `xattr` fails for a home-relative `--appdir`. This is also why Clance can't
  be in the official `homebrew/cask`.
- `zap` removes `~/.clance` and Clance's Library files.

### Releasing

`sh scripts/release.sh` builds `release/Clance-<version>-arm64.zip`, signed
with the certificate, and rewrites the cask's `version` and `sha256`. It
refuses to sign ad hoc unless `CLANCE_SIGN_IDENTITY=-` is set explicitly,
since that would reset every user's permissions. It stops there and prints
the two public steps: creating the GitHub release and pushing the cask to the
tap.

### Updates

`updates.ts` compares `app.getVersion()` with the latest GitHub release and,
if newer, shows `brew upgrade --cask clance` and a release-notes link (only
this repo's releases pages can be opened). The main window checks once per
launch (`app:launch-update-check`, cached in main so reloads don't re-fetch)
and shows a toast with Copy upgrade command; Settings has a manual check.
Clance doesn't install updates itself: an app that replaces itself leaves
Homebrew's record pointing at a missing app, and the next `brew upgrade`
fails. Running `brew` from inside Clance would quit Clance before any error
could be shown. The check is unauthenticated (GitHub allows 60 requests an
hour); rate limiting gets its own message, and the launch check stays silent
on errors.

## Open questions

- **The ⌥A confidence threshold is unmeasured.** Per intent, and pickable
  only from real utterances by real voices — too low and the assistant acts
  on what it misheard, too high and it asks about everything. There is no
  bench substitute for this.
- **The destructive lexicon is a heuristic.** Risk falls back to `confirm`
  for anything unclassified, which is the safe direction, but the word list
  that classifies the rest is English and assumes apps word things the usual
  way. An app that calls it "Move to Archive" gets confirmed (harmless); one
  that calls destruction something friendly gets classified `safe` by a
  resolver that recognised it for another reason. The allow list lets a user
  loosen this; nothing lets them tighten it.
- **Speculative fan-out hit rate is unknown.** Issuing target questions for
  the two or three likeliest intents alongside the intent question is what
  keeps deciding to one round trip. How often the speculation misses — and
  therefore what the real latency distribution looks like rather than its
  best case — can only be measured against real commands.
- **The per-intent confidence floors are guesses.** They follow TypeSafe's
  shape — a 0.6 universal floor, raised by what acting wrongly costs — but
  the numbers above it are reasoned, not measured, and the docs are explicit
  that cookbook thresholds are not universal rules. They need real
  utterances by a real voice.
- **The decision timeout is a ceiling, not a measurement.** Jev gets 1500 ms
  and no retries, because the local decider answers in under a millisecond
  and retrying a classifier the user is waiting on mid-sentence is strictly
  worse than falling back. The SDK's own defaults — two retries with
  backoff — measured at 13.4 s against an unreachable host, which is not
  degrading, it's breaking. Whether 1500 ms is the right ceiling depends on
  what the fan-out actually costs, which is still unmeasured.
- **A cold accessibility read returns an empty list, not a slow one.**
  Caught in a log: the same `quit` candidates came back as 10 on the first
  command after ⌥A and 11 a second later, and `target` as 0 then 135. The
  warm-up on the ⌥A press is what this is for, and it usually wins because
  the user then speaks for a second or two — but a fast speaker can still
  be decided against a short list, and nothing currently notices that the
  list was short.
- **The 200 ms stability window is a guess.** Too short and the decider runs
  on transcripts whisper is about to revise; too long and the assistant
  feels laggy. It likely depends on the speech model.
- **Jev's own documented weak spots are only partly designed around.**
  Literal reading, indirection and distraction by irrelevant state are
  handled — plain instructions, filtered state, structured criteria. Two
  are not: the assistant never asks Jev to count or compare anything
  numeric (fine), but it does rely on `confidence` being comparable *across
  question types* when it takes the minimum of an intent and a target
  answer, and "don't transfer thresholds across question types" is on the
  known-limitations list. Both are `choice` questions, which is the
  charitable reading, but it is an assumption.
- **Jev is new, waitlisted and unproven, and `JevDecider` has never run.**
  Jev launched in September 2026, access is granted by request, and its
  calibration is attested only by its own vendor. `JevDecider` is written
  against the published SDK types and typechecks, but no call has been made:
  every claim in "Deciding, in one round trip" — the fan-out's cost, the
  ~100 ms, the confidence numbers the risk gate reads — is the vendor's or
  the design's, not a measurement. `KeywordDecider` is measured, works, and
  is what runs until a key is in place.
- **Two labels the same.** A window routinely has several controls reading
  the same word (Chrome offered "pause" twice). The decider is handed
  disambiguated labels and near-ties become a question rather than a coin
  toss, but whether a spoken answer — "the second one" — picks what the user
  meant depends on the order the accessibility tree happens to be walked in,
  which is not an order the user can see.
- **Streaming partial transcription doesn't exist yet.** The dictation engine
  spawns `whisper-cli` per utterance and reads the result from a file; the
  assistant wants partials mid-sentence. Whether `whisper.cpp` gives that
  cheaply enough on the recommended model is unknown. Until it does, ⌥A works
  on whole utterances, which the build order treats as shippable.
- **Menu-tree cache invalidation.** Keyed on bundle id *and* window title,
  thrown away when either moves. Whether that is enough is untested: menus
  also change with the selection and with document state, neither of which
  changes the window title, and a stale cache offers commands that fail. The
  failure is visible rather than silent — a command that has gone stale is
  refused by the app — but it is still a failure the user has to interpret.
- **⌥A and the Option key.** ⌥+letter produces a diacritic on macOS (⌥A is
  "å"). `globalShortcut` should intercept before the character is composed,
  but this needs verifying against a live text field — a failed registration
  would silently type "å" instead of opening the assistant.
- **Dictation accuracy on real voices.** Tier ordering and timings are
  sound, but the benchmark clips were synthesized; someone needs to record
  real utterances.
- **Model recommendation above 10 GPU cores** (`large-v3-turbo-q5_0`) is
  extrapolated, not measured on a Pro/Max/Ultra. If it disappoints, every Mac
  gets `small.en`.
- **Hold-to-talk** needs a native global key listener (e.g. `uiohook-napi`),
  since `globalShortcut` has no key-up event.
- **Dictation history retention** — unbounded today; cap or auto-prune?
- **Confirm before inserting a transcript?** Immediate insert matches the
  reference apps; a confirm step would be safer for a misrecognition pasted
  into something irreversible.
- **Silent mint failures.** If `claude --bg` fails (auth, CLI missing), a
  main-window "New Session" does nothing visible — there's no error surface
  to route it to.
- **Background agent lifetime** across Clance quitting, sleep and reboot
  hasn't been verified, and the full set of `status`/`state` values from
  `claude agents --json` isn't known (seen: `busy`/`idle`,
  `working`/`blocked`/`done`).
- **Semantic targeting.** `click_at` is coordinate-based; clicking a named
  control needs an accessibility-tree read, which hasn't been built.
- **Approval for multi-step computer use** — chains of individually harmless
  actions toward one risky outcome inside an app the user already has open
  aren't covered by per-call prompts.
- **Sessions minted before stable local tools config.** Agents minted with
  the old per-launch port and token keep that config forever: `attach`
  restarts a stopped agent with its saved flags. Re-resuming instead doesn't
  help — `claude --bg --resume` on a session that has a stopped agent starts a
  new agent under a new session id, forking the conversation. `claude rm`
  on the stopped agent (transcript kept) followed by `--bg --resume` does
  continue the same session id, but `rm` also deletes the agent's worktree,
  and detecting stale flags means reading the CLI's internal
  `~/.claude/jobs/<id>/state.json`. Not automated; affected sessions have no
  local tools.
- **`resolveOpenArgs`'s wrong-cwd branch forks.** For the same reason, a
  stopped agent minted in the wrong directory is revived under a new session
  id rather than continued.
- **Syntax highlighting is approximate.** `syntax.js` is a tokeniser, not a
  parser: a regex literal read as division, a nested template literal, JSX
  inside a `.tsx` file. It fails by leaving a word uncoloured, which is the
  right failure, but if it starts looking wrong on real files the answer is a
  vendored highlighter rather than more special cases.
- **No cross-file search.** The Files explorer answers the tree half of this;
  search is still out of scope, and a tree doesn't imply one. Whether ⌘P plus
  a tree is enough to never want grep isn't known yet.
- **Expanded directories don't survive a relaunch.** `FilesSection.js` keeps
  them in a module-level cache, so closing the tab and reopening it lands
  where it was left, but quitting forgets. Persisting them means a new store
  or a new shape in `config.json`, and it isn't clear the tree is worth one.
- **Large directories aren't costed.** A folder with ten thousand entries in
  one level renders ten thousand rows; the tree doesn't virtualise. Changes
  has the same shape and hasn't needed it.
- **Sending a diff back into a session.** The Changes pane knows the repo and
  the file; the pane next to it may hold a session working in that same
  directory. Handing a selected file or hunk to that session as context is
  the obvious next step, and the one interaction no other git UI can have,
  but it needs a reliable way to match a terminal tab to the agent whose cwd
  it is — a tab knows only its launch args. Not built.
- **Attributing a change to the session that made it.** Transcripts record
  every `Edit`/`Write` with a path and a timestamp, so the file list could
  group by which session touched what. Cost on a large transcript is
  unmeasured.
- **A dirty-file count on a Sessions row.** `chatHistory.ts` already reads
  each session's `gitBranch`; a count of uncommitted files per project would
  be the same data the Changes pane reads, but polling it for every row in
  the list has not been costed.
- **Dead code.** The `chatHistory:get-session` handler is left over from the
  old chat UI and has no callers. (`src/shared/markdown.js` was too, until a
  markdown file tab started rendering with it.)
