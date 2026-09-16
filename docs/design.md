---
title: Design
tags: [clance, design]
status: draft
---

# Design

## Tech stack (current)

| Component | Choice | Notes |
|---|---|---|
| Shell | Electron | per requirement — Node.js, macOS-first |
| Hotkey | Electron `globalShortcut` | |
| Screenshot capture | Electron `desktopCapturer` | resized to Claude's recommended max edge (1568px), saved to a PNG under `~/.clance/screenshots/`, then delivered to the CLI as a real image content block via clipboard + a `Ctrl+V` byte written into the pty — see "Context injection" below, not sent as a path for the model to `Read()` |
| Terminal embedding | `node-pty` (real pty process) + `xterm.js` + `@xterm/addon-fit` | vendored (not CDN-loaded) under `src/shared/vendor/xterm/`; `node-pty` is a native addon, requires `electron-rebuild`/`@electron/rebuild` against Electron's Node ABI |
| AI / reasoning / session UI | The real `claude` CLI binary, run as a child pty process | superseded the Claude Agent SDK — see "Terminal-embedding architecture" below |
| Frontmost-app read (window title, keystroke injection) | `@nut-tree-fork/nut-js` | captures the frontmost window at invocation — since 2026-09-14, purely to back `insert_text`/`click_at`/etc.'s default target, not as context text (see "Context injection" below) — the SDK-era `proposeText` accept/reject *UI* is gone with the custom chat UI, but the underlying keystroke-injection capability is back, now surfaced as an MCP tool the CLI decides to call itself |
| Local tools transport | `@modelcontextprotocol/sdk` (Streamable HTTP, stateful sessions) | local-only MCP server run inside Electron's main process — see "Local tools server" below |
| Session storage | JSONL files under `~/.claude/projects/...`, written entirely by the CLI itself | Clance no longer writes session files — every session is a real CLI process, so this is the CLI's own format, not something Clance needs to keep byte-compatible with by hand |
| Dictation speech-to-text | `whisper.cpp` (`whisper-cli`) + ggml weights, Metal-accelerated, spawned per utterance | on-device only; weights downloaded on demand into `~/.clance/models/` and SHA-256 verified. Model tier is recommended from GPU core count — see `docs/dictation.md` |
| Dictation history | `node:sqlite` (Node's built-in SQLite) + FTS5 | deliberately *not* `better-sqlite3`: no second native addon to rebuild against Electron's ABI alongside `node-pty`. All access via `src/main/dictationStore.ts` |
| Packaging | `electron-builder`, ad-hoc/Developer-ID signed, installed to `/Applications` in dev too | see "Packaging & macOS permissions" below — fixes TCC (Screen Recording/Accessibility) permission flakiness that plagued the raw dev Electron binary |

## Terminal-embedding architecture (supersedes the Claude Agent SDK design)

Clance originally embedded the Claude Agent SDK directly (`src/main/agent.ts`,
now deleted) and rendered a fully custom chat UI — avatars, bubbles, a
`proposeText` SDK tool with an accept/reject card for typing into other
apps. That entire layer was replaced with **embedded terminals running the
real `claude` CLI binary**, the same way VS Code's integrated terminal
works, once it became clear the CLI already does everything the custom UI
was reimplementing (streaming render, slash commands, permission prompts,
tool-call display) — and does it better, since it's Claude Code's own
first-party surface rather than a second implementation of it.

- **`src/main/ptyManager.ts`** owns the pty lifecycle: `createPtySession`
  spawns `pty.spawn(command, args, {...})` directly (never through a shell
  string — `args` is a real argv array, so there's no command-injection
  surface even when `args` carries user- or context-derived text). PATH is
  resolved once via a literal, non-interpolated login-shell echo
  (`$SHELL -ilc "echo -n $PATH"`) and cached, since GUI-launched apps
  inherit launchd's minimal PATH and would otherwise fail to find `claude`
  itself. That resolution can itself be slow — an interactive login shell
  sourcing `.zshrc`/`.zprofile`/nvm/etc., confirmed live to take the better
  part of a minute — so `warmLoginShellPath()` fires it in the background
  at app startup (`index.ts`'s `app.whenReady()`), well before anything's
  actually on the hook waiting for it, e.g. the popup widget's hotkey path.
  **`getLoginShellPath()` is fully async now, with no blocking fallback** —
  it used to fall back to a *synchronous* `execFileSync` the moment
  anything needed the PATH before that background resolution had finished,
  and a widget opened right after app launch did exactly that: the popup's
  pty attach and its background-agent mint (`agentSessions.ts`'s
  `claudeExecOptions`) both call this, and the synchronous call froze the
  entire single-threaded Electron main process — including the local tools
  MCP HTTP server — for however much of that up-to-a-minute shell
  resolution was still outstanding. From the freshly-spawned `claude`
  child process's side, trying to reach the frozen MCP server over HTTP
  during that window looked identical to the connection failures
  documented in "Local tools server" below, and it gave up rather than
  ever getting a response. Every caller now awaits the one in-flight
  resolution (`warmLoginShellPath`/`getLoginShellPath` share it) instead,
  so opening a widget during that startup window is slower — however long
  is left of the login-shell resolution — but never broken.
  **The resolved PATH is now also cached to disk** (`loginShellPath.json`,
  next to `agentPool.ts`'s `pool.json` in the same per-user directory) —
  without this, every single app launch paid the full up-to-a-minute
  interactive-shell cost, since nothing persisted between runs. Now only
  the very first launch ever does; every launch after that has an
  immediately-usable PATH from the cache while `warmLoginShellPath()`
  still re-resolves fresh in the background (unconditionally, every
  launch, not just when the cache is empty) and overwrites the cache once
  that finishes — self-correcting if the real PATH ever changes (a new nvm
  install, say) within one launch cycle, rather than trusting a first-ever
  resolution forever. Every spawned terminal also gets
  `CLAUDE_CODE_AUTO_CONNECT_IDE: "false"` in its env — without it, the CLI
  auto-connects to a running VS Code/JetBrains session and shows whatever
  file that editor happens to have open in its status line, which has
  nothing to do with what Clance's terminal is for.
  - **`--settings` moved to mint time, not attach time** (see
    `docs/background-agent-architecture.md`'s "Bug found post-launch"
    note): now that every pty `createPtySession` spawns is a disposable
    `claude attach <id>` viewport rather than the real conversation
    process, the `--settings` JSON blob — `theme: "light"` (remapping
    xterm's own theme isn't enough on its own, since the CLI emits several
    UI colors — diff add/remove, etc. — as hardcoded truecolor RGB tied to
    its own light/dark theme setting rather than the basic ANSI palette;
    left unset it defaults dark-tuned, which reads poorly against Clance's
    light terminal background) — is built by `agentSessions.ts`'s
    `cliSettingsArgs()` and appended to the `claude --bg [-n <name>]
    [--resume <id>]` mint call instead. `createPtySession` no longer
    touches CLI settings; `attach` accepts no other flags anyway.
- **`src/mainWindow/sections/TerminalSection.js`** and **`src/popup/popup.js`**
  wrap `xterm.js` on the renderer side — theme matches the app's own
  editorial palette (background `#F7F3EB`, accent `#D97757`, full 16-color
  ANSI mapping) rather than a default dark terminal, so it feels native to
  the rest of the app. A `ResizeObserver` keeps `fitAddon.fit()` and the
  pty's real `cols`/`rows` in sync on every resize — without this the CLI's
  own rendering (box-drawing characters, wrapped lines) visibly breaks,
  since it renders for whatever terminal size it was told, not the actual
  xterm.js viewport.
- **File drag-and-drop** (`src/main/dropFiles.ts`, wired into both terminal
  renderers) — a dropped file's path is resolved via `webUtils.getPathForFile`
  in the preload scripts (the renderer's `File#path` was removed in this
  Electron version) and immediately copied into `~/.clance/dropped-files/`
  before its path is pasted into the CLI's input. The copy exists because a
  file dragged from macOS system UI (the floating screenshot thumbnail, most
  notably) is often a `NSFilePromiseProvider` file promise rather than a
  real file — Chromium's HTML5 D&D doesn't implement Apple's
  promise-resolution protocol, so what resolves is `screencaptureui`'s
  transient staging copy, which can be deleted moments after the drop. This
  is a race Clance can narrow by copying early, not one it can eliminate.
  The popup additionally delays its blur-triggered `hide()` by ~500ms
  (`src/main/popupWindow.ts`, cancelled via the `popup:hold-open` IPC
  channel on `dragenter`/`drop`) — starting the OS drag from Finder shifts
  key-window focus to Finder first, which would otherwise blur-hide the
  popup before the drag ever reached it.
- **Fixed: switching/closing tabs no longer kills the session — every
  session is now a background agent.** `PaneLeaf` (`Shell.js`) still only
  ever renders the *active* tab's `TerminalSection`, and its `useEffect`
  cleanup still calls `killTerminal()` unconditionally on unmount — but
  that's inert by construction now, not patched around. Two earlier fix
  attempts at the unmount lifecycle itself (keep every tab mounted +
  CSS-hidden; move the kill call out of unmount into explicit close-only
  sites) were each implemented and reverted. The actual fix, per
  `docs/background-agent-architecture.md`: every Clance-launched
  conversation is minted as a `claude --bg` background agent (a real
  process supervised by the CLI's own daemon) the moment it's opened —
  `Shell.js`'s `openNewChatTab`, `popupWindow.ts`'s `toggleClancePopup`,
  and `agentSessions.ts`'s `resolveOpenArgs` (used by every resume/attach
  path) all mint-then-attach. A tab's pty is purely a `claude attach <id>`
  viewport onto that agent, so `killTerminal()` on unmount only ever kills
  the thin attach client — confirmed live that `SIGTERM` to an `attach`
  process leaves the background agent (a separate pid) running. A new
  explicit "Close" action (Sessions tab's Active rows) maps to `claude
  stop <id>` for when a session should actually end.
- **Sessions are opened, not synced.** There is no more cross-window
  message-syncing IPC (`session:updated` broadcasts, file-watchers) — that
  entire mechanism existed only because two separate custom-UI surfaces
  needed to agree on shared chat state. With every session being an
  independent CLI process, "sync" is meaningless; each terminal is its own
  source of truth, exactly like opening the same session in two real
  terminal windows.
- **Chats tab → terminal tabs, not a chat detail view.** In the main
  window, clicking a chat-history row opens a new terminal tab that
  resumes that session (see attach-vs-resume below); "New Chat" opens a
  fresh one. `src/mainWindow/sections/ChatsSection.js` is now just the
  session list — `ChatDetailSection`, `ToolGroup`, and all transcript
  rendering/collapsing logic were deleted along with the custom chat UI.
- **Attach vs. resume — superseded, every open is now `attach`.**
  `claude --resume <id>` fails if that session is already running as a
  background agent elsewhere — it errors and tells you to use `claude
  attach <id>` instead. Rather than deciding per-open which of
  `--resume`/`attach` to use, `agentSessions.ts`'s `resolveOpenArgs
  (sessionId, name)` now always produces `attach` args: it checks `claude
  agents --json --all` for a known agent id (live or stopped) and attaches
  that, or mints one via `claude --bg --resume <sessionId>` first — see
  `docs/background-agent-architecture.md` for the full background-agent
  design this is part of.
  - **An attached session's terminal size is shared across every client
    attached to it** — the same way a second `tmux`/`screen` client
    attaching to one session shares that session's single size, not a
    Clance concept. `claude attach <id>` connects into the one running
    background-agent process; that process has exactly one terminal size,
    dictated by whichever attached client's resize the CLI most recently
    honored. If two Clance panes both have the same session open this
    way, resizing either one reflows the other's rendering out from under
    it — an accepted, rare tradeoff (see below), not something Clance can
    fix on its own.
  - **`isAttached`'s resize-skip removed — it broke resize for every
    terminal, not just the shared-size edge case above.** This existed
    pre-migration for the rare case of resuming a session already live
    elsewhere: `TerminalSection.js` skipped forwarding resize to the pty
    (from the ResizeObserver, and the post-font-load re-fit) so as not to
    reflow another attached client. `isAttached` was computed as
    `tab.args[0] === "attach"` — harmless while only that rare case used
    `attach`, but once the background-agent migration made *every* session
    attach-based, that expression is true unconditionally, so resize
    forwarding was silently dead for every terminal in the app: an
    ordinary pane resize kept `fitAddon.fit()`'s local xterm.js view
    correct but never told the real pty, so the CLI kept rendering at its
    original size (wrapped at the wrong column, misaligned box-drawing).
    Found via a report that "Open in App" (popup → main window) opened the
    right tab but showed a blank terminal — same root cause: that flow
    reparents an existing pty into a new window without a fresh `attach`
    connection (which is what normally repaints on its own), and relies
    entirely on a forwarded resize to force the CLI to redraw at the new
    size; with forwarding dead, nothing ever repainted it. Fixed by
    removing `isAttached` entirely (prop, computation in `Shell.js`, both
    guards in `TerminalSection.js`) — resize is now always forwarded,
    accepting the rare two-clients-on-one-session reflow tradeoff above in
    exchange for resize actually working the other ~100% of the time.
- **Session titles no longer leak CLI-internal text.** Local slash
  commands (e.g. `/clear`) make the CLI inject synthetic "user" messages
  wrapped in `<local-command-caveat>`/`<command-name>` tags into the
  session JSONL. `chatHistory.ts`'s `isSyntheticLocalCommandText()` filters
  these out when picking a session's display title, so a session doesn't
  show `<local-command-caveat>Caveat: The messages below...` as its name.

## Context injection

**Revisited 2026-09-14: a plain hotkey-open no longer captures or
describes any screen content to the model at all.** Earlier, frontmost
window title and any highlighted selection were captured fresh on every
invocation and folded into prose (`buildContextText()`); now that's gone
entirely for the initial-open path. The model already had on-demand
`look_at_screen`/`read_selection`/`list_open_windows` tools by that point
(see "Local tools server" below), so front-loading a text snapshot on
every single open was redundant with what the model could just ask for
itself when it actually needed to know — and worse, immediately stale the
moment the user's screen changed after the hotkey was pressed. What every
fresh popup session gets instead is a **static system prompt**
(`popupWindow.ts`'s `localToolsSystemPrompt()`) — identical text every
time, telling the model it was just invoked via Clance's popup and that it
has these tools, with a nudge toward *when* to reach for each one
unprompted (bare tool discoverability doesn't need this — every tool's own
MCP description is always visible to the model regardless — but knowing
*when* it's appropriate to act without being asked does). Because this text
no longer depends on anything captured per-invocation, it's identical
whether a session is a genuinely fresh mint or a pool spare claimed from
`agentPool.ts` — see "New sessions and pool spares" below for why that
matters.

**One thing invocation still captures: the frontmost window itself — not
as text, and nothing is handed to the model about it.**
`captureFrontmostWindow()` still runs in `toggleClancePopupInner`, before
the popup steals focus, purely so `frontApp.ts`'s module-level
`capturedWindow` gets set — that's the fallback target
`insert_text`/`click_at`/`activate_app`/`clear_focused_field`/
`replace_focused_field` use when the model doesn't pass an explicit `app`.
Skipping this capture entirely would silently break that default (nothing
to fall back to on a fresh launch, or a stale target left over from
wherever a `Cmd+Shift+R` refresh last ran elsewhere) — it's a distinct,
load-bearing side channel from the prose-building capture that was
removed, not a leftover of it.

**A screenshot is still never part of automatic invocation capture**
(this part predates and is unrelated to the 2026-09-14 change above — see
2026-09-12, `docs/ideas.md`'s "Context capture is one-shot and frozen" for
the earlier state, where it was). The model has `look_at_screen`
(`localToolsServer.ts`) and the user has `Cmd+Shift+R` (below) for an
explicit reload, so paying the capture-and-paste latency (~1.2-1.6s) on
*every* invocation — most of which aren't actually about the screen —
still isn't worth it. Only an explicit refresh ever captures one.

**When a screenshot *is* captured (only ever during a refresh), it rides
in as a real image content block**, via a mechanism confirmed by a live
spike (`docs/sep10talks.md`): the CLI reads image data directly off the OS
clipboard when it sees a paste keystroke — it isn't parsing image bytes
out of the pty stream. So `ptyManager.ts`'s `pasteImageIntoPty()` writes
the screenshot PNG to the clipboard (`clipboard.write([new
ClipboardItem(...)])`), then writes a single `Ctrl+V` byte (`0x16`)
directly into the pty — no keystroke simulation, no `nut-js`, no
bracketed-paste wrapper. `popup.js`'s `triggerContextRefresh()` fires this
once the capture's done, landing the image as a pending attachment in the
input box; the refreshed window-title/selection text follows ~400ms after
as visible unsubmitted input, so it reads like a normal "paste screenshot,
type question" turn once the user hits Enter. **Caveat, unverified:** a
first-run/never-configured `claude` install may have interstitial prompts
(a "Teach auto mode about your environment?" dialog was hit mid-spike)
that could block this path on a fresh machine — not yet checked.

**Refreshing context mid-conversation.** `Cmd+Shift+R` while the popup
terminal has focus (`popup.js`'s `triggerContextRefresh()`, reserved from
the CLI via xterm's `attachCustomKeyEventHandler` — plain `Cmd+R` is
already Electron's default "reload" accelerator and would blow away the
renderer) is the one remaining path that captures a full snapshot
(window title, selection, and a screenshot together) and hands it to the
*live* session instead of spawning anything new: `popupWindow.ts`'s
`refreshContext()` briefly sets the popup's opacity to 0 (so the
screenshot doesn't just capture the widget itself, without hiding it —
hiding hands focus to whatever's "next," which can be Clance's own main
window), captures window title + selection + a screenshot, restores
opacity, and the result rides into the pty as visible unsubmitted
input — image pasted via `pasteImageIntoPty`, text typed as bracketed-paste
input right after (`popup.js`'s `injectContextIntoTerminal()`). Its
opening line (`REFRESH_CONTEXT_PREFIX` in `chatHistory.ts`) is stripped by
the same title-derivation logic that used to also strip the initial-open
prefix, so a refresh triggered before the user's first real submitted
message can't corrupt that session's title.
- **Security:** the frontmost window's title is attacker-influenceable —
  any running app can set its own window title to arbitrary text,
  including terminal escape sequences. `sanitizeForTerminal()` in
  `popupWindow.ts` strips C0/C1 control characters (including ESC) from it
  before interpolation, and `popup.js` sanitizes again defensively right
  before injection — stripping ESC specifically prevents a forged
  `\x1b[201~` paste-terminator from letting attacker-controlled text
  escape the bracketed-paste block early.

**New sessions and pool spares** (`toggleClancePopupInner`,
`popupWindow.ts`): every popup session — whether genuinely minted fresh or
claimed from `agentPool.ts`'s pre-warmed pool — gets the exact same static
system prompt above, baked in invisibly via `--append-system-prompt <text>
--system-prompt-snapshot off`. This wasn't possible before the
2026-09-14 change: back when the prompt carried per-invocation window
title/selection text, a claimed pool spare (already a running process,
minted before "this invocation" existed) couldn't retroactively receive
it, so claimed spares got that context typed visibly into the chat box
instead as a trade-off (decided 2026-09-10). Now that the prompt is
invariant, that trade-off no longer applies — `agentPool.ts` bakes it into
every spare at warm time too (see `popupMintArgs()`), and
`claimPoolSpare()`'s staleness check compares a spare's baked args against
a freshly-recomputed set the same way it already did for `cwd`, so a spare
warmed before Accessibility settled (or before the local tools server's
wiring was ready) gets discarded rather than handed out with broken tool
access — see agentPool.ts's own comments for the bug this specifically
fixed (the very first widget open of a launch always breaking, silently).
The `--system-prompt-snapshot off` flag still matters for more than this
one launch, independent of any of the above — a session's *first* launch
permanently decides whether any *future* `--resume` of it can ever take a
fresh `--append-system-prompt`; with the flag off from birth, that stays
possible (not that anything currently relies on it, since the "Open in…"
dropdown no longer types anything in either — see below).

**Resumed/attached sessions** (opened via the widget's "Open in…"
dropdown): type **nothing** in at all now (changed alongside the
2026-09-14 mint-time change above) — no fresh capture, and no reuse of
whatever the widget last showed. A resumed/attached session already has
its own tools (wired in at whatever point it was originally minted) and
its own conversation history; repeating the generic tool-nudge text on
every tab-switch would just be visible clutter with no new signal (the
MCP tool descriptions are always there regardless). `attach <id>` (a bare
subcommand connecting to an already-running background process) and
`--resume` are treated identically here — neither gets anything typed in.

## Local tools server

Gives a Clance-launched session a set of "computer use" tools — reading
and acting on the user's screen — beyond what the CLI's own `Read`/`Bash`/
`Edit` already cover (those act on the filesystem; these act on the GUI).
Started with just `insert_text` (reintroducing the old SDK-era
`proposeText` capability as a model-called MCP tool instead of app-level
mediation, per requirements.md's "Custom tools" §) and grew into the
fuller set below during a conversation about what else Clance's access to
the screen/keyboard/mouse could usefully expose.

- **Mechanism:** `src/main/localToolsServer.ts` (originally
  `insertTextServer.ts`, renamed once its scope outgrew just one tool) runs
  a local MCP-over-HTTP server (`@modelcontextprotocol/sdk`, session-based
  Streamable HTTP transport — see "five rounds" below for why it isn't
  stateless — `127.0.0.1` + a random port picked fresh per app launch)
  inside Electron's main process. Handlers live in
  `src/main/frontApp.ts`, reusing (and, for the tools added later, sharing
  via two new private helpers — `focusTarget()`, `pasteViaClipboard()`) the
  same keystroke/clipboard-simulation machinery `insert_text` already
  established. `keyboard.type()` (one synthetic keypress per character)
  was tried first for typing and is noticeably slow for anything longer
  than a sentence — every text-delivery tool here pastes instead (write to
  clipboard, simulate Cmd+V, restore the previous clipboard contents
  ~500ms later).
- **Every request and every tool call is logged** (`console.log`/
  `console.error`, visible in the terminal running `npm start`/
  `electron .`) — added after a reported "unable to connect" error on tool
  calls that a health check (a plain `initialize` round trip — see below)
  couldn't reproduce, meaning the connection/auth/handshake layer wasn't
  the problem. The request handler itself is now wrapped in a top-level
  try/catch that guarantees a response on every path: previously, anything
  throwing between accepting the request and `transport.handleRequest()`
  would leave the connection hanging with no response ever sent at all —
  indistinguishable from "the server never responded" on the CLI's side,
  not a clean tool error. `withLogging()` wraps every `registerTool`
  handler individually (start, success/failure, timing), so a hang
  specifically inside one tool's own logic (as opposed to the HTTP layer)
  shows up as a "called" log with no matching "returned"/"threw" after it.
  **Arguments are logged with `text` redacted to a length** (an initial
  version logged raw arguments — `insert_text`/`replace_focused_field`'s
  `text` is arbitrary user content typed into another app, not something
  that should end up in plaintext in a terminal, a log file, or a screen
  recording of one). Return values are never logged at all, redacted or
  not — several (`read_selection`'s text, `look_at_screen`'s image data)
  are exactly the kind of content this shouldn't capture, and knowing a
  call finished never needed the result to debug a hang or an error.
- **What that logging actually found — five rounds, each confirmed live
  against the real `claude` CLI, not guessed:**
  1. A `GET` request hangs forever and breaks the whole session, not just
     one tool call. The Streamable HTTP spec lets a client send `GET` to
     open a long-lived SSE stream for server-initiated messages —
     optional for a server to support, and the original stateless design
     (a fresh `McpServer`/transport pair per HTTP request, no session
     concept at all) architecturally couldn't: a GET's stream had no
     shared state with any later request and no way to ever receive
     anything or close on its own. Handing it to `transport.handleRequest()`
     anyway left it open indefinitely — no response, no error, nothing to
     even log. A live capture caught exactly this: several POSTs each
     logged "request finished", then a `GET` with no matching line before
     the next request came in.
  2. Declining the GET outright (405, spec-legal — a compliant client is
     supposed to gracefully fall back to POST-only) made things *worse*,
     also confirmed live: the real `claude` CLI's MCP client treats a
     declined GET as the whole server being broken and stops attempting
     tool calls to it entirely afterward — no tool-specific `withLogging`
     line ever appeared for the tool the model tried to call next,
     meaning the CLI never even issued that request over HTTP.
  3. Opening a real (if empty) `200 text/event-stream` for GET and ending
     it immediately after one SSE comment line got past the CLI's initial
     "does this server support streaming" check, but confirmed live to be
     a different failure: the CLI's client reconnected the immediately-closed
     GET in a tight, repeating loop, and its own `/plugin` diagnostic panel
     reported "Failed to reconnect to clance-\<key\> (detail withheld on
     this connection)" even while showing the server as connected,
     authenticated, and listing all 8 tools — a real tool call
     (`activate_app`) still failed end-to-end, with no tool-specific
     `withLogging` line, meaning the CLI still never issued the call. Root
     cause: a GET stream is spec-defined to live for the lifetime of one
     MCP *session*, correlated by `Mcp-Session-Id` with the POSTs before
     and after it — with no session concept at all, closing the stream
     immediately just gave the client something to legitimately keep
     retrying forever, since nothing this design did was actually wrong
     per-request, only architecturally incompatible with what the client
     expected a GET to mean. Fixed the session gap by adopting the SDK's
     own reference session pattern: a `sessions` map keyed by
     `Mcp-Session-Id`, one `McpServer`/transport pair created only on an
     `initialize` POST with no session ID yet (via `isInitializeRequest`),
     assigned an ID by the transport itself (`sessionIdGenerator`) and
     registered into the map from `onsessioninitialized`; every later
     request for that session (`GET`, `DELETE`, or a subsequent POST) is
     required to carry that same `Mcp-Session-Id` and is dispatched to the
     *same* transport instance rather than a fresh one. `transport.onclose`
     removes the session from the map and closes its `McpServer`. A
     request with an unrecognized or missing session ID (GET/DELETE), or a
     POST that's neither part of a known session nor a fresh `initialize`,
     gets a `400` with the same `-32000 Bad Request: No valid session ID
     provided` shape the SDK's own reference server returns.
  4. With real sessions in place, GET was changed to actually keep the
     stream open indefinitely instead of closing it — session-scoped now,
     it finally had a real lifetime to last for. Confirmed live to still
     fail, differently again: a real tool call (`activate_app`) completed
     at the HTTP layer with no error (logged "request finished" in single
     digits of ms) yet the CLI reported the tool "couldn't connect", and
     every *subsequent* tool call failed without a matching HTTP request
     ever appearing in this server's logs at all — the CLI stopped trying.
     Reading `@modelcontextprotocol/sdk`'s own client source
     (`client/streamableHttp.js`) rather than guessing further explained
     why: this server never sends a single byte on the GET stream (it has
     no server-initiated messages to push — every tool result already
     rides back on its own POST response), and the client's HTTP stack
     treats a GET stream that goes fully idle as an *unexpected*
     disconnect once its own idle/body timeout elapses. It retries
     reconnecting a bounded number of times and, once exhausted, marks the
     whole session permanently broken — precisely the `/plugin` panel's
     "Failed to reconnect to clance-\<key\> (detail withheld on this
     connection)", and precisely why every tool call after the first
     working one silently stopped reaching this server. The same client
     source also settled what round 2's "made it worse" result actually
     meant: it hard-codes `405` on the GET endpoint as an *expected,
     error-free* outcome ("server does not offer an SSE stream... should
     not trigger an error") and falls back to POST-only silently — round
     2's failure was confounded by having no session concept yet, not by
     405 itself being wrong.
  Landed on declining `GET` with `405` permanently (this server has no
  server-initiated messages to stream, so there's nothing an SSE stream
  would ever carry) while keeping the session machinery from round 3 for
  `POST`/`DELETE` correlation, which those still need regardless of
  whether GET is supported. This avoids the idle-timeout failure mode
  entirely rather than working around it (e.g. with periodic keep-alive
  pings), and is the documented, client-graceful path per the SDK's own
  source.
  5. Even with GET fixed, "unable to connect" kept recurring — but this
     round finally had a smoking gun instead of another guess: `claude
     --debug-file` (the CLI's own full debug logging, confirmed via
     `claude --help`) on the actual failing session showed the tool call
     failing *instantly* — `Tool 'list_open_windows' failed after 0s:
     Unable to connect. Is the computer able to access the url?` — right
     next to `HTTP connection dropped after 56s uptime`. Not a hang, not a
     slow client, not our request routing: Node's `http.Server` defaults
     to a 5-second `keepAliveTimeout`, closing an idle persistent
     connection that quickly on the assumption a client will just
     reconnect for its next request — but the real `claude` CLI's MCP
     client opens one connection per session and expects to reuse it for
     the session's whole lifetime, with no way to know this server ever
     unilaterally closed it out from under it. Any gap longer than 5
     seconds between requests on the same session — i.e. ordinary idle
     time between a user's messages, not a bug in anything — left the
     client writing its next request onto a socket this server had
     already dropped, failing instantly with a connection error that
     looks exactly like "the tool couldn't connect." (This also explains
     why earlier live captures seemed to show a "first widget only"
     pattern: it was never about which widget was first, just whichever
     one happened to sit idle past 5 seconds before its next message —
     circumstantial, not causal.) Fixed by raising both
     `httpServer.keepAliveTimeout` and `httpServer.headersTimeout` (which
     Node requires to exceed `keepAliveTimeout`) to an hour — comfortably
     past any realistic idle gap inside one popup conversation.
- **The full tool list:**
  - `insert_text(text, app?)` — types text wherever focus currently is (a
    clipboard paste, not a click-into-a-field-first action).
  - `list_open_windows()` — lists open window titles, so the model can
    find the right `app` value for any tool below that takes one, instead
    of guessing.
  - `look_at_screen()` — a screenshot, right now, returned as a genuine
    MCP image content block (`{ type: "image", data, mimeType }`) directly
    in the tool result — reuses `screenCapture.ts`'s
    `captureActiveDisplay()`. Simpler than the invocation-time/refresh
    image delivery (see "Context injection" above): those need the
    clipboard + `Ctrl+V`-byte trick because they're injecting into a
    conversation turn that isn't a tool call at all; a real tool call has
    a normal request/response cycle, so the image just rides back as the
    response.
  - `read_selection()` — whatever's highlighted right now, reusing
    `captureSelectedText()` (see "Highlighted-selection capture" below) on
    demand instead of only at invocation/refresh.
  - `activate_app(app)` — focuses a different app by title hint, with no
    typing or clicking, so the model can e.g. "switch to Notes" before
    acting on it.
  - `click_at(x, y)` — clicks on the display nearest the cursor, where `x`
    and `y` are **fractions of that display's width/height (0-1), not
    pixels** — scale-invariant regardless of the resolution a screenshot
    happened to be sent at (`screenCapture.ts` resizes for token cost),
    and avoids needing to communicate a scale factor back and forth. The
    model is expected to eyeball fractional position directly off
    whatever screenshot it just looked at. Deliberately has no `app`
    param of its own (unlike the text tools) — composes with
    `activate_app` instead (bring the right app to front, then click
    relative to the now-frontmost display) rather than every tool
    reimplementing app-redirect.
  - `clear_focused_field(app?)` — Cmd+A then Delete. A blunt "clear
    everything in this field" primitive, not a targeted range — there's no
    generic cross-app way to know a field's exact content or cursor
    position short of the accessibility-tree read this doc has deferred
    since the start (see "Screen context capture" in requirements.md).
  - `replace_focused_field(text, app?)` — Cmd+A then paste, as one atomic
    action rather than requiring two separate tool calls (clear, then
    insert) that could be interrupted or reordered between them.
- **Auth:** the port is random but not secret, so every request is checked
  against a random per-launch bearer token (`crypto.randomBytes`, compared
  with `timingSafeEqual`) passed to the CLI via `--mcp-config`'s `headers`,
  plus a `Host`/`Origin` check against `127.0.0.1:<port>` as defense in
  depth against DNS rebinding — otherwise any other local process (or a
  malicious page in a browser, via DNS rebinding) could hit the endpoint
  and act on whatever app the user last had focused.
- **The `mcpServers` config key is unpredictable per launch, not the
  literal string `"clance"` it used to be** (`popupWindow.ts`'s
  `sessionMcpArgs()`, `serverKey = \`clance-${token.slice(0, 16)}\``,
  reusing the same per-launch random token already generated for auth
  above): that key becomes the "clance" segment of the CLI's
  `mcp__<key>__<tool>` naming convention, which `--allowedTools` (below)
  authorizes purely by name string. A static key is guessable, and Clance
  sessions can now open in real project directories
  (`docs/working-directory-design.md`) — a project's own `.mcp.json`
  defining a same-named server isn't hypothetical. Since `--mcp-config` is
  additive, a colliding project-supplied server could load alongside ours;
  if the CLI's precedence ever let it win the name, the name-based
  allowlist would silently pre-approve calls into that attacker-controlled
  tool instead of ours. Making the key itself unpredictable closes this
  the same way the bearer token already closes the port-guessing case.
- **Why HTTP, not an in-process SDK tool:** the launched session is a real
  `claude` CLI child process (see "Terminal-embedding architecture"), not
  an Agent SDK `query()` call — there's no `query()` left to attach a
  custom SDK tool to. A local-only MCP server is the CLI's own extension
  point for this.
- **Wired in via `--mcp-config`**, additive (not `--strict-mcp-config`), so
  the user's own configured MCP servers still load alongside it — passed to
  every mint of a real `claude --bg` process regardless of entry point
  (`toggleClancePopup`'s brand-new hotkey-opened sessions,
  `agents:spawn-new`'s main-window "New Chat", and `resolveOpenArgs`'s
  revival of a *dormant* session — all three go through `popupWindow.ts`'s
  `sessionMcpArgs()`). Clance's own local tools server is only added to
  that `mcpServers` object when `checkPermissions().accessibility` is
  already true — otherwise the CLI never offers tools that would just
  fail. This is a blanket gate for the *whole* server, including the
  nominally read-only tools (`list_open_windows`, `look_at_screen`,
  `read_selection`) — they don't strictly need Accessibility themselves,
  but there was no reason to special-case them out of the same
  all-or-nothing flag, and doing so would need the CLI to be told about a
  tool set that can change mid-session depending on a permission grant.
  **This gate is scoped to the local tools server only** (2026-09-14) — a
  user's own MCP servers, merged into the same `mcpServers` object from
  `mcpConfig.ts`'s `getActiveMcpServers()`, have nothing to do with
  Accessibility and are never held back by it; `--mcp-config` itself is
  only omitted entirely when *neither* is present (no local tools and no
  user-configured servers).
  - **A session that's already *live* as a background agent can never gain
    tools it wasn't minted with** — same limitation `--system-prompt-
    snapshot` already has (see "Context injection" above): `attach <id>`
    connects to an already-running process and accepts no other flags, so
    there's no way to retroactively add `--mcp-config`/`--allowedTools` to
    one. `resolveOpenArgs`'s "already live" branch (`agentSessions.ts`)
    just attaches as-is; only reviving a *dormant* session goes through a
    genuinely fresh mint (`spawnBackgroundResume`) that can take `mcpArgs`.
    A live session minted before this existed (or from a bare terminal)
    stays without local tools until it's stopped and reopened.
  - **The default target for `insert_text`/`clear_focused_field`/
    `replace_focused_field` (no `app` given) can be stale or empty outside
    the popup hotkey path** — that default falls back to whatever
    `captureFrontmostWindow()` last captured, which only ever happens on a
    hotkey-open; a main-window "New Chat" or a resumed session has no such
    capture at all. Not broken — the model can still pass an explicit
    `app`, and `look_at_screen`/`click_at`/`activate_app`/
    `list_open_windows`/`read_selection` don't depend on a captured window
    to begin with — just a degraded default for those three specifically.
- **Approval tiering via `--allowedTools`, not a Clance-built UI:** only
  the read-only tools (`list_open_windows`, `look_at_screen`,
  `read_selection`) and `click_at` — `localToolsServer.ts`'s `LOCAL_TOOLS`
  tags each of these `tier: "auto"` — end up in `popupWindow.ts`'s
  `sessionMcpArgs()`'s `--allowedTools` list (expanded to the per-launch
  `mcp__<serverKey>__<name>` form above, space-separated per
  `--allowedTools`' own accepted format), so the CLI never prompts for
  them — reading the screen and clicking somewhere already on screen are
  either non-destructive or as low-stakes as a single click, and prompting
  per-click would be exactly the friction-without-safety
  `docs/sep10talks.md` called out as the wrong shape for approval UX.
  Everything else — `insert_text`, `activate_app`,
  `clear_focused_field`/`replace_focused_field` — is deliberately left off
  that list, so the CLI's own native "Allow / Deny / Always allow" prompt
  still gates each of them (the first time per session, or forever if the
  user picks "Always allow"):
  - `clear_focused_field`/`replace_focused_field` are destructive by
    nature (overwrite a field's entire contents).
  - `insert_text` and `activate_app` both accept an `app` hint matched by
    loose substring against *any* open window (see `findWindowByTitleHint`
    below) — auto-allowing either would let the model (or content it read
    via `look_at_screen`/`read_selection` and treated as an instruction)
    autonomously pivot to an unrelated app the user never referenced and
    act there, with no human ever seeing it happen. `click_at` doesn't
    have this problem — it has no `app` param at all, and only ever acts
    on whatever's already the frontmost display. `insert_text` predates
    this whole tool set and was always designed around the CLI's native
    prompt being the actual gate (see "Model-decided, no app-level
    accept/reject" below) — it was never pre-authorized before
    `AUTO_ALLOWED_TOOLS` existed, and isn't now either.
  This resolves `sep10talks.md`'s "genuinely unsolved" approval-UX
  question for this concrete tool set, though a true multi-step
  computer-use agent (many chained clicks toward one risky end state,
  entirely within one already-consented app) may still want something
  more than per-tool-call gating — not designed here.
- **`findWindowByTitleHint` fails closed on an ambiguous match, at *both*
  tiers:** every `app` hint above (loose substring against window titles,
  which are attacker-influenceable — any app can set its own title)
  prefers an exact title match over a substring one, but *both* tiers only
  count as a match if they're the *unique* hit at that tier. Two-or-more
  matches at either tier return no match at all rather than silently
  picking whichever window `getWindows()` happened to list first — a
  spoofing surface otherwise, since a malicious/compromised app could
  title itself to intercept a hint aimed at something else. The
  exact-match tier originally skipped this check (`Array.find` just
  returns the first hit), inconsistent with the substring tier's own
  fail-closed design right next to it — fixed to require uniqueness there
  too.
- **Title comparison and title display share one normalization** —
  `frontApp.ts`'s `normalizeTitle()` (trim + lowercase), used by both
  `findWindowByTitleHint`'s matching and `listOpenWindows`'s output —
  because they didn't originally: `list_open_windows` trimmed titles
  before showing them to the model, but the matcher didn't trim before
  comparing, so a hint the model copied verbatim from that tool's own
  output could fail the exact-match check above over incidental
  whitespace alone and silently fall back to the weaker substring path,
  undermining the point of adding an exact-match preference at all.
- **Model-decided, no app-level accept/reject beyond the above:** the CLI
  calls each tool like any other when it judges it's the right primitive,
  rather than printing text in the terminal or asking the user to click
  something themselves. There is still no Clance-mediated propose/confirm
  step of its own — same principle as before the Agent SDK was removed,
  just moved one layer down (the CLI's own tool-use loop, gated by its own
  permission system where `--allowedTools` doesn't pre-clear it).
- **Per-tool on/off toggle — the Skills & Plugins section's "Custom
  Tools" tab is real now, not the placeholder it used to be**
  (`SkillsSection.js`; backed by `localToolsServer.ts`'s `LOCAL_TOOLS`
  metadata array — the single source of truth both `sessionMcpArgs()`
  and this UI read from, so a new `server.registerTool()` call always has
  a matching toggle entry). This is orthogonal to approval tier: tier
  decides whether an *enabled* tool still needs the CLI's prompt; the
  toggle decides whether it's offered at all. Off means the tool's
  `mcp__<serverKey>__<name>` goes into `--disallowedTools` — the CLI
  refuses it outright, not merely "requires approval" — checked fresh at
  every mint the same way Accessibility already is. Defaults to all
  enabled (`config.ts`'s `enabledLocalTools: "all"`) — these are Clance's
  own first-party tools, not arbitrary third-party skill instructions, so
  there's no "not vetted for this app" concern to opt into. This was the
  first of the Skills & Plugins section's toggles to actually be wired
  into a launched session — the other two (Skills, MCP servers) wrote real
  config that nothing read at launch time back when this shipped (see
  `docs/requirements.md`'s "Config surface" note); MCP servers caught up to
  this 2026-09-14 (`getActiveMcpServers()` now feeds `sessionMcpArgs()` the
  same way), and Skills went read-only instead, since there's no CLI-level
  flag for it to hook into the way this one hooks into
  `--allowedTools`/`--disallowedTools`.
- **Server status + a live health check, in the same "MCP Servers" tab
  the user asked "isn't that a server, shouldn't it be visible there"
  about.** The server itself is invisible infrastructure most of the
  time — it's lazily started (`ensureLocalToolsServer()` only runs the
  first time a real mint actually calls `sessionMcpArgs()`), so
  `getLocalToolsServerStatus()` just reports whether it's running yet
  without starting it, letting Settings show "not started yet" as a
  distinct, non-alarming state rather than looking broken before the
  popup's ever been opened once. `checkLocalToolsServerHealth()` is the
  actual diagnostic: it starts the server if needed, then sends a real
  MCP `initialize` POST to its own `/mcp` URL with the correct bearer
  token — the exact path a launched CLI session uses — and reports
  success/failure plus latency. Not a full protocol client (no session
  handshake beyond that one call), just enough to tell "this server is
  reachable and speaks MCP" apart from "the port's dead" or "auth is
  broken," which narrows down a reported tool failure to this server vs.
  something in how the CLI was configured to reach it.

## Highlighted-selection capture

Lets the model know what text, if any, is highlighted/selected in the
frontmost app, so it can treat it as the focus of a request rather than
requiring the user to re-describe or re-paste it. Two different paths use
this now, not one:

- **On demand, via the `read_selection` MCP tool** (see "Local tools
  server" below) — the normal path since the 2026-09-14 change removed
  automatic invocation capture. The model calls it whenever it actually
  needs to know, reading whatever's selected *at that moment*, not
  whatever was selected when the popup happened to open.
- **On an explicit `Cmd+Shift+R` refresh** (`refreshContext`,
  `popupWindow.ts`) — still captures a selection as part of that full
  snapshot and types it visibly into the terminal (see "Context injection"
  above).

Both go through the same underlying mechanism:

- **Mechanism:** `captureSelectedText()` in `src/main/frontApp.ts` — for
  `read_selection`, called directly at tool-call time; for a refresh,
  called alongside the screenshot/window-title capture, before the popup
  steals focus. There's no generic cross-app "what's selected" OS API short
  of the accessibility-tree read `docs/design.md` still defers, so this
  simulates Cmd+C and reads the result back off the clipboard — the same
  trick `insert_text` uses in reverse (Cmd+V), and the same
  save/restore-the-user's-real-clipboard trade-off. The clipboard is
  cleared to an empty sentinel *before* the simulated copy (rather than
  diffed against whatever was already there), so a no-op copy — nothing was
  selected — reads back empty rather than being confused with a selection
  that happens to match old clipboard contents.
- **Gated on Accessibility**, same permission (and same keystroke-simulation
  mechanism) `insert_text` needs — the local tools server as a whole is
  gated on `checkPermissions().accessibility` (see "Local tools server"
  below), and `refreshContext` reuses the same check for its own capture.
- **Prompting:** when a refresh captures a selection, `buildContextText()`
  in `popupWindow.ts` includes it verbatim (sanitized the same way the
  window title is, and capped at `MAX_SELECTED_TEXT_CHARS` — 4000 — so one
  huge selection can't blow out the context) plus an instruction to treat
  it as the primary subject of the request unless the user's ask is
  clearly about something else. `read_selection`'s tool result carries no
  such instruction of its own — the model called it because it already
  decided the selection mattered, so there's nothing to steer.

## Packaging & macOS permissions

- **The problem:** running via the raw dev Electron binary (`electron .`)
  meant every Clance dev session shared TCC (Screen Recording,
  Accessibility) grants with the generic `com.github.Electron` identity —
  every Electron project on the machine — and lost that grant on every
  rebuild anyway, since the binary's hash changes each time.
- **Fix:** `electron-builder` (package.json `build` config) produces a
  properly signed `Clance.app` with its own stable bundle ID
  (`dev.damiensmith.clance`), signed with a real Developer ID cert already
  present in the dev keychain (ad-hoc signing also works if none is
  available — just a louder first-run Gatekeeper prompt). `npm run
  package`/`npm run dist` run the full pipeline (native module rebuild,
  Electron download, signing).
- **`npm run dev:packaged`** (`scripts/dev-packaged.sh`) is the fast dev
  loop: rebuilds `dist/`, `rsync`s it into the already-packaged app
  (skipping electron-builder's Electron re-download and native-module
  rebuild), re-signs with the same identity, installs to
  `/Applications/Clance.app`, and relaunches. **Installing to
  `/Applications` (not running in place from `release/`) turned out to
  matter**: macOS's TCC permission list is unreliable for an app bundle
  living in an arbitrary dev-repo path, especially one rebuilt repeatedly
  at the same path — moving to a normal install location is what actually
  got the app to register and stay toggleable in Screen Recording
  settings.
- No `--options runtime` (hardened runtime) on the fast resign path —
  hardened runtime requires an entitlements file (JIT, unsigned executable
  memory, disabled library validation for unsigned native `.node` addons
  like `node-pty`) that `electron-builder`'s full pipeline embeds
  automatically but a bare `codesign --sign` doesn't; without it the app
  crashes on launch (`EXC_BREAKPOINT`/`SIGTRAP`). Not needed for local,
  unnotarized use — only matters for real distribution via `npm run dist`.
- **Screen Recording still needs one explicit action to appear as
  toggleable at all.** Unlike camera/mic, Electron has no "request access"
  API for screen recording, and merely checking status
  (`systemPreferences.getMediaAccessStatus`) never registers the app with
  macOS — only an actual capture *attempt* does.
  `requestScreenRecordingAccess()` (`src/main/permissions.ts`) makes a
  throwaway `desktopCapturer.getSources()` call (failure expected/ignored)
  specifically to trigger that registration, then opens System Settings —
  wired to the wizard's "Grant Access" button so it only fires on an
  explicit user press, never automatically.
 
## Shortcut recorder

Global shortcuts are set by pressing the keys, not by typing an accelerator
string. Clicking a shortcut field puts it in a recording state
(`ShortcutsStep.js`), keys are read from `event.code` — `event.key` is
wrong here, since macOS reports Option+G as "©" and Shift+2 as "@" — and
the captured combination is saved immediately.

**Clance's own hotkeys are suspended while recording**
(`setup:set-shortcut-capture` → `unregisterAllHotkeys`, restored on exit).
Without that, pressing the very combination you are trying to rebind fires
the feature instead of reaching the renderer. Suspend/release is balanced
across cancel and save paths.

Validation is stricter than an in-app shortcut would need, because a global
hotkey fires regardless of which app is focused:

- **At least one of ⌘/⌥/⌃.** Without a modifier the hotkey fires on every
  keystroke system-wide — binding `G` would mean pressing g in any app
  triggers Clance instead of typing a letter. Shift doesn't count; ⇧G is
  still just a letter.
- **⌘ alone is not enough.** Plain ⌘+key is the universal shortcut space
  every Mac app uses (⌘C, ⌘V, ⌘S, ⌘Q); taking one globally steals it from
  every app at once. It needs ⌥, ⌃ or ⇧ alongside.
- **Function keys are the exception** to the modifier rule: they produce no
  text, so a bare F5 is safe and is a normal thing to bind.
- **A short OS-reserved list** is rejected with a specific reason: ⌘Tab
  (app switcher), ⌘Space (Spotlight), ⌃⌘Q (lock screen), ⌘⌥⎋ (Force
  Quit).
- **Collisions between Clance's own actions** are caught in the UI, and
  again in `setup:save-shortcuts`.

`isValidAccelerator` in the main process remains the final authority — it
probes by actually registering the accelerator, so anything the OS refuses
surfaces as an error regardless of what the client-side rules allow.

Escape cancels, Backspace/Delete resets to the action's default.

Also fixed here: the previous UI seeded its state from each action's
`defaultAccelerator` rather than the saved config, so it displayed defaults
after a rebind — and saving from that state would have written the defaults
back over the real bindings. It now reads `getPreferences().shortcuts`.

## Popup UI (terminal-based — supersedes the custom chat UI)

The popup no longer renders any chat UI of its own (no avatars, bubbles,
markdown rendering, propose/accept cards) — it's a small chrome window
around an embedded `xterm.js` terminal running the real CLI, per the
"Terminal-embedding architecture" section above. What remains
Clance-specific is the window chrome and which session gets opened:

- **One hotkey, one mode.** There used to be a second hotkey ("Continue a
  Conversation", `togglePopupPicker`/`sessionPicker`) that opened the popup
  into a full-screen searchable session-picker mode instead of a fresh
  conversation. That's gone — `SHORTCUT_ACTIONS` (`src/main/shortcuts.ts`)
  now lists only `togglePopup` ("New Conversation", default `Option+Space`),
  and `PopupShownPayload` (`src/preload/popup.ts`, `src/main/popupWindow.ts`)
  only has `"loading"` and `"new"`. Reaching a past conversation from the
  widget is now an in-widget action instead of a separate way of opening it
  — see "Open in… dropdown" below. The earlier three-mode design
  (`"new"`/`"picker"`/`"resume"`, where `"resume"` preloaded a rendered
  transcript before showing a custom input) no longer applies either way —
  resuming just opens the terminal directly, the CLI renders its own
  history.
- **Open in… dropdown** (`#open-in-btn`/`#open-in-dropdown` in
  `popup.html`, wired up in `popup.js`): a small (220px-wide,
  260px-max-height) anchored dropdown — not a mode swap — toggled by a
  plain toolbar button next to the CLAUDE label. Deliberately modeled on
  `#context-dialog`'s look (same card styling) but click-toggled rather
  than hover-shown, since it needs to stay open while the user types into
  its own search input. Closes on any click outside `#open-in-wrap`
  (a capture-phase `document` click listener), on Escape via nothing
  special — just re-clicking the button or picking a row — and whenever a
  fresh `"loading"`/`"new"` payload arrives (a new hotkey press shouldn't
  leave a stale dropdown open over a different conversation). Picking a
  row calls the same `resolveOpenArgs()` → `openTerminal()` path the old
  picker mode used, but (2026-09-14) with nothing typed into the terminal
  on the way in — no fresh capture, and no reuse of whatever the widget
  last showed. The session being switched to already has its own tools
  (wired in whenever it was originally minted) and its own history, so
  repeating the generic tool-nudge text on every tab-switch would just be
  clutter with no new signal.
- **The window itself always appears instantly, before any of the async
  work behind opening it — and since 2026-09-14, that's true unconditionally
  rather than "as soon as capture finishes."** `toggleClancePopup` used to
  await a context-capture chain (permission check, screenshot,
  simulated-Cmd+C selection capture) before it was safe to reveal the
  window — revealing any earlier would've put the widget itself in its own
  screenshot, or stolen keyboard focus away from whatever app the
  simulated-Cmd+C capture needed it on. Now that a plain hotkey-open
  doesn't do any of that capture (see "Context injection" above — the only
  thing invocation still captures, the frontmost window for
  `insert_text`'s default target, has no such focus/screenshot
  sensitivity), `toggleClancePopupInner` reveals the window right after
  `preparePopupWindow()` finishes, with nothing left to wait on first. Once
  revealed, the window shows a transient `{ mode: "loading" }` payload
  (popup.js renders a plain "Starting…" placeholder in the terminal area),
  and the real `"new"` payload — just the `attach` args now, no context
  preview for this path — follows once the pool claim or fresh mint
  resolves. A module-level `opening` flag on `toggleClancePopup` guards
  against a second hotkey press mid-flight spawning a second background
  agent; a `currentMode` check right before the deferred `sendToPopup()`
  call skips it if the widget was explicitly dismissed while the work was
  still in flight, so it can't pop back up after the user closed it.
- **Visual style:** flat, warm, editorial (`#F7F3EB` background,
  `#D97757` accent) — matches the main window's terminal theme (see
  "Terminal-embedding architecture" above) rather than a default dark
  terminal. `backgroundColor` is used instead of `vibrancy`
  (`src/main/popupWindow.ts`).
- **User-resizable and draggable, like a normal borderless window**
  (`src/main/popupWindow.ts`, `src/popup/popup.html`): it used to size
  itself to fit its content (`#app` at `height: auto` up to a 480px
  `max-height`, a `ResizeObserver` reporting real rendered height to the
  main process via a `resize-request` IPC → `win.setContentSize`). Now the
  window is `resizable: true` with a `minWidth`/`minHeight` floor
  (360×220) and no max — the user drags its edges/corners like any window,
  and `#app` is `height: 100%` so it (and `#session`'s
  `flex: 1 1 auto`) just fills whatever size that ends up being; the
  `ResizeObserver` still exists but only to keep the terminal's
  `fitAddon.fit()`/row-col count in sync as that size changes.
  `frame: false` means there's no native title bar to grab, so `#toolbar`
  is the drag handle instead (`-webkit-app-region: drag`, with its buttons
  opted back out via `no-drag` so they stay clickable) — dragging anywhere
  else (the terminal, the picker list) intentionally doesn't move the
  window, same as a real title bar. `positionNearCursor()` (still used to
  place the widget near wherever you're working when it's first summoned)
  stops running once the user has dragged it themselves — tracked via a
  `move` listener on the window, ignoring the one `move` event that
  listener's own `setPosition()` call generates — so a manual reposition
  sticks instead of being undone the next time the hotkey opens it. No
  "Hit Esc to dismiss" footer or extra bottom padding — the terminal fills
  essentially the whole card.
- **"See context" hover card:** plain text in `#toolbar` (`#context-link`,
  next to "Open in App"), not a button — no border, cursor stays default,
  the only affordance is a color change on hover. Hovering reveals a card
  (`#context-dialog`, 480×560px max, one `overflow-y: auto` scrollbar for
  the whole thing — deliberately not nested per-section scroll areas, to
  avoid mouse-wheel-bubbling ambiguity) showing everything a `Cmd+Shift+R`
  refresh actually captured: the screenshot (an `<img>` loaded via a
  `file://` URL, `encodeURI`'d since a home directory path could contain
  spaces), the frontmost window title, any highlighted-selection text, and
  — labeled "System prompt" — the full text `buildContextText()` produced,
  verbatim. `captureContextText()` returns these as a `contextPreview`
  object (`{ windowTitle, screenshotPath, selectedText, systemPrompt }`,
  the last always present since `buildContextText()` never returns empty)
  alongside the flattened string used for the actual injected text,
  forwarded through `popup-shown` unchanged so the renderer shows them
  directly rather than re-parsing them back out of that string. **A plain
  hotkey-open never sends a `contextPreview` at all** (2026-09-14) — its
  system prompt is static and invariant (see "Context injection" above),
  nothing specific to this invocation to show — so the card's empty state
  covers that alongside `openPopupWithArgs` (pop-out-to-widget), which
  never captured fresh context either. `#context-dialog` sits flush
  against `#context-link` (`margin-top: 0`)
  rather than with a gap — a gap is a dead zone the mouse has to cross in
  a straight line to reach the card, and leaving either element mid-cross
  (easy when aiming for the scrollbar) drops `:hover` and closes it before
  the cursor arrives.
  - **The 560px CSS `max-height` is just an upper cap, not the real
    constraint.** `#app`'s own `overflow: hidden` (needed for the widget's
    rounded corners) clips anything that overflows it — and since `#app`
    always exactly matches the popup window's own size, that clip is
    absolute, not something the dialog's own `overflow-y: auto` can work
    around. In a widget resized shorter than toolbar-height + 560px, the
    dialog's tail always rendered into the clipped-off dead zone no matter
    how far you scrolled *within* the dialog — a fixed geometry problem
    (that content permanently occupies the same page position), not a
    scroll-position bug, so it looked like scrolling was broken. Fixed by
    computing the real available height on every `mouseenter`
    (`window.innerHeight - link.getBoundingClientRect().bottom - 10`) and
    writing it as an inline `max-height` (wins over the CSS rule), capped
    at 560px — the dialog now never renders taller than what's actually
    visible, so its own scrolling genuinely reaches the end.
  - **No per-item "clear this" affordance, on purpose.** Considered and
    rejected: by the time this card is visible, the context has already
    been irreversibly handed to the live `claude` process — for a
    brand-new session, baked into its `--append-system-prompt` startup
    flag — so there's no live channel to retroactively remove a piece from
    a running process. The one flow where it's technically real (a
    resumed/picker session's context is still sitting as *unsubmitted*
    terminal input, genuinely editable) was rejected too, for consistency:
    building it only there, silently no-op-ing everywhere else, would be a
    control that lies about what it does.
