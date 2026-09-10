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
| Screenshot capture | Electron `desktopCapturer` | resized to Claude's recommended max edge (1568px), saved to a PNG under `~/.clance/screenshots/`, path handed to the CLI as context — never sent as raw bytes to the app itself |
| Terminal embedding | `node-pty` (real pty process) + `xterm.js` + `@xterm/addon-fit` | vendored (not CDN-loaded) under `src/shared/vendor/xterm/`; `node-pty` is a native addon, requires `electron-rebuild`/`@electron/rebuild` against Electron's Node ABI |
| AI / reasoning / session UI | The real `claude` CLI binary, run as a child pty process | superseded the Claude Agent SDK — see "Terminal-embedding architecture" below |
| Frontmost-app read (window title, keystroke injection) | `@nut-tree-fork/nut-js` | captures the frontmost window's title as context and backs `insert_text` (see "Text-insertion tool" below) — the SDK-era `proposeText` accept/reject *UI* is gone with the custom chat UI, but the underlying keystroke-injection capability is back, now surfaced as an MCP tool the CLI decides to call itself |
| Text-insertion tool transport | `@modelcontextprotocol/sdk` (Streamable HTTP, stateless) | local-only MCP server run inside Electron's main process — see "Text-insertion tool (`insert_text`)" below |
| Session storage | JSONL files under `~/.claude/projects/...`, written entirely by the CLI itself | Clance no longer writes session files — every session is a real CLI process, so this is the CLI's own format, not something Clance needs to keep byte-compatible with by hand |
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
  sourcing `.zshrc`/`.zprofile`/nvm/etc. — so `warmLoginShellPath()` (the
  same lookup via non-blocking `execFile` instead of `getLoginShellPath()`'s
  blocking `execFileSync`) is fired once at app startup (`index.ts`'s
  `app.whenReady()`) to get it cached well before anything's actually on the
  hook waiting for it, e.g. the popup widget's hotkey path. Every spawned
  terminal also gets
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

