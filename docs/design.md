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

The central idea: **Clance never runs a model itself.** Every conversation
is a real Claude Code CLI process, started as a background agent and shown
through an embedded terminal. Clance adds OS integration around it —
hotkeys, windows, a local MCP server of screen/keyboard/mouse tools, and
on-device dictation.

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
| Packaging | `electron-builder`, self-signed | See "Packaging and distribution" |

### Local data

Clance's own state lives in `~/.clance/` (`SESSION_CWD`, `src/main/paths.ts`),
which is also the working directory for sessions that have no project:

| Path | Contents | Owner |
|---|---|---|
| `config.json` | Shortcuts, default directory, recent directories, enabled local tools, dictation settings | `config.ts` |
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
   default target for `insert_text` and the field tools.
2. The window is revealed immediately in a loading state.
3. The pool spare is claimed, or a session minted, and the popup receives
   `["attach", id]`.

An `opening` flag stops a second hotkey press from minting twice. If the
popup is dismissed while a mint is in flight, it isn't re-shown and the
minted session is cleaned up.

Popup sessions are minted with a static system prompt
(`localToolsSystemPrompt`) via `--append-system-prompt … --system-prompt-snapshot off`,
telling the model it was invoked from the popup and when to reach for each
local tool. Because it's the same text every time, a pool spare can carry it.
It's omitted when local tools aren't available.

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
| `read_selection` | auto | Clear the clipboard, simulate ⌘C, read it back, restore. Clearing first means "nothing selected" can't be confused with old clipboard contents. |
| `list_open_windows` | auto | Window titles, so the model can pass an exact `app` |
| `click_at(x, y)` | auto | Click at fractions (0–1) of the display under the cursor — independent of the screenshot's resize. No `app` parameter; the model composes it with `activate_app`. |
| `insert_text(text, app?)` | approval | Clipboard paste (write, ⌘V, restore ~500 ms later) — per-character typing was too slow |
| `activate_app(app)` | approval | Focus a window by title |
| `clear_focused_field(app?)` | approval | ⌘A, Delete |
| `replace_focused_field(text, app?)` | approval | ⌘A, paste, as one call |

`LOCAL_TOOLS` is the single list the server registration, the Clance tools
UI and the CLI arguments all read from.

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
  only land on something already on screen. `insert_text` and `activate_app`
  can reach an app the user never mentioned — auto-allowing them would let
  instructions the model read off the screen act on an unrelated app with no
  human in the loop. The field tools destroy content.
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
Dictation, Settings, and a plain terminal — rather than a
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
- Value choices (Dictation's date ranges) are a segmented pill.
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
- **Dead code.** `src/shared/markdown.js` and the `chatHistory:get-session`
  handler are left over from the old chat UI and have no callers.
