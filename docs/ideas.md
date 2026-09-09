---
title: Ideas
tags: [clance, ideas]
status: draft
---

# Ideas

Brainstormed feature directions for the popup widget — not committed
requirements, just candidates to pull from when picking what's next.

## Context capture is one-shot and frozen

- Context (screenshot, window title, selection) is captured once at
  invocation and baked into the first prompt. If the user switches apps or
  the screen changes mid-conversation, the session never sees it. A
  "refresh context" action — re-run `captureContextText()` and inject the
  result as a new turn into the *same* running session — would make the
  widget track what the user is actually doing instead of photographing
  the moment the hotkey was pressed. Reuses existing capture machinery;
  the new part is injecting into a live session rather than only at launch.
- Screenshot-as-a-path forces the model to spend a tool call just to look,
  even for text-heavy contexts (a terminal, an editor, a browser) where an
  accessibility-tree/OCR text read would be cheaper and let it reason
  immediately.
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

- The only way to hand it a file is dragging it onto the terminal. No
  fetch-a-URL path, and no way to paste a clipboard image directly (only
  a screenshot Clance itself took).

## Session continuity is invisible

- The picker (recent/resumed sessions) is a separate hotkey/mode from
  "new session." A lightweight recent-sessions quick-switcher inside the
  same popup, without a mode switch, would cut down on hotkey
  memorization.

## Highest-value next step

Refresh context on demand — turns the widget from "screenshot at time of
invocation" into something that tracks what the user is actually doing,
and it's the one idea here that reuses existing capture machinery
end-to-end rather than needing new capability.
