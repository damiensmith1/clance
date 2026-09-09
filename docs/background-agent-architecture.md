---
title: Background-Agent Architecture
tags: [clance, design]
status: implemented
---

# Background-Agent Architecture

Implemented (main-window "New Chat"/resume, popup hotkey-new, popup picker
resume, Sessions tab Active/Closed split, Close action). Captures the
decisions from a design conversation, to resume from — not a spec to build
blindly without re-reading the actual code state first.

## Problem

`PaneLeaf` (`Shell.js`) only renders the *active* tab's `TerminalSection`.
Switching tabs unmounts the previous one, whose cleanup calls
`killTerminal()` unconditionally — an actual `SIGTERM` to the real
`node-pty` child process. So switching away from a Clance-launched CLI
session kills it outright, mid-response if one was running. A related
symptom: even when the underlying process survives (see below), the
xterm.js view/scrollback is gone on remount, so switching back shows a
blank terminal until something forces a redraw.

Two earlier fix attempts (keep every tab mounted + CSS `hidden`; move the
kill call out of unmount and into explicit close-only call sites) were
each implemented, then reverted — the first broke rendering (CSS
specificity bug), the second worked but was reverted at the user's request
before being kept, since a bigger architectural option was still on the
table.

## Decision: every Clance session becomes a background agent

Instead of a tab's pty *being* the session, every Clance-launched
conversation becomes a `claude --bg` background agent (a real process,
supervised by the CLI's own daemon — confirmed via
`~/.claude/daemon/roster.json`, `pid`/`ptySock`/`rendezvousSock` per
worker). A tab (main window or widget, any pane) is purely a
`claude attach <id>` viewport onto that agent — disposable, not the
session itself.

This makes the tab-switch bug inert by construction rather than patching
the unmount lifecycle: `killTerminal()` on unmount only ever kills a thin
`attach` client now. The agent is a separate process the tab doesn't own.

Confirmed empirically (see below) that this is also transparently
Remote-Control-compatible — the user tested `/remote-control` against a
live session and it worked. Background agents use the same
socket-rendezvous multiplexing as anything else the daemon supervises, so
there's nothing Clance-specific to build for RC support.

## Functional requirements

1. **New chat** (main window "New Chat", widget hotkey-launched session):
   spawn `claude --bg -n "<name>" ...` first, capture the printed short id,
   then `pty.spawn("claude", ["attach", id])` for the visible terminal.
2. **Resuming a chat-history row**: instead of today's
   `resolveOpenArgs()` (`--resume` for dormant, `attach` only if already
   coincidentally live), always go through a background agent — mint one
   via `claude --bg --resume <sessionId>` if the session has no live/known
   short id, then attach.
3. **Tab switch and tab close (×) no longer end anything.** They only
   ever tear down the local `attach` client pty. This applies uniformly —
   no special-casing needed once every session is background-agent-backed.
4. **New explicit "Close" action**, distinct from the tab-close (×)
   button: maps to `claude stop <id>`. Ends the process, keeps the
   conversation resumable (confirmed empirically — a stopped session's
   short id persists and is revivable, see below).
5. **Sessions tab gets two sections:**
   - **Active** — live, sourced from `claude agents --json` (no `--all`,
     unscoped by `cwd`). Global: doesn't matter whether Clance or the user
     elsewhere (a bare terminal, another machine) created the session —
     if it's running, it shows up and can be opened. Polled periodically.
   - **Closed** — everything else with history but no live process. Two
     sub-cases, same "Open" click either way, different code path:
     - Has a known-but-stopped short id (`claude agents --json --all`,
       entries with no `pid`) → open via `claude attach <id>` on that same
       id (the CLI's own `stop --help` text says this transparently
       restarts it; not independently verified live since `attach` is
       interactive and would hang a non-interactive test — trusted from
       docs, not confirmed).
     - Never had a short id (today's plain JSONL-only sessions, existing
       "Chats" list) → mint one via `claude --bg --resume <sessionId>`,
       then attach to the new id.
6. **"Close" moves a row from Active to Closed** in the UI (it drops out
   of the default `agents --json` listing but persists under `--all`).
7. **Archive is unchanged**, and orthogonal to Active/Closed. Confirmed by
   reading `archivedSessions.ts`/`ChatsSection.js`: it's pure Clance-local
   visibility bookkeeping (a JSON file), never reflects or affects whether
   a process is actually running. Composes with either section.
8. **No delete/`rm` action for now** — stop + archive covers it; a
   stronger `claude rm <id>` (permanently removes the background
   registration + its worktree) is deliberately deferred, not designed.