- **A real latent race condition, found while testing the picker:**
  `popup.webContents.send("popup-shown", ...)` silently drops the event if
  popup.js hasn't finished loading and attached its listener yet — there's
  no queuing for a missed IPC event. Fixed by tracking a `did-finish-load`
  promise per popup window and awaiting it before every send. Still
  applies under the terminal architecture.
- **A third entry point, from the main window itself:** a terminal tab's
  content area (`TerminalSection.js`) shows a tiny "Open in Widget"
  pop-out button (top-right corner, in the terminal's own padding gutter —
  not the tab bar, to avoid crowding the tab's close button) that closes
  the tab and reopens its session in the popup via a new
  `popup:open-with-args` IPC call → `openPopupWithArgs()`
  (`src/main/popupWindow.ts`), a thin `ensurePopupWindow()` +
  `sendToPopup({ mode: "new", args })` with no screen-context capture (the
  session already exists — there's no
  "just invoked via hotkey" moment to describe). Only shown once the tab
  has real resume/attach args; a brand-new, never-yet-run chat has no
  session id yet to hand the popup, so popping it out would silently
  start an unrelated session rather than continuing this one.
- **Dismissal is always explicit now, never focus-driven:** the widget used
  to hide itself ~500ms after losing OS focus (`createPopup`'s `blur`
  handler in `src/main/popupWindow.ts`), which made it vanish mid-drag or
  whenever another app briefly stole focus — the drag case was specifically
  worked around via a `popup:hold-open` IPC the renderer fired on
  `dragenter`. Both are gone. A persistent `#toolbar` row (always visible,
  above whichever of `#session`/`#picker` is showing — replaces the old
  `#session-header`, which only existed inside the terminal view) carries a
  close button (`popup:close` IPC → `hidePopup()`) as the only way the
  widget goes away on its own initiative.
- **A second, non-destructive way to dismiss it: the toolbar's Hide
  button** (`#hide-btn`, same `#app.has-messages` gating as "Open in App"
  below). Close (`hidePopup()`) always nulls `currentMode`, and
  `cleanupIfAbandoned()` always nulls `currentAgentId` too (stopping the
  agent outright if it never got a real user turn) — the widget is
  supposed to be gone, forgotten by `popupWindow.ts` as much as by the
  user. Hide (`popup:hide` IPC → `hideWidgetKeepAlive()`) leaves both
  untouched, since the window itself is only ever hidden, never reloaded,
  so its terminal is still fully live underneath. `toggleClancePopup()` —
  reached from both the global hotkey and the tray icon — checks for
  exactly that state (`!popup.isVisible() && currentMode === "new"`, no
  `currentAgentId` requirement — see below) before falling through to its
  usual pool-claim/mint path, so the next hotkey press reveals the same
  widget instead of abandoning it for a new one. Loading-state widgets
  aren't offered the Hide button (nothing to keep alive yet, same reason
  "Open in App" is gated the same way), and if it somehow still fires
  mid-mint, `toggleClancePopupInner`'s own `currentMode !== "loading"`
  check goes the other way — `currentMode` never got reset off `"loading"`
  by a bare hide, so the in-flight mint finishes normally and lands in
  the same "hidden but live" state.
  - **Refocuses the previously-frontmost window explicitly, rather than
    reaching for any native app-level hide/show.** A bare
    `BrowserWindow.hide()` leaves Clance itself as the active app, so
    focus just lands wherever macOS defaults to next for it — its own
    main window, if one happens to be open — instead of going back to
    whatever the user was actually doing (the same quirk `refreshContext`
    above works around with `setOpacity(0)` instead of `hide()`). A first
    attempt reached for `app.hide()` (macOS's Cmd+H) to fix that, and it
    does correctly restore the right app on *hide* — but it's a native,
    app-wide deactivation, not a per-window thing, so showing the popup
    again on the next hotkey press reactivates the whole app (the same
    `activate` event a Dock click fires) and pops the main window back
    open right alongside the widget, exactly the "this is supposed to be
    a quiet overlay" bug all over again, just moved to the reveal side.
    `index.ts`'s `app.on("activate", ...)` handler still got hardened
    (`if (BrowserWindow.getAllWindows().length === 0) openMainWindow()`,
    the standard Electron macOS template's own guard) since it was wrong
    on its own terms regardless, but that alone doesn't fix this — the
    real fix is staying off Electron/macOS app-activation machinery
    entirely. `hideWidgetKeepAlive()` now does a plain `popup.hide()` and
    then explicitly calls `focusTarget()` (`frontApp.ts`, exported for
    this — the same targeted, one-specific-external-window activation
    `insert_text`/`activate_app` already use, no notion of "Clance" as an
    app involved at all) to hand focus back to whatever `capturedWindow`
    holds. The reveal path (just below) now also re-runs
    `captureFrontmostWindow()` before showing the popup again, so that
    target stays accurate to wherever the user actually is if they
    switched apps while the widget sat hidden, rather than staying stuck
    on whatever was frontmost back when the widget was first opened.
  - **The reveal check doesn't require `currentAgentId`.** It's tempting
    to read that field as "is there a live session to reveal," but
    `openPopupWithArgs` (the main window's "Open in Widget" button,
    described further down) deliberately never sets it — see its own
    comment. Gating the reveal on it too meant a tab exported to the
    widget would hide fine but never come back on the next hotkey press,
    since `currentAgentId` stayed null the whole time; `currentMode`
    alone is already "new" for every live conversation regardless of how
    it got there, so that's the one to check.
- **A fourth entry point, in reverse — "Open in App":** the toolbar's other
  button (only shown once a session is live, i.e. `#app.has-messages`)
  moves the widget's current conversation into a main window tab and hides
  the widget. Unlike the pop-out-to-widget direction, this doesn't restart
  the CLI process via `--resume` — the session may be mid-response, or (if
  opened fresh via the hotkey) have no resumable id at all yet, since its
  launch args are just the invisible-context flags, not `--resume`.
  Instead the pty itself is reparented: `ptyManager.ts`'s session map now
  stores `{ proc, win }` per terminal instead of a bare `IPty`, and
  `reparentPty(terminalId, win)` swaps which window its `onData`/`onExit`
  forwarders target, so the process (and whatever it was mid-typing) keeps
  running untouched. Flow: popup renderer calls `popup:open-in-app`
  (`{ terminalId, args }`) → `openSessionInMainWindow()`
  (`src/main/mainWindow.ts`) focuses/creates the main window, awaits its
  own `did-finish-load` promise (mirrors `popupReady`), sends
  `open-session-tab` to it, then calls `hidePopup()`. Before sending, it
  also resolves a real tab title: `agentSessions.ts`'s new
  `resolveSessionId(args)` recovers the session id from `--resume`/`attach`
  args (the inverse of that file's existing `resolveOpenArgs`, going
  through the same `claude agents --json` lookup for the `attach` case,
  since that only carries the short agent id) and
  `chatHistory.ts`'s new `titleForSessionId()` reads the session's first
  user message the same way `listSessions()` does, but for one known id
  in Clance's single project bucket rather than scanning every project.
  A freshly hotkey-launched widget session has no `--resume`/`attach` id to
  recover at all — `resolveSessionId` returns null for it — so
  `openSessionInMainWindow` falls back to `chatHistory.ts`'s
  `findRecentClanceSessionId(spawnedAt)`: every `terminalId` embeds its
  pty's own spawn time (`popup-${Date.now()}`, `term-${Date.now()}-<n>`),
  extracted via a `/(\d{10,})/` match, and matched against the birthtime of
  files in Clance's project bucket (the CLI creates the transcript file
  moments after the process starts) to recover the session id without ever
  having been told it. Only falls back to "New Chat" now when there's
  truly no transcript yet — the user opened the popup and hit "Open in
  App" before their first turn landed. Not airtight (two brand-new Clance
  sessions starting within `SPAWN_MATCH_TOLERANCE_MS` of each other could
  be mismatched), but there's no other id to key off before that. The main
  window's
  `Shell.js` listens for that event, calls the new `terminal:reparent` IPC
  (resolves to `reparentPty` keyed off the *calling* window via
  `BrowserWindow.fromWebContents`) before opening the tab, so the handoff
  completes before `TerminalSection` mounts and starts listening for
  `terminal:data`. `TerminalSection` needs no changes — `createTerminal`
  is still called on mount as normal, but `createPtySession`'s existing
  `if (sessions.has(terminalId)) return` guard makes it a no-op since the
  session's already running; the mount's own resize (pane size differs
  from the widget's) reaches the pty regardless and, per the "attach"
  behavior above, prompts the CLI to redraw for the new dimensions —
  relied on here to repaint the conversation rather than replaying
  buffered scrollback, which isn't implemented. The popup side tears down
  its xterm instance without killing the pty (`detachTerminal()`, a
  `teardownTerminal()` sibling that skips `killTerminal`).

## Main window Chats tab (supersedes the "Chat History detail" live-chat design)

The Chats section's session-detail view (`ChatDetailSection`, its
`submit-goal`-style dedicated IPC channel, live-streaming-with-reconciliation,
the collapsible tool/thinking-block renderer) no longer exists — see
"Terminal-embedding architecture" above. Clicking a chat-history row now
just opens an attached terminal tab; there is nothing left to render
custom UI for, since the CLI renders its own history and live output
directly in the embedded terminal.