Screen context (frontmost window title + a saved screenshot path) is built
fresh on every popup invocation (`popupWindow.ts`'s `buildContextText()`),
but **how** it reaches the CLI differs by whether the session is new or
resumed — this split exists because of a real CLI limitation, confirmed by
direct testing outside Electron:

- **New sessions:** context rides in invisibly via
  `--append-system-prompt <text> --system-prompt-snapshot off`. The
  `--system-prompt-snapshot off` flag matters for more than this one
  launch — a session's *first* launch permanently decides whether any
  *future* `--resume` of it can ever take a fresh `--append-system-prompt`.
  With the flag off from birth, a later resume of that same session (e.g.
  via the picker) can still receive new context; without it (the CLI's
  default, and the state of every session that predates this feature —
  including ones started from a bare terminal), the CLI silently ignores
  any `--append-system-prompt` on resume, and even flags it as a
  suspicious injection attempt in its own reasoning. This is not
  fixable via CLI flags on the resume side — it's decided permanently at
  a session's original launch.
- **Resumed/attached sessions** (the picker widget): since most existing
  sessions were never launched with the snapshot flag off, invisible
  injection can't be relied on for them. Instead, context is **typed into
  the terminal as visible, unsubmitted input** once the session is ready —
  wrapped in a bracketed-paste escape sequence (`\x1b[200~...\x1b[201~`)
  so the CLI's multi-line input treats embedded newlines as literal text
  rather than submitting partway through, left unsubmitted so the user can
  extend it before pressing Enter themselves.
  - **Security:** the frontmost window's title is attacker-influenceable —
    any running app can set its own window title to arbitrary text,
    including terminal escape sequences. `sanitizeForTerminal()` in
    `popupWindow.ts` strips C0/C1 control characters (including ESC) from
    it before interpolation, and `popup.js` sanitizes again defensively
    right before injection — stripping ESC specifically prevents a forged
    `\x1b[201~` paste-terminator from letting attacker-controlled text
    escape the paste block early.
  - `attach <id>` (a bare subcommand connecting to an already-running
    background process, no other flags accepted) gets the same visible
    typed-context treatment as `--resume` — there's no meaningful
    difference from the injection site's perspective once the terminal is
    open.

## Text-insertion tool (`insert_text`)

Reintroduces the ability for a Clance-launched session to write text into
another app — the old model-decided `proposeText`/accept-reject flow was
removed with the custom chat UI (see "Terminal-embedding architecture"), but
per requirements.md's "Custom tools" §, this kind of "type primitive" was
always meant to come back as an MCP tool the CLI process calls itself, not
as app-level mediation.

- **Mechanism:** `src/main/insertTextServer.ts` runs a local
  MCP-over-HTTP server (`@modelcontextprotocol/sdk`, stateless Streamable
  HTTP transport, `127.0.0.1` + a random port picked fresh per app launch)
  inside Electron's main process, exposing two tools: `insert_text(text,
  app?)` and `list_open_windows()`. The handler calls
  `typeIntoCapturedWindow()` in `src/main/frontApp.ts` (previously dead
  code, written in anticipation of exactly this), which refocuses the
  window captured by `captureFrontmostWindow()` right before the popup
  stole focus, then delivers the text via a clipboard paste (write to
  clipboard, simulate Cmd+V via `@nut-tree-fork/nut-js`, restore the
  previous clipboard contents ~500ms later) rather than simulating each
  keystroke — `keyboard.type()` was tried first but is noticeably slow for
  anything longer than a sentence, since it sends one synthetic keypress
  per character.
- **Redirecting to a different app than the one captured at invocation**
  (e.g. "put this in Slack" while looking at something else — previously a
  dead end, `insert_text` could only ever target the window captured at
  hotkey-press): `insert_text` takes an optional `app` string, a
  case-insensitive substring matched against open window titles via
  `getWindows()` (`findWindowByTitleHint()` in `frontApp.ts`); when it
  matches, that window is focused instead of the captured one. `list_open_
  windows` exposes `getWindows()`'s titles as its own tool so the CLI can
  see what's actually running (and what its title looks like) before
  picking an `app` value, rather than guessing. Read-only, so it isn't
  gated on Accessibility the way typing is — though in practice it's only
  ever useful alongside `insert_text`, which already requires it.
- **Auth:** the port is random but not secret, so every request is checked
  against a random per-launch bearer token (`crypto.randomBytes`, compared
  with `timingSafeEqual`) passed to the CLI via `--mcp-config`'s `headers`,
  plus a `Host`/`Origin` check against `127.0.0.1:<port>` as defense in
  depth against DNS rebinding — otherwise any other local process (or a
  malicious page in a browser, via DNS rebinding) could hit the endpoint
  and type into whatever app the user last had focused.
- **Why HTTP, not an in-process SDK tool:** the launched session is a real
  `claude` CLI child process (see "Terminal-embedding architecture"), not
  an Agent SDK `query()` call — there's no `query()` left to attach a
  custom SDK tool to. A local-only MCP server is the CLI's own extension
  point for this.
- **Wired in via `--mcp-config`**, additive (not `--strict-mcp-config`), so
  the user's own configured MCP servers still load alongside it — only for
  `toggleClancePopup`'s brand-new hotkey-opened sessions
  (`popupWindow.ts`'s `insertTextMcpArgs()`), and only when
  `checkPermissions().accessibility` is already true; otherwise the flag is
  omitted entirely so the CLI never offers a tool that would just fail.
  Resumed/attached/picker sessions don't get it — there's no freshly
  captured frontmost window for those to type back into.
- **Model-decided, no app-level accept/reject:** the CLI calls the tool
  like any other tool when it judges the user wants text written into the
  app they were just using, rather than printed in the terminal. There is
  still no Clance-mediated propose/confirm step — same principle as before
  the Agent SDK was removed, just moved one layer down (CLI's own tool-use
  loop instead of Clance's).

## Highlighted-selection capture

Lets a hotkey-opened popup session know what text, if any, was
highlighted/selected in the frontmost app at invocation time, and steers the
model to treat it as the focus of the request rather than requiring the
user to re-describe or re-paste it. Wired into both hotkeys —
`toggleClancePopup` (Option+Space) and `togglePopupPicker`
(Option+Shift+Cmd+Space) — since both go through the same
`captureContextText()`.

- **Mechanism:** `captureSelectedText()` in `src/main/frontApp.ts` runs
  alongside `captureFrontmostWindow()`/the screenshot capture, before the
  popup steals focus. There's no generic cross-app "what's selected" OS API
  short of the accessibility-tree read `docs/design.md` still defers, so
  this simulates Cmd+C and reads the result back off the clipboard — the
  same trick `insert_text` uses in reverse (Cmd+V), and the same
  save/restore-the-user's-real-clipboard trade-off. The clipboard is
  cleared to an empty sentinel *before* the simulated copy (rather than
  diffed against whatever was already there), so a no-op copy — nothing was
  selected — reads back empty rather than being confused with a selection
  that happens to match old clipboard contents.
- **Gated on Accessibility**, same permission (and same keystroke-simulation
  mechanism) `insert_text` needs — `popupWindow.ts`'s `toggleClancePopup`
  reuses the same `checkPermissions().accessibility` check for both rather
  than checking twice.
- **Both hotkeys, one delivery difference:** `captureContextText()`'s
  `captureSelection` param is `true` for both `toggleClancePopup` and
  `togglePopupPicker` (each gated on its own `checkPermissions().accessibility`
  check). What differs is how the resulting text reaches the CLI — invisibly
  via `--append-system-prompt` for a brand-new session, or typed into the
  terminal as visible input for a resumed one (see "Context injection"
  above) — not whether the selection gets captured at all. `insert_text`
  itself is still new-session-only (no MCP server wiring for resumed
  sessions), which is unrelated: capturing a selection is just a keystroke
  simulation, same Accessibility gate, no MCP config needed.
- **Prompting:** when a selection was captured, `buildContextText()` in
  `popupWindow.ts` includes it verbatim (sanitized the same way the window
  title is, and capped at `MAX_SELECTED_TEXT_CHARS` — 4000 — so one huge
  selection can't blow out every invocation's context) plus an instruction
  to treat it as the primary subject of the request unless the user's ask
  is clearly about something else.

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
 
## Popup UI (terminal-based — supersedes the custom chat UI)

The popup no longer renders any chat UI of its own (no avatars, bubbles,
markdown rendering, propose/accept cards) — it's a small chrome window
around an embedded `xterm.js` terminal running the real CLI, per the
"Terminal-embedding architecture" section above. What remains
Clance-specific is the window chrome and which session gets opened:

- **Two modes**, chosen by the `popup-shown` IPC payload's `mode` field
  (`src/preload/popup.ts`, `src/main/popupWindow.ts`): `"new"` (opens a
  fresh `claude` terminal, screen context injected invisibly — see
  "Context injection" above) and `"picker"` (a searchable session list;
  picking a row opens a terminal that resumes or attaches to that session,
  with context typed visibly into the terminal input instead). The earlier
  three-mode design (`"new"`/`"picker"`/`"resume"`, where `"resume"`
  preloaded a rendered transcript before showing a custom input) no longer
  applies — resuming just opens the terminal directly, the CLI renders its
  own history.
- **The window itself always appears instantly, before any of the async
  work behind either mode.** `toggleClancePopup`/`togglePopupPicker` used
  to await the whole context-capture chain (permission check, screenshot,
  simulated-Cmd+C selection capture) — and, for `"new"`, minting a real
  `claude --bg` background agent on top of that — before ever calling
  `popup.show()`, so the hotkey press produced no visible feedback at all
  until that entire chain finished (occasionally a couple of seconds).
  Fixed by splitting window-show (`ensurePopupWindow()`) from payload-send
  (`sendToPopup()`): the window now shows immediately with a transient
  `{ mode: "loading" }` payload (popup.js renders a plain "Starting…"
  placeholder in the terminal area), and the real `"new"`/`"picker"`
  payload — with the actual `attach`/`--resume` args and context preview —
  follows once that async work resolves. A module-level `opening` flag on
  `toggleClancePopup` guards against a second hotkey press mid-flight
  spawning a second background agent; a `currentMode` check right before
  each deferred `sendToPopup()` call skips it if the widget was explicitly
  dismissed (or, for the picker, reused for the other mode) while the work
  was still in flight, so it can't pop back up after the user closed it.
  Within that async work, `insertTextMcpArgs()` (its slow part —
  `ensureInsertTextServer()` — only matters for the CLI flags, not for the
  accessibility boolean context capture needs, which `checkPermissions()`
  itself answers synchronously) and `captureContextText()` now run
  concurrently rather than the latter waiting on the former, since neither
  actually depends on the other's result. `spawnBackgroundAgent()` still
  has to wait for `captureContextText()`'s result specifically — the
  captured context is baked into `--append-system-prompt` at spawn time, so
  the CLI process can't be started before it's known without giving up the
  invisible-injection design (see "Context injection" above) — that
  remaining serialization is the next thing to look at if this isn't enough
  (see `warmLoginShellPath()` below for one piece of it that *was*
  removable).
- **Two hotkeys** (`src/main/shortcuts.ts`), unchanged in shape from the
  earlier design: "New Conversation" (`togglePopup`, `Option+Space`) opens
  mode `"new"`; "Continue a Conversation" (`togglePopupPicker`, default
  `Alt+Shift+Command+Space`) opens mode `"picker"`.
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
  avoid mouse-wheel-bubbling ambiguity) showing everything that was
  actually captured and handed to the CLI at invocation: the screenshot
  (an `<img>` loaded via a `file://` URL, `encodeURI`'d since a home
  directory path could contain spaces), the frontmost window title, any
  highlighted-selection text, and — labeled "System prompt" — the full
  text `buildContextText()` produced, verbatim. `captureContextText()`
  returns these as a `contextPreview` object (`{ windowTitle,
  screenshotPath, selectedText, systemPrompt }`, the last always present
  since `buildContextText()` never returns empty) alongside the flattened
  string used for the actual launch args, forwarded through `popup-shown`
  unchanged so the renderer shows them directly rather than re-parsing
  them back out of that string. `openPopupWithArgs` (pop-out-to-widget)
  never captures fresh context, so `contextPreview` is `undefined` there
  (not just empty fields) — the card shows an empty-state message instead.
  `#context-dialog` sits flush against `#context-link` (`margin-top: 0`)
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
- **Extensibility management UI (sub-project #5) — config layer still
  live, but no longer wired to anything Clance itself runs.** The Skills &
  Plugins section still manages `~/.claude/skills/*/SKILL.md` (via
  `src/main/skills.ts`) and `~/.clance/mcp.json` (via
  `src/main/mcpConfig.ts`, wrapping each Claude-Code-`.mcp.json`-shaped
  entry with a Clance-only `enabled` flag) as real, working config
  surfaces. What changed: there is no more `agent.ts` `query()` call for
  this config to feed into — every session is a real external `claude`
  process that reads `~/.claude/skills/` and its own MCP config
  independently of Clance's `enabledSkills`/`mcp.json` toggle state. The
  toggles in Settings currently have **no effect on what a Clance-launched
  terminal session can actually use** — this is a real gap introduced by
  the terminal pivot, not a design choice, and needs a decision on
  whether/how to reconcile it (see open questions below). Custom tools,
  hooks, and subagents remain deferred as before.

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
      build. **Resolved (v1), superseded once by delivery mechanism:**
      screenshot only, of the full display nearest the cursor, captured
      fresh on every popup invocation (`src/main/screenCapture.ts`). Was
      originally sent to Claude as an image content block via the Agent
      SDK (`src/main/agent.ts`, now deleted); now saved to a PNG under
      `~/.clance/screenshots/` and its **path** is handed to the CLI as
      text context (invisibly via `--append-system-prompt` for new
      sessions, or typed into the terminal for resumed ones — see "Context
      injection" above), which then `Read`s it as a normal tool call if
      relevant. Accessibility-tree read is still deferred.
- [x] How does the app decide "talk back" vs. "type it out" — **superseded,
      question no longer applies.** The model-decided `proposeText`
      accept/reject tool-call flow was removed along with the entire
      custom chat UI (see "Terminal-embedding architecture" above). There
      is no more app-mediated accept/reject step — a launched session
      decides for itself, the same way it decides to call any tool. See
      "Text-insertion tool (`insert_text`)" below for the reintroduced
      insertion path.
- [x] Where does the Anthropic API key/auth live — env var, onboarding
      flow, macOS Keychain? **Resolved, unchanged by the terminal pivot:**
      delegated entirely to the `claude` CLI's own credential store via
      `claude auth login`/`claude auth status --json` (see
      `src/main/claudeAuth.ts`) — Clance never handles a raw API key
      itself. This makes the globally-installed `claude` CLI a required
      dependency; see the Setup Wizard note above.
- [x] Does the popup stay open for multi-turn follow-up in the same
      invocation, or is each hotkey-press a fresh single-turn request?
      **Resolved, mechanism changed:** every hotkey-open is a new terminal
      session (`Option+Space`) or a resumed/attached one
      (`Alt+Shift+Command+Space` → picker) — multi-turn "staying open" is
      now just however long the user keeps that terminal's `claude`
      process running, the same as any terminal-based CLI session, not an
      app-managed conversation state.
- [ ] Which local speech-to-text engine for dictation — **not yet
      implemented at all**, terminal pivot didn't address this; still an
      open requirements-level question (see `docs/requirements.md`
      §"Dictation" — that requirement predates the CLI embedding and its
      UX under a terminal-input model hasn't been thought through)
- [ ] Exact folder/config conventions for skills, tools, and MCP servers —
      **partially moot for skills/MCP now.** A Clance-launched CLI process
      reads `~/.claude/skills/` and its own project/user `.mcp.json`
      exactly as any other `claude` invocation would — no Clance-specific
      namespace decision needed for those two. What's now genuinely open:
      whether Clance's own `enabledSkills`/`~/.clance/mcp.json` toggle
      state (Settings UI) should be reconciled into what a launched
      session actually sees (e.g. via `--strict-mcp-config` +
      `--mcp-config`, or per-launch env/flags), left as a UI that edits
      config nothing currently reads, or removed/repurposed. See the
      Extensibility management UI note above.
- [ ] How much of the settings UI (enabling/disabling plugins) ships in v1
      vs. "edit the config file yourself for now" — same underlying gap as
      above: the toggle UI exists and writes real config, but nothing
      currently reads `enabledSkills`/`mcp.json`'s `enabled` flags when
      launching a terminal session
- [ ] `src/shared/markdown.js` is dead code (no imports anywhere) since the
      custom chat UI it rendered for no longer exists — delete, or is
      there a future terminal-adjacent use for it (e.g. rendering
      something outside the terminal itself)?
