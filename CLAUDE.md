# Clance

A macOS menu-bar app (Apple Silicon, Electron + TypeScript) that opens the
real Claude Code CLI in a floating terminal from a global hotkey. Every
session is a `claude --bg` background agent that Clance attaches to, so
sessions are ordinary Claude Code sessions, resumable from either surface.
Clance adds local MCP "computer use" tools (screenshot, selection, typing,
clicking), a main window for all Claude Code sessions on the machine, and
system-wide on-device dictation (whisper.cpp).

See `docs/` for background, requirements and design — that's the source of
truth for scope, architecture, and open questions, not this file.

## Keeping docs in sync

Everything under docs/ is this project's source of truth, not a one-time
snapshot. Docs describe the current system only — no dated changelogs,
reverted attempts or bug-hunt narratives; that history belongs in git. In
the SAME turn as a code change (not a followup), update the relevant doc
when you:
- resolve or add an open question in design.md
- make or change an architecture/approach decision
- add, change, or drop a requirement or non-goal
- learn something that changes the "why" in background.md

Don't fabricate a decision that wasn't actually made. If it's unclear
whether something is doc-worthy, ask instead of guessing.