9. Pass `-n/--name` at `--bg` creation time so sessions are identifiable
   consistently in Clance's own UI, the CLI's own `claude agents` view,
   and anywhere Remote Control surfaces them.

## Explicitly deferred / out of scope for this change

- **Router/concierge ("Option 3" from the design discussion)** — a thin
  AI layer that decides which agent a hotkey-press should route to,
  sitting on top of this same background-agent foundation. Discussed at
  length, deliberately not part of this change; this foundation should
  work the same whether or not that ever gets built.
- Worktree-per-session (background agents can optionally be
  worktree-scoped — noticed in the daemon roster's own data, not
  something this change addresses).

## Implementation notes

- **`src/main/agentSessions.ts`** is the single choke point. `listAgents({
  all? })` wraps `claude agents --json[--all]`. `spawnBackgroundAgent(name,
  claudeArgs)` runs `claude --bg -n <name> [claudeArgs]` and parses the id
  off stdout's first line (`backgrounded · <id> · <name>`, ANSI-escaped
  even when piped — stripped before parsing). `resolveOpenArgs(sessionId,
  name)` is the one function every "open a chat-history row" call site
  goes through (main window, popup picker): it collapses the design's two
  Closed-section sub-cases into one lookup — `--all` already includes
  stopped-but-known agents (no `pid`), and `attach` transparently restarts
  those, so there's nothing to branch on beyond "is there a known id at
  all"; if not, `claude --bg --resume <sessionId>` mints one.
- **Every launch site now mints-then-attaches**: `Shell.js`'s
  `openNewChatTab` (main window "New Chat"), `popupWindow.ts`'s
  `toggleClancePopup` (hotkey-new, context flags go straight into the
  `--bg` launch instead of a raw `claude` invocation), and both pickers
  via `resolveOpenArgs`.
- **Bug found post-launch: `--settings` (theme + notification
  suppression) silently stopped reaching the real agent.**
  `ptyManager.ts`/`createPtySession` used to build the `--settings <json>`
  blob and append it to whatever `claude` command it spawned — that was
  correct when the pty *was* the real conversation process, but after this
  change every pty it spawns is just a disposable `claude attach <id>`
  viewport, and `attach` silently ignores extra flags (confirmed live:
  prints "extra arguments ignored", no error). The actual long-running
  process — minted separately via `claude --bg` in `agentSessions.ts` —
  never saw the flag at all, so `preferredNotifChannel:
  notifications_disabled` (and `theme: light`) stopped taking effect for
  every session, surfacing as the desktop-notifications-off setting being
  ignored (osascript/"Script Editor" notifications firing regardless).
  Fixed by moving `cliSettingsArgs()` into `agentSessions.ts` and applying
  it at mint time (`spawnBackgroundAgent`/`spawnBackgroundResume`, i.e.
  the actual `--bg [--resume]` call) instead of at attach time;
  `createPtySession` no longer touches CLI settings at all. **Consequence
  worth knowing**: since an agent only picks up settings at its own mint
  time, changing the desktop-notifications toggle no longer affects
  already-running background agents — only sessions minted after the
  change. Same category of one-way-at-birth decision as
  `--system-prompt-snapshot` above; not fixed, just noted.