- **Active/Closed split, plus a Close action** — `ChatsSection.js`'s
  `ChatsListSection` polls `claude agents --json` (via the new
  `agents:list` IPC) every 5s and renders a live **Active** group above
  the existing day-grouped **Closed** history list (filtered to exclude
  whatever's currently live, by matching session id). An Active row's
  Close button calls `agents:stop` (`claude stop <id>`), optimistically
  dropping it from the polled list. The pre-existing Active/Archived
  bookkeeping toggle (see "Session archiving" below) was renamed to
  All/Archived to free up "Active" for this meaning — the two are
  orthogonal, not nested. Full rationale in
  `docs/background-agent-architecture.md`.

## Session archiving

"Clean up sessions" in the Chats tab is archive-only — there is deliberately
no permanent-delete action. Orthogonal to the Active/Closed split below —
see `docs/background-agent-architecture.md`.

- **Why:** `listSessions()`/the Chats tab reads from `~/.claude/projects/**`,
  the real Claude Code CLI's own transcript storage, shared across every
  project on the machine that's ever used Claude Code — not a Clance-owned
  data store. Permanently deleting a `.jsonl` there could destroy a real
  coding session's history from an unrelated project. Archiving sidesteps
  that entirely by never touching the transcript file at all.
- **Mechanism:** `src/main/archivedSessions.ts` keeps a flat JSON array of
  archived session ids at `~/.clance/archived-sessions.json` (same
  read/write-whole-file pattern as `config.ts`). `chatHistory.ts`'s
  `SessionSummary` gained an `archived: boolean` field, populated by
  `listSessions()` from this file; nothing about the id-lookup or
  transcript-reading logic changed.
- **UI:** `ChatsSection.js`'s session rows changed from a single `<button>`
  (whole row navigates) to a `<div onClick>` wrapping a `.session-row-main`
  content block plus a separate `.session-archive-btn` — a real nested
  `<button>` inside a clickable `<button>` isn't valid HTML, and the archive
  action needs its own click target with `stopPropagation()` so it doesn't
  also trigger opening the session. The button is hidden until the row is
  hovered (`.session-row:hover .session-archive-btn`, same pattern as the
  tab bar's `.tab-close`). An "Active"/"Archived" toggle switches
  `ChatsListSection`'s view between the two; archived rows show a
  "Restore" action instead of the archive icon. Archiving is optimistic —
  the row moves out of the current view immediately, without waiting on
  the `chatHistory:set-archived` IPC round trip to resolve. The toggle
  reuses the existing `.segmented`/`.segmented-item` control (Skills tab's
  underline-tab style) rather than a one-off — an initial custom
  `.link-toggle` pill design looked out of place next to it. The "Recent"
  day-group label (`dayGroupLabel()` in `ChatsSection.js`) is suppressed
  specifically — it read as redundant clutter sitting directly under the
  new toggle — while older-day labels ("Yesterday", a date) still render.

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
  the launcher (`src/mainWindow/Shell.js`) is a launcher, not a content
  switcher — clicking a launcher item or a chat-history row opens it as a
  closable tab. Tabs are keyed by a stable `id`
  (`"chats"`/`"skills"`/`"settings"` for the three launcher sections,
  `chat:<filePath>` for an opened conversation). Opening an id that's
  already open either activates the existing tab or opens a duplicate,
  governed by `openTab()`'s `reuseTabs` option (`layoutStore.js`) — always
  `true` in practice (no caller passes `false`). This was previously a
  user-facing "Tab Behavior" Settings toggle backed by
  `~/.clance/config.json`; removed as a configurable preference, so the
  option now just documents intent at the call site rather than being
  wired to anything a user can flip.
- **Launcher lives in a floating top-right cluster, not a left sidebar**
  (supersedes the collapsible left-sidebar launcher above): with only
  three items (Sessions/Skills & Plugins/Settings), a full-height rail
  was mostly empty space that also ate pane width, and a full-width top
  bar just for those three felt like a second, redundant tab-bar-shaped
  row. Instead `.launcher-cluster` (`src/mainWindow/Shell.js`) is a
  small `position: fixed` pill floating over the window's top-right
  corner (icon buttons + the Claude connection status dot) — it doesn't
  reserve a row, so it costs no layout space and doesn't shift when
  panes split. Per-pane tab bars are otherwise unchanged; only the pane
  actually occupying the top-left corner gets `.tab-bar-inset` (left
  padding to clear the `hiddenInset` traffic lights), computed via
  `topLeftLeafId()` walking `node.children[0]` down the tree.
- **A fourth cluster button opens a plain terminal tab, not a `claude`
  session at all** — the user's own login shell (`process.env.SHELL`,
  `-il` for a real interactive-login environment: aliases, PATH, shell
  startup files, same as a fresh `Terminal.app` window), for running
  `claude` themselves, project commands, or anything else alongside
  Clance-launched sessions. `Shell.js`'s `openShellTab()` opens the tab
  synchronously (no background agent to mint first, unlike "New Chat" —
  this pty *is* the actual process), and `TerminalSection`'s `shell` prop
  routes it to a separate `terminal:create-shell` IPC (`index.ts`) instead
  of `terminal:create`'s `command: "claude"` path. Its cwd is the same
  configured default directory a fresh Clance session opens in (see
  `docs/working-directory-design.md`), not the `SESSION_CWD` bucket
  `terminal:create` hardcodes for `claude attach` viewports (irrelevant
  there — the real process already has its own cwd from mint time). No
  "Open in Widget" pop-out for this tab type: there's no `claude` session
  underneath for the widget to resume.
- **Shell terminal tabs survive being switched away from, via a
  module-level registry in `TerminalSection.js`, not by keeping the tab's
  component mounted.** Since a pane only ever renders its `activeTab`
  (`Shell.js`), switching tabs unmounts `TerminalSection` — harmless for a
  `claude attach <id>` tab (the real `claude --bg` process it attaches to
  outlives the disposable client, and `attach` replays its own scrollback
  on reconnect), but fatal for a plain shell tab: that pty *is* the actual
  process, so killing it on unmount ended the session, and xterm's
  scrollback had no replay mechanism of its own to fall back on. Tried
  keeping the whole tab tree mounted and hiding inactive ones with CSS
  first; abandoned — fighting Preact's diffing/resize lifecycle for every
  tab wasn't worth it just to keep one hidden. Instead, `TerminalSection.js`
  now keeps each terminalId's `xterm.Terminal` instance, its DOM node, and
  the registered `onTerminalData` listener alive in a `Map` outside
  Preact's tree entirely; mounting just moves that existing DOM node into
  the visible container (or creates it, and the pty, on first use) and
  unmounting parks it in an off-screen host div rather than disposing it —
  so both the pty and the on-screen scrollback survive a tab switch with no
  hidden, permanently-mounted component tree. Real teardown
  (`destroyTerminal()`: kill the pty, dispose xterm, drop the registry
  entry) only runs from the tab's own ✕ button (`Shell.js`) — the one place
  that actually means "end this session" — never from the component's
  unmount, which is now non-destructive for both tab types. Moving a
  terminal tab to another pane (`MOVE_TAB`/`SPLIT_PANE` in
  `layoutStore.js`) also remounts its `TerminalSection`, so for the same
  reason those no longer re-key the tab's `terminalId` either — the
  registry entry just relocates with it.
- **Shell terminal tabs also survive a renderer refresh, not just a tab
  switch** — a real app relaunch still starts fresh (the pty lives in the
  main process, which does *not* survive that), but a plain reload
  (`Cmd+R`) leaves the main process, and therefore the pty, untouched.
  Two pieces make this work: `layoutStore.js`'s `rehydrateNode` stops
  re-keying `shell: true` tabs' `terminalId` on hydrate (it still re-keys
  `claude attach <id>` tabs — that id is only ever a disposable client,
  the CLI session it attaches to is keyed separately by `tab.args`), so
  the reload's `createShellTerminal` call targets the same id and
  `createPtySession`'s existing "already exists" guard (`ptyManager.ts`)
  turns it into a no-op reattach instead of spawning a new shell. Second,
  since the reload also throws away the renderer-side registry above (and
  with it xterm's own scrollback), `ptyManager.ts` now keeps a capped
  (`OUTPUT_BUFFER_CAP = 200_000` chars) rolling buffer of each session's
  raw output, fetched via `terminal:get-buffer` and replayed into the
  fresh xterm instance before it starts receiving live data (queued and
  flushed in order rather than interleaved — see the buffer-replay
  comment in `TerminalSection.js`). Only actually exercised for shell
  tabs in practice (an agent tab's id is always fresh after reload, so
  there's nothing to reattach to — the buffer fetch for it comes back
  empty and is a no-op), but applied uniformly since `createPtySession`
  can't tell the two apart.
- **Panes (supersedes the single-tab-bar model above):** tabs now live in
  a tree of resizable panes, not one flat tab bar — up to
  `MAX_PANES = 4` at once (product decision: keeps the layout legible and
  the persisted tree small). `src/mainWindow/state/layoutStore.js` owns
  this as a small hand-rolled Redux-shaped store (`getState`/`subscribe`/
  `dispatch` over a pure reducer) rather than pulling in real Redux —
  this app has no bundler and vendors its own dependencies (see "Tech
  stack" above), so a ~250-line local store beat vendoring one more
  library for what's a single piece of local UI state.
  - **Tree shape is deliberately fixed, not arbitrary** (product
    decision, after the tree briefly allowed unrestrained nesting): a
    leaf (`{ tabs, activeTabId }`) or a split
    (`{ direction: "row"|"column", sizes, children }` — always exactly 2
    children). The root may split once, and each of its two halves may
    independently split once more, *perpendicular* to the first split —
    exactly a 2x2 grid, or a 1-and-2 split on either side in either
    direction, and nothing else (no 3-in-a-row, no deeper nesting, no
    same-direction nesting that would just be an uneven way of faking a
    3rd/4th pane). `isValidShape()` enforces this generically: every
    split-producing reducer action computes its candidate tree first and
    this validates the *result* against `depth <= 2` / `children.length
    === 2` / `direction !== parentDirection`, rather than each call site
    trying to avoid producing a bad shape in the first place — `applySplit`
    itself is shape-agnostic, just locates the target and wraps it, and
    lets this reject what doesn't fit. `canSplitAt()` mirrors the same
    check for the UI (`Shell.js`) so a pane's edge zones only render for
    edges that would actually do something, instead of accepting a drop
    that silently no-ops. This naturally caps at 4 leaves total, making
    the separate `MAX_PANES = 4` constant redundant with the shape rule
    in practice — kept anyway as a cheap early-exit before computing a
    candidate tree.
  - **Moving/splitting off a pane's own *only* tab always empties that
    pane out from under the operation** (`removePane`, pre-existing,
    unrelated to the shape rule above) — and collapses its parent split
    too if that leaves it with a single child. This means net pane count
    can only grow by splitting off a tab from a pane that has *other*
    tabs remaining; dragging a single-tab pane's only tab elsewhere is
    net-neutral (moves content, doesn't add a pane), never net-growth —
    surprising the first time you try to build a 2x2 grid by moving
    single-tab panes around and watch the count stay flat instead of
    climbing.
  - **Drag-and-drop is hand-rolled on Pointer Events (`Shell.js`'s
    `startDrag`), not native HTML5 `draggable`/dragstart/dragover/drop/
    dragend.** This is the second design here, not the first — the native
    version worked for exactly one drag and then permanently broke every
    drag after it (confirmed live: an automated Playwright rig driving the
    real packaged app hit the same wall independent of any app-level fix,
    including with `-webkit-app-region` disabled entirely). The
    mechanism, not any particular usage of it, was the problem: a
    cross-pane move unmounts the dragged tab's own DOM node (it leaves
    its old pane) as a direct consequence of the drop applying, and doing
    that while Chromium's native drag-and-drop is still in its OS-level
    nested run loop (`NSDraggingSession` on macOS) is a known way to
    leave that browser-internal drag lock stuck. The pane-divider resize
    two bullets up already worked this way (plain `mousedown`/`mousemove`/
    `mouseup`, no native DnD) and was never implicated — this makes tabs
    consistent with it rather than a special case.
    - `onPointerDown` on a tab calls `setPointerCapture` and starts
      tracking `pointermove`/`pointerup`/`pointercancel` directly on that
      element (plus a window `keydown` listener so Escape cancels).
      Crossing a small threshold (4px) promotes it from "might be a
      click" to an actual drag: only past that point does it flip
      `dragTab` state (mounting the drop-zone overlays) and spawn a
      `.tab-drag-ghost` — a plain `<div>` appended straight to
      `document.body`, positioned via `transform` on every `pointermove`,
      **never through Preact state**. Below the threshold, `pointerup`
      just calls `activateTab` — there's no separate `onClick` on a tab
      anymore, since pointerdown/pointerup already fully own that
      distinction.
    - **Hit-testing during the drag is manual and purely geometric**,
      since there's no `dragover` to lean on — deliberately *not*
      `document.elementFromPoint(x, y)` finding the `.pane-drop-edge`/
      `.pane-drop-edge-outer` overlay divs (an earlier version did this,
      and it raced: those divs only exist once Preact commits the
      re-render triggered by crossing the drag threshold, and a fast
      pointermove could reach the target before that paint landed,
      finding nothing there and silently missing the drop — intermittent,
      confirmed by an automated rig hammering the same drag repeatedly and
      missing a fraction of the time, not by inspection). `hitTest()`
      instead compares the cursor directly against `getBoundingClientRect()`
      of the pane-area and each pane's own `.content` box — elements that
      are unconditionally in the DOM regardless of drag state — via
      `edgeWithinRect()` using the same fractions as the CSS trigger
      strips (`OUTER_FRACTION`/`INNER_FRACTION`, 10%/18%, kept in sync by
      comment). The overlay divs still exist and are still styled by
      plain CSS `:hover`, but purely as the visual affordance now — hit
      accuracy no longer depends on them having painted. A tab-bar hit is
      still checked first, unconditionally — the outer whole-layout edge
      zone spans the entire pane area, which includes the row every
      pane's own tab-bar sits in (and, in a stacked column layout, the
      left/right zone crosses every tab-bar's full width), so without
      that check a drop on a tab-bar inside that band would resolve to
      the outer split instead of just moving the tab into that pane.
    - `splitPane(tabId, fromPaneId, targetPaneId, edge)`'s `targetPaneId`
      can name either a leaf (per-pane split) or a split node itself,
      including the root (whole-layout split) — see `isValidShape`/
      `applySplit` above. Dragging a pane's own tab onto that same pane's
      edge is allowed too (the common single-pane case, splitting it in
      two) — the reducer only blocks the degenerate case of splitting a
      pane using its own *only* tab (would empty it out from under the
      split), and `canSplitAt(root, fromPaneId, tabId, targetPaneId,
      edge)` mirrors that exact check (plus the shape rule) for the UI,
      taking the same drag-context arguments the reducer's action does
      rather than a simplified approximation — so the two can't disagree.
    - **A same-pane collapse can take the drop target's id down with it.**
      An outer/whole-layout split targets the root — but if the dragged
      tab was its pane's only tab *and* that pane was one of the root
      split's own two direct children (the ordinary "2 panes side by
      side, each with one tab" case), removing it collapses the root down
      to just the other child, and the id captured as `targetPaneId`
      (the *old* root, read before the drop was dispatched) no longer
      exists — even though "split the whole layout" still perfectly well
      applies to whatever the layout now consists of. `SPLIT_PANE` (and
      `canSplitAt`, via the same shared `resolveEffectiveTarget()`)
      re-resolves to the new root in exactly this case rather than
      treating the target as gone and silently rejecting the drop.
    - **Hover preview:** hit-testing calls `showPreview()`/`hidePreview()`
      in `Shell.js` directly — a `.pane-preview` div, always mounted but
      `display:none` by default, updated by setting its inline style from
      a ref on every hit-test call. Sized to ~32% of the target (bigger
      than the thin trigger strip itself, so it reads as "this is the new
      pane," not just "you're near an edge").
    - **Nothing above touches Preact state except at drag start/end.**
      Both the tab-bar reorder highlight (`.tab-drop-before`, toggled via
      `classList` directly) and the preview overlay update the DOM
      straight from the pointermove handler; only crossing the drag
      threshold and finishing the drag call `setDragTab`. `dragover`-rate
      events are far too frequent to route through a full pane-tree
      re-render — that would tear down and rebuild every tab's pointer
      listeners on every tick of an active drag, which is exactly the
      kind of churn that was suspected of contributing to the native-DnD
      lockup above, and is pure waste even now that native DnD is gone.
    - Dragging a divider between panes resizes them (`resizeSplit`),
      clamped to a 15% minimum per side — unchanged, see above.
    - **Moving or splitting a terminal tab into a different pane
      regenerates its `terminalId`** (`MOVE_TAB`/`SPLIT_PANE` in
      `layoutStore.js`), the same as a disk-hydrate restore. The tab
      leaving one pane's leaf and landing in another's is itself an
      unmount-then-remount of its `TerminalSection` (Preact has no notion
      of relocating a live subtree to a different parent), so without a
      fresh id the old instance's kill-on-unmount and the new instance's
      create-on-mount would race over the same pty and could leave the
      just-reopened terminal dead. A same-pane reorder never remounts
      (only the active tab renders, and reordering doesn't change which
      tab that is), so it's the one case that keeps the original id.
  - **Persistence:** every dispatch schedules a debounced (400ms) write
    of `{ root, activePaneId }` to `~/.clance/window-layout.json` (new
    `layout:get`/`layout:save` IPC, `src/main/windowLayout.ts`) —
    deliberately a separate file from `config.json`, which holds actual
    settings rather than transient UI state. Restored on `Shell` mount
    via `hydrateFromDisk()`. A pty obviously can't be persisted, so a
    restored terminal tab relaunches with the same `args` it was opened
    with rather than resuming in-process — for a `chat:` tab that's a
    `claude --resume`, so it reopens where the on-disk session left off;
    a bare "New Chat" tab just opens a fresh terminal. Each restored
    terminal tab is assigned a brand-new `terminalId`, since the
    persisted one names a pty from a process that no longer exists.
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
  `StatusCard.js` under `src/mainWindow/components/`.
- **`src/shared/markdown.js` is now orphaned** (no imports anywhere in
  `src/`) — it was the popup/chat-detail markdown renderer for the custom
  chat UI, which no longer exists per "Terminal-embedding architecture"
  above. Left in place rather than deleted as part of this doc pass; worth
  cleaning up as dead code in a future pass (see open questions below).
- Full details are in
  `docs/superpowers/specs/2026-09-06-app-shell-design.md` and
  `docs/superpowers/plans/2026-09-06-app-shell.md`.
- **Chat history browser (sub-project #3):** `src/main/chatHistory.ts`
  walks `~/.claude/projects/*/` directly (no bundled SQLite index) and
  builds session summaries without a full-file parse — title comes from
  the first real `user`-turn line only (synthetic CLI-injected local-command
  messages are filtered out via `isSyntheticLocalCommandText()` — see
  "Terminal-embedding architecture" above), streamed line-by-line, since
  scanning to EOF for the latest Claude-Code-generated `ai-title` isn't
  worth it for real session files that run 7-11MB. Full details in
  `docs/superpowers/specs/2026-09-07-chat-history-design.md` — note that
  spec still describes the since-superseded `ChatDetailSection` UI; the
  data layer (`chatHistory.ts`'s session-listing/parsing) is what's still
  current, the rendering layer it describes is not.
- **Extensibility management UI (sub-project #5) — resolved 2026-09-14,
  differently for Skills vs. MCP servers.** The terminal pivot left a real
  gap here: every session is a real external `claude` process that reads
  `~/.claude/skills/` and its own MCP config independently, with no more
  `agent.ts` `query()` call for Clance's own `enabledSkills`/`mcp.json`
  toggle state to feed into — the Settings toggles wrote real config with
  **no effect on what a Clance-launched terminal session could actually
  use**. Fixed, not left open:
  - **MCP servers** (`src/main/mcpConfig.ts`, `~/.clance/mcp.json`
    wrapping each Claude-Code-`.mcp.json`-shaped entry with a Clance-only
    `enabled` flag): `getActiveMcpServers()` — already written, previously
    never called from anywhere — is now merged into the same
    `--mcp-config` every launch gets for local tools (see
    `popupWindow.ts`'s `sessionMcpArgs()`). The toggle now has the effect
    it always looked like it had.
  - **Skills** (`~/.claude/skills/*/SKILL.md`, previously managed via
    `src/main/skills.ts`'s `enabledSkills`/`setSkillEnabled`): removed
    rather than wired up — `claude --help` confirms there's no per-skill
    enable/disable flag, only `--disable-slash-commands` for all of them
    at once. A toggle with nothing to control is the same trust bug
    either way (looks like it works, doesn't), so the toggle itself is
    gone; the Skills tab is a read-only list now. Managing what's
    available is the same as for a bare `claude` session: add/remove a
    folder under `~/.claude/skills/`.
  - Custom tools, hooks, and subagents remain deferred as before.

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
      build. **Resolved (v1), delivery mechanism revisited twice:**
      screenshot only, of the full display nearest the cursor, captured
      fresh on every popup invocation (`src/main/screenCapture.ts`). Sent
      to Claude as a real image content block via the Agent SDK originally
      (`src/main/agent.ts`, now deleted); after the terminal-embedding
      pivot it was saved to a PNG under `~/.clance/screenshots/` with its
      **path** handed to the CLI as text context, which the model then
      `Read()`s as a normal tool call if relevant; now (`docs/sep10talks.md`'s
      spike) it's a real image content block again, without the SDK —
      clipboard + a `Ctrl+V` byte written into the pty (`ptyManager.ts`'s
      `pasteImageIntoPty()`), landing as a pasted attachment the model sees
      directly, no tool call needed. See "Context injection" above.
      Accessibility-tree read is still deferred.
- [x] How does the app decide "talk back" vs. "type it out" — **superseded,
      question no longer applies.** The model-decided `proposeText`
      accept/reject tool-call flow was removed along with the entire
      custom chat UI (see "Terminal-embedding architecture" above). There
      is no more app-mediated accept/reject step — a launched session
      decides for itself, the same way it decides to call any tool. See
      "Local tools server" below for the reintroduced insertion path
      (`insert_text`, alongside the rest of the computer-use tool set it
      grew into).
- [x] Where does the Anthropic API key/auth live — env var, onboarding
      flow, macOS Keychain? **Resolved, unchanged by the terminal pivot:**
      delegated entirely to the `claude` CLI's own credential store via
      `claude auth login`/`claude auth status --json` (see
      `src/main/claudeAuth.ts`) — Clance never handles a raw API key
      itself. This makes the globally-installed `claude` CLI a required
      dependency; see the Setup Wizard note above.
- [x] Does the popup stay open for multi-turn follow-up in the same
      invocation, or is each hotkey-press a fresh single-turn request?
      **Resolved, mechanism changed:** `Option+Space` always opens a new
      terminal session; the widget's "Open in…" dropdown resumes or
      attaches to an existing one in place, no separate hotkey — multi-turn
      "staying open" is now just however long the user keeps that
      terminal's `claude` process running, the same as any terminal-based
      CLI session, not an app-managed conversation state.
- [x] Which local speech-to-text engine for dictation — **resolved
      2026-09-16: whisper.cpp (`whisper-cli`) running ggml models**, with a
      model catalog Clance recommends from based on detected machine specs
      and installs on demand, and transcript history in an on-disk SQLite
      database (`node:sqlite`, verified working in Electron 44's Node
      24.20 — no native addon, unlike `node-pty`). WhisperKit and Apple's
      `Speech` framework were both considered and rejected for v1; see
      `docs/dictation.md` for the reasoning. Resolving the *UX* half
      dissolved the terminal-input problem rather than solving it:
      dictation is system-wide, pasting into whatever app is frontmost via
      the `insert_text` machinery in `frontApp.ts` that already exists, so
      Clance's own terminals need no special path. **Implemented
      2026-09-16** (Phases 0-2 of `docs/dictation.md`): the Phase 0 spike
      measured `small.en` at 737 ms on this M2 against a 1.5 s bar, with
      greedy decoding plus `--prompt` vocabulary seeding as the shipping
      config, and the feature now ships as a second global shortcut, a
      non-focusable recording HUD, spawn-per-utterance `whisper-cli`, and a
      Dictation tab over a `node:sqlite` history. Hold-to-talk remains out
      of reach without a native key listener (Electron `globalShortcut`
      has no key-up event).
- [x] Exact folder/config conventions for skills, tools, and MCP servers —
      **moot for skills/MCP.** A Clance-launched CLI process reads
      `~/.claude/skills/` and its own project/user `.mcp.json` exactly as
      any other `claude` invocation would — no Clance-specific namespace
      decision needed for those two. **Resolved 2026-09-14:** Clance's own
      `~/.clance/mcp.json` toggle state is now reconciled into what a
      launched session sees — `mcpConfig.ts`'s `getActiveMcpServers()` is
      merged into the same `--mcp-config` every launch already gets for
      local tools (see "Local tools server" above). Skills went the other
      way, deliberately: there's no CLI-level per-skill enable/disable flag
      to hook (`--disable-slash-commands` is all-or-nothing), so
      `enabledSkills`/`setSkillEnabled` were removed rather than left as a
      toggle with nothing to actually control — the Skills tab is read-only
      now, managed the same way a bare `claude` session manages it (add/
      remove a folder under `~/.claude/skills/`).
- [x] How much of the settings UI (enabling/disabling plugins) ships in v1
      vs. "edit the config file yourself for now" — **resolved alongside
      the above:** MCP servers keep their real toggle (now actually wired);
      Skills ships as a read-only list instead of a toggle that silently
      did nothing.
- [ ] `src/shared/markdown.js` is dead code (no imports anywhere) since the
      custom chat UI it rendered for no longer exists — delete, or is
      there a future terminal-adjacent use for it (e.g. rendering
      something outside the terminal itself)?
