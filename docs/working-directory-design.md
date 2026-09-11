---
title: Session working directory design
tags: [clance, design]
status: implemented
---

# Session working directory design

## Problem

Every Clance-launched session runs with `cwd: SESSION_CWD` (`~/.clance`,
see `src/main/paths.ts`) — hardcoded, unconditional, regardless of what the
user is actually working on. This was a deliberate simplification early on
(see `design.md`'s resolved open question on project-path bucketing), but
it means a Clance session can *talk about* whatever's on screen (via the
screenshot/context injection) without being able to *act* on it: `Read`/
`Edit`/`Bash` with a relative path resolve against `~/.clance`, not the
repo the user is actually looking at; CLAUDE.md auto-discovery walks up
from `~/.clance` and never finds the repo's own CLAUDE.md; any `git`
command the model runs operates on a non-repo directory instead of the
user's actual one.

This doc covers: why the fix isn't just "always use the right directory"
(there's no reliable way to know it in every case), what Claude Code
already gives us for free, and specifically how it interacts with the
background-agent pool (`src/main/agentPool.ts`).

## What Claude Code already tracks for us

Checked a real transcript directly rather than assuming: every real
`"user"` entry in a session's JSONL carries a `cwd` field —

```
4 user -> cwd: /Users/damiensmith/Documents
5 user -> cwd: /Users/damiensmith/Documents
```

— for *any* session, Clance-created or not. That means **resuming an
existing session never needs a picker, a guess, or any Clance-side
bookkeeping at all** — just read that field off the transcript (a scan in
the same shape `firstUserTitle` in `chatHistory.ts` already does) and pass
it as `cwd` for the `--resume`/`attach` spawn call. This replaces an
earlier, more complicated idea (Clance recording its own
`{agentId, sessionId, cwd}` map at mint time) — unnecessary once we're just
reading what the CLI already recorded.

The only case with genuinely no prior directory to read is a **brand-new**
session — no transcript exists yet, so there's nothing to look up. That's
the one case that needs either a picker or a remembered default.

## The three ways a session can open, and what each does

1. **Hotkey → new widget (`Option+Space`).** Always opens at the
   *configured default directory* — a new Settings field, falling back to
   `~/.clance` if the user never sets one. No picker at this point; this is
   the fast, instant-reflex path and has to stay that way. This is the
   only flow the background-agent pool (below) can ever help with.
2. **"Open in…" → an existing session.** Not a mint — `--resume`/`attach`
   inheriting that session's own recorded `cwd` straight from its
   transcript, per above. No picker, no pool interaction, no change to
   speed (already fast via `resolveOpenArgs`).
3. **"Open in…" → a new session in a chosen directory.** A directory
   picker (recent directories + browse) in the same dropdown, minting a
   fresh session at whatever directory the user picks. Always a plain,
   un-pooled mint — deliberately: the directory wasn't knowable until the
   user picked it, so there was nothing to pre-warm. This is the same
   accepted trade-off as the "start a real session" affordance discussed
   for Quick Ask — slower because it's an explicit, considered action, not
   the reflex path. Not worth building per-directory mini-pools for; that's
   real scope creep for a case that already opted into being deliberate.

Settings also gets a **default directory** field — this is what flow #1
falls back to when set, instead of `~/.clance`. Changing it is the one
place that touches the pool (next section).

## Interaction with the background-agent pool

`agentPool.ts` pre-warms a spare `claude --bg` process so the hotkey path
(flow #1) can skip mint latency by claiming it instead of minting fresh.
The spare's `cwd` is baked into the OS process at spawn time — immutable
once running — which is exactly why the pool can only ever help flow #1:
it's the *only* directory Clance knows about before any user action
happens at all. Flows #2 and #3 either don't mint (#2) or mint at a
directory that's unknowable in advance (#3), so neither can be pre-warmed
by construction, not as a missed optimization.

**Concretely:**

- Pool spares are always minted at the *current* configured default
  directory (Settings field, or `~/.clance`).
- `pool.json`'s entries need to carry the `cwd` a spare was minted with,
  not just its id — `{ id, cwd }` instead of a bare id list.
- **Changing the default directory in Settings must invalidate the current
  spare.** A spare minted under the old default, claimed after the setting
  changes, would silently put a "new" conversation in the wrong directory.
  Two layers, not one:
  1. *Primary:* the moment the setting is saved, discard the current
     spare(s) and trigger a fresh `refillPool()` under the new default.
  2. *Safety net:* `claimPoolSpare()` checks the stored `cwd` against the
     currently-configured default before handing a spare back; a mismatch
     (in case step 1 was ever missed — app crash between save and refill,
     etc.) is treated as an empty pool — falls back to a fresh mint at the
     correct directory, and the stale spare gets discarded in the
     background rather than claimed.
- Pool size stays at 1 — nothing about directory-awareness changes that
  reasoning (single hotkey, single user, can't fire two default-opens at
  once; see `agentPool.ts`'s existing comment).
- The claimed-spare context trade-off (visible-typed context instead of
  invisible `--append-system-prompt`, since a pre-warmed spare exists
  before there's any context to bake in) is unrelated to and unaffected by
  any of this — still applies exactly as before, regardless of which
  directory the spare or fresh mint uses.

## Implementation punch list — all done

- [x] Settings: default-directory field (persisted in `config.json`
      alongside `shortcuts`/`enabledSkills` — `config.ts`'s
      `getDefaultDirectory`)
- [x] `cwd` threaded through as a real parameter everywhere `SESSION_CWD`
      was hardcoded for session *creation* — `SESSION_CWD` itself stays as
      the pseudo-project bucket for pure-default/no-project sessions, just
      isn't unconditional anymore
- [x] Resume/attach path reads `cwd` off the target session's transcript
      (`chatHistory.ts`'s `cwdForSessionId`, same shape as `firstUserTitle`)
      instead of `SESSION_CWD`
- [x] `agentPool.ts`'s `pool.json` entries are `{ id, cwd }`; discard +
      refill on Settings default-directory change; claim-time cwd check as
      the safety net (`PoolSpare` type, `claimPoolSpare`)
- [x] "Open in…" dropdown has the "new session in…" directory picker
      (recent dirs + browse) alongside the existing resume-an-existing-
      session list
- [x] No changes needed to `listSessions()`/the Chats tab history browser,
      as predicted — only session *creation* was ever scoped to one fixed
      bucket
- [x] Went further than originally scoped here: the main window's own
      "New Session" button (Sessions page) got the same directory-picker
      dropdown as the widget's "Open in…", not just the popup path.
