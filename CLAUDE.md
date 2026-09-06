# Clance

A macOS menu-bar app (Apple Silicon, Electron + Node.js) that opens a
hotkey-triggered popup, reads the current screen for context, and uses the
Claude Agent SDK to either respond conversationally or type/act on the
user's behalf. Sessions are stored in a Claude Code CLI-compatible JSONL
format so they're resumable from either surface. Local-first, pluggable via
the Claude Agent SDK's own skills/tools/MCP/hooks/subagents primitives.

See `docs/` for the full requirements, background, and design — that's the
source of truth for scope, architecture, and open questions, not this file.

## Keeping docs in sync

Everything under docs/ is this project's source of truth, not a one-time
snapshot — including any file added there after initial setup, not just
background.md/requirements.md/design.md. In the SAME turn as a code
change (not a followup), update the relevant doc when you:
- resolve or add an open question in design.md
- make or change an architecture/approach decision
- add, change, or drop a requirement or non-goal
- learn something that changes the "why" in background.md
- create a new doc under docs/ for a topic that doesn't fit the above

Don't fabricate a decision that wasn't actually made. If it's unclear
whether something is doc-worthy, ask instead of guessing.
