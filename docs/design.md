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
| Frontmost-app read (window title, keystroke capture point) | `@nut-tree-fork/nut-js` | still used for capturing the frontmost window's title as context; the SDK-era `proposeText`/keystroke-injection flow this library also supported has been removed along with the custom chat UI |
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
  itself. Every spawned terminal also gets
  `CLAUDE_CODE_AUTO_CONNECT_IDE: "false"` in its env — without it, the CLI
  auto-connects to a running VS Code/JetBrains session and shows whatever
  file that editor happens to have open in its status line, which has
  nothing to do with what Clance's terminal is for. Every `claude` launch
  also gets `--settings '{"theme":"light"}'` appended to its args —
  remapping xterm's own theme isn't enough on its own, since the CLI emits
  several UI colors (diff add/remove, etc.) as hardcoded truecolor RGB tied
  to its own light/dark theme setting rather than the basic ANSI palette;
  left unset it defaults dark-tuned, which reads poorly against Clance's
  light terminal background.
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
- **Attach vs. resume** (`src/main/agentSessions.ts`): `claude --resume
  <id>` fails if that session is already running as a background agent
  elsewhere (`claude --bg` or the CLI's own remote-control mode) — it
  errors and tells you to use `claude attach <id>` instead.
  `resolveOpenArgs(sessionId)` calls `claude agents --json` to check
  whether the target session is a live background agent before deciding
  which args to launch with, so Clance never surfaces that CLI error to
  the user.
  - **An attached session's terminal size is shared across every client
    attached to it** — the same way a second `tmux`/`screen` client
    attaching to one session shares that session's single size, not a
    Clance concept. `claude attach <id>` connects into the one running
    background-agent process; that process has exactly one terminal size,
    dictated by whichever attached client's resize the CLI most recently
    honored. If two Clance panes both have the same session open this
    way, resizing either one reflows the other's rendering out from under
    it. Clance can't fix the CLI's own multiplexing, but stops
    contributing to it: `TerminalSection.js`'s `isAttached` prop (derived
    from `tab.args[0] === "attach"`, computed once in `Shell.js`) skips
    forwarding resize to the pty — from the ResizeObserver, and from the
    post-font-load re-fit — for an attached terminal, sized once at
    creation and left alone after that. `fitAddon.fit()` still runs
    either way, so that pane's own xterm.js viewport keeps looking right
    locally even though the underlying pty no longer tracks it.
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
- **Two hotkeys** (`src/main/shortcuts.ts`), unchanged in shape from the
  earlier design: "New Conversation" (`togglePopup`, `Option+Space`) opens
  mode `"new"`; "Continue a Conversation" (`togglePopupPicker`, default
  `Alt+Shift+Command+Space`) opens mode `"picker"`.
- **Visual style:** flat, warm, editorial (`#F7F3EB` background,
  `#D97757` accent) — matches the main window's terminal theme (see
  "Terminal-embedding architecture" above) rather than a default dark
  terminal. `backgroundColor` is used instead of `vibrancy`
  (`src/main/popupWindow.ts`).
- **Dynamic sizing:** the window isn't a fixed size — `#app` uses
  `height: auto` with a `max-height` (480px), sized by a `ResizeObserver`
  on `#app` reporting real rendered height to the main process
  (`resize-request` IPC → `win.setContentSize(w, h, true)`), reported
  directly in the observer callback rather than batched via
  `requestAnimationFrame` (rAF is throttled while the window is
  hidden/unfocused). No "Hit Esc to dismiss" footer or extra bottom
  padding — the terminal fills essentially the whole card now.
- **A real latent race condition, found while testing the picker:**
  `popup.webContents.send("popup-shown", ...)` silently drops the event if
  popup.js hasn't finished loading and attached its listener yet — there's
  no queuing for a missed IPC event. Fixed by tracking a `did-finish-load`
  promise per popup window and awaiting it before every send. Still
  applies under the terminal architecture.

## Main window Chats tab (supersedes the "Chat History detail" live-chat design)

The Chats section's session-detail view (`ChatDetailSection`, its
`submit-goal`-style dedicated IPC channel, live-streaming-with-reconciliation,
the collapsible tool/thinking-block renderer) no longer exists — see
"Terminal-embedding architecture" above. Clicking a chat-history row now
just opens a resumed/attached terminal tab; there is nothing left to render
custom UI for, since the CLI renders its own history and live output
directly in the embedded terminal.

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
  closable tab. Tabs are keyed by a stable `id`
  (`"chats"`/`"skills"`/`"settings"` for the three launcher sections,
  `chat:<filePath>` for an opened conversation). Opening an id that's
  already open either activates the existing tab or opens a duplicate,
  governed by the `reuseTabs` preference (`~/.clance/config.json`,
  default `true`, editable from Settings' "Tab Behavior" toggle).
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
      is no more app-mediated "type it out" affordance at all — a
      Clance-launched terminal session is just a normal Claude Code
      session; if the user wants text typed somewhere, that happens the
      same way it would in any terminal-based Claude Code session, not
      through app-level injection.
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