- **Same audit turned up two more instances of the identical class of
  bug** — anything the old pty spawn (the real process, pre-migration)
  used to get, that a mint call now needs instead, since `agentSessions.ts`
  is where every real `claude` process originates now:
  - **No resolved login-shell `PATH`.** `ptyManager.ts` resolves one via a
    login-shell `$PATH` echo specifically because a GUI-launched Electron
    app inherits launchd's minimal `PATH` (confirmed live: `claude` isn't
    found on a bare `/usr/bin:/bin:/usr/sbin:/sbin` `PATH`, and
    `execFileAsync` doesn't do a shell lookup). Every mint/list/stop call
    in `agentSessions.ts` was missing this — would have thrown `ENOENT` on
    every single one in the packaged app. Fixed by exporting
    `getLoginShellPath()` from `ptyManager.ts` and reusing it (module-level
    cache is shared, so this doesn't re-resolve twice).
  - **No `cwd: SESSION_CWD`.** Every mint call ran under Electron's own
    process cwd instead of `~/.clance` — the fixed bucket the rest of the
    app (`chatHistory.ts`) assumes every Clance session lands under.
    Confirmed live: a mint without this fix landed in whatever the calling
    process's cwd happened to be; with it, it correctly landed in
    `~/.claude/projects/-Users-<user>--clance/`.
  - Both fixed via one `claudeExecOptions()` helper (also sets
    `CLAUDE_CODE_AUTO_CONNECT_IDE: "false"`, matching the pty spawn's own
    reasoning) applied to all four `execFileAsync("claude", ...)` calls in
    `agentSessions.ts`.
  - **Not part of this migration, but the identical pattern**:
    `claudeAuth.ts`'s `checkClaudeAuth`/`connectClaude`/`disconnectClaude`
    also shell out to `claude` with no resolved `PATH`. Pre-existing, not
    touched here — flagged for a separate look.
- **Known remaining gap: minting failures are silent.** Before this
  change, a launch failure surfaced inside the terminal itself (the real
  process's own pty would exit/error visibly). Now, if a mint call throws
  (auth issue, `claude` not found, etc.), `openNewChatTab`/`openChatTab` in
  `Shell.js` just rejects with no tab ever opening and no UI feedback —
  there's no toast/error-surface component in the app to route it to.
  Worth deciding on before shipping, not fixed here.
- **Tab-switch/close needed no code change.** `killTerminal`'s unmount
  call was always "kill whatever pty this terminal owns" — once every pty
  *is* an `attach` client rather than a full `claude` invocation, that
  call is inert by construction, exactly as designed. Confirmed live:
  `SIGTERM` to a `claude attach <id>` process leaves the background agent
  (a different pid) running.
- **"Close" action** lives on the Sessions tab's Active rows only (not
  duplicated onto the terminal tab itself) — `ChatsSection.js`'s
  `ActiveList`, calling `agents:stop` → `claude stop <id>`, optimistic
  removal from the polled Active list.
- **Sessions tab naming collision, resolved**: the existing
  Active/Archived segmented toggle (Clance-local archive bookkeeping, see
  "Session archiving" in `design.md`) collided with this feature's
  "Active" (live process). Renamed that toggle's non-archived option to
  "All"; within it, the list renders an **Active** group (from
  `agents:list`, polled every 5s) followed by a **Closed** group (existing
  day-grouped history, filtered to exclude whatever's currently live by
  matching `sessionId`). The Archived view doesn't get its own
  Active/Closed split — archiving a currently-live session is an
  unaddressed edge case, not handled specially.

## Open questions — resolved during implementation

- **Latency**: measured ~0.6s for `claude --bg` to return and print an id
  (`time claude --bg -n ... '<prompt>'`) — small enough that no loading
  state was added around the mint-then-attach step.
- **Does `attach` redraw/replay the current screen on reconnect?** Not
  independently re-verified beyond the CLI-level probe above (which
  showed a full repaint on attach); worth a real Clance-UI check since
  that's the actual "blank until refresh" fix.
- **cwd-scoping**: confirmed `claude agents --json` (no `--cwd`) lists
  live sessions regardless of the calling shell's cwd — ran it from `/tmp`
  and it still listed a session started under the project dir.
- **`--bg --resume` on an already-live session**: per `--bg --resume`'s
  own help text, starts a copy under a new id rather than erroring; not
  independently forced live, but `resolveOpenArgs` never hits this path
  for a session it already found live via `--all`.

## Open questions still outstanding

- **Full set of `status`/`state` values.** Only observed `status: "busy"`/
  `"idle"` and `state: "working"`/`"blocked"`/`"done"` so far. Relevant to
  any future "blockers at a glance" view on the Active section — not
  scoped now, but don't build that view without checking what states
  actually exist.
- **Shared-terminal-size behavior** when multiple `attach` clients (two
  Clance panes, or Clance + Remote Control) connect to the same agent at
  once — already a known quirk for today's rare resumed-into-live-agent
  case (see `design.md`'s `isAttached` notes); becomes the norm now that
  every session works this way. Not addressed by this change.
- **Long-lived survival**: whether background agents survive Clance
  quitting, sleep, or a full reboot — the daemon supervisor is a separate
  process from Clance's own Electron process, but its own lifecycle
  (launchd-managed? survives logout?) wasn't checked.
- **Now run through the real app and two more real bugs found**:
  - **`isAttached`'s resize-skip broke resize for every terminal, not just
    its intended rare case** — surfaced as "Open in App" opening the right
    tab but showing a blank terminal. Full account and fix in
    `design.md`'s "Attach vs. resume" section.
  - **Sessions tab Active rows showed the generic mint-time name
    ("Clance popup") forever**, not the real conversation topic. Fixed:
    `ChatsSection.js` now prefers the same first-user-message title
    `chatHistory.ts` already derives for the Closed list (matched by
    `sessionId` against the already-fetched history, no extra IPC call),
    falling back to the mint-time name only until a real transcript title
    exists.
- **A reported "notification setting doesn't work" — real bug, root
  cause found and fixed, after two wrong turns.**
  - First wrong turn: assumed it was the CLI's own turn-complete
    notification and re-verified `preferredNotifChannel` was being
    applied (it was — a `d(e,...)` switch statement in the compiled
    binary returns a no-op for `"disabled"`).
  - Second wrong turn: found a real, separate, **hardcoded** `osascript
    -e 'display notification "Your Claude assistant needs
    re-authentication"'` call in the daemon's own OAuth-refresh logic,
    which ignores `preferredNotifChannel` entirely, and reproduced it
    live. This turned out to be real but *not* what was actually being
    reported — `claude auth status --json` showed `loggedIn: true`
    throughout, so this is very likely transient noise from the heavy
    concurrent `--bg` spawn/stop/rm churn this debugging session itself
    generated, not something end users hit in normal use. Still
    unfixed/unfixable from Clance (the call site checks no setting at
    all) — flagged separately, low priority.
  - **The actual cause, found from a user screenshot**: a real macOS
    notification properly branded "Claude Code" (not "Script Editor"),
    with body text quoting the model's own answer verbatim ("You're
    watching **The Mentalist**, Season 2..."). Not a system-level
    completion beep — model-initiated. The CLI ships a first-party
    `PushNotification` tool ("send a desktop notification ... and, when
    Remote Control is connected, also push to their phone") that the
    model can call proactively with arbitrary content, independent of
    `preferredNotifChannel`. Confirmed via a live repro: a session minted
    with `preferredNotifChannel: notifications_disabled` and explicitly
    asked to use the tool still had access to it. The fix is
    `--disallowedTools PushNotification` (verified live: the model then
    replies "I don't have a PushNotification tool available") — the
    only lever that actually reaches this specific tool. Wired into
    `agentSessions.ts`'s `cliSettingsArgs()`, gated on the same
    `desktopNotifications` toggle as `preferredNotifChannel` (off →
    both suppressed; on → both available, so an opted-in user still
    gets the mobile-push behavior if they've set up Remote Control).
    **Kept — real and verified — but turned out not to be the (only)
    culprit**, see below.
  - **Still happening after that fix; root cause narrowed further, not
    fully solved.** A follow-up report ("You're welcome!" as a
    notification body, after a plain "thanks") had no `PushNotification`
    tool_use anywhere in that session's transcript — so a second,
    distinct mechanism exists. Also corrected a misreading: the
    "Claude Code"-branded notification is still delivered via
    `com.apple.ScriptEditor2` under the hood (confirmed via `log show
    --predicate 'process == "usernoted"'`, which showed the same
    `app:"com.apple.ScriptEditor2"` as every other notification here) —
    "Claude Code" was just a custom title string passed to `osascript`,
    not a distinct branded app identity as first assumed.
    - **The actual trigger, isolated via a controlled A/B**: minting a
      session and simply waiting for it to finish — never notifies.
      Minting, then `claude attach <id>`-ing to it (even one already
      done) — reliably notifies, every time, regardless of
      `preferredNotifChannel`, `--disallowedTools`, or any `--settings`
      key tried. So it's the **`attach` client itself**, not the
      background worker, generating this — consistent with `attach`
      taking no settings overrides at all (confirmed earlier: extra
      flags are silently ignored).
    - **Seven suppression attempts tried, all failed identically**: (1)
      per-agent `--settings` at mint time — doesn't reach `attach`, as
      established. (2) a Clance-owned project-scoped settings file at
      `~/.clance/.claude/settings.local.json` (every Clance `attach` runs
      with that cwd, so this should be read via ordinary project-settings
      resolution) — tested live, notification still fired. (3)
      `remoteControlAtStartup: false` in `--settings` at mint time (a
      real settings key — `"Start Remote Control bridge automatically
      each session"` — chased after finding a binary string implying an
      org/GB-level auto-enable default exists) — looked promising in an
      isolated no-attach test (zero notification activity logged) but
      failed once an actual attach was added to the test. (4)-(7) several
      env vars set specifically on the `attach` client's own process env
      in `ptyManager.ts` (`CLAUDE_CODE_ENABLE_AWAY_SUMMARY`,
      `CLAUDE_CODE_FORCE_RC_LONG_TURN_NUDGE`,
      `CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK` variants, chosen
      because their names describe exactly this kind of
      reconnect-and-catch-up notification) — none changed the outcome.
    - **Not fixed.** The evidence points at `attach` having some built-in
      "catch you up" notification behavior with no exposed, working
      override — but this is now past what can be responsibly diagnosed
      by guessing at an undocumented, obfuscated-name env var surface
      (hundreds of `CLAUDE_CODE_*` vars exist in the binary, most with
      opaque codenames). Recommended next step: report this upstream as
      CLI feedback (a background agent minted with notifications
      explicitly disabled still notifies on `attach`) rather than
      continuing to guess from Clance's side.
