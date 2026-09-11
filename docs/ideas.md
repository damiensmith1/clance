---
title: Ideas
tags: [clance, ideas]
status: draft
---

# Ideas

Brainstormed feature directions for the popup widget — not committed
requirements, just candidates to pull from when picking what's next.

## Context capture is one-shot and frozen

- ~~Context (screenshot, window title, selection) is captured once at
  invocation and baked into the first prompt, never seeing a later app
  switch or screen change.~~ Done — `Cmd+Shift+R` while the popup terminal
  has focus re-runs the capture chain and injects the result into the
  *same* running session (`popupWindow.ts`'s `refreshContext()`,
  `popup.js`'s `triggerContextRefresh()`; see `docs/design.md`'s "Context
  injection" § "Refreshing context mid-conversation").
- ~~Screenshot-as-a-path forces the model to spend a tool call just to
  look.~~ Done — the screenshot now rides in as a real image content block
  (clipboard + `Ctrl+V` byte into the pty, see `docs/design.md`'s "Context
  injection"), no tool call needed. An accessibility-tree/OCR text read for
  text-heavy contexts (terminal, editor, browser) is still a separate,
  unimplemented idea — text read vs. image read is a different trade-off
  (cheaper reasoning vs. losing genuine visual layout), not one this
  supersedes.
- Only the one frontmost window is captured. No way to grab clipboard
  history or a couple of recently-used app titles for "compare X and Y"
  style asks.

## No persistent "watch mode"

- Every invocation is stateless-until-resumed via the picker. A
  pinned/always-on-top mode that stays attached to one session and
  re-triggers on hotkey — instead of opening a picker or a new session —
  would suit "keep asking follow-ups about this one file while I work."

## Output primitives are narrow — text only

- No path for structured output beyond typed prose: paste-as-markdown-
  table, paste-as-code-block, or an explicit "copy to clipboard" action
  distinct from typing into the app. Sometimes the destination isn't the
  app that was frontmost at all.

## Attachments beyond drag-and-drop

- ~~No way to paste a clipboard image directly (only a screenshot Clance
  itself took).~~ Already works as-is — confirmed 2026-09-11: pasting an
  image copied from elsewhere (a browser, Preview, Slack) into the popup
  terminal reaches the CLI as a real image, same as Clance's own
  screenshot paste, with no extra Clance-side wiring needed.
- Fetch-a-URL: deliberately not building Clance-side handling for this —
  the CLI's own web-fetch tool already covers it, no need for Clance to
  duplicate that capability.

## Session continuity is invisible

- The picker (recent/resumed sessions) is a separate hotkey/mode from
  "new session." A lightweight recent-sessions quick-switcher inside the
  same popup, without a mode switch, would cut down on hotkey
  memorization.

## Highest-value next step

~~Refresh context on demand~~ — done, see "Context capture is one-shot and
frozen" above. Remaining candidates, no particular ranking yet: watch mode,
structured output primitives, or the in-popup session quick-switcher.
