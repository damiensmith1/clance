---
title: Background
tags: [clance, background]
status: draft
---

# Background

## What Clance is

Clance is a macOS menu-bar app (Apple Silicon) that puts a Claude-powered
agent one hotkey away from anywhere on the system. Press the hotkey, type or
speak a goal in natural language, and the app reads whatever's currently on
screen as context, then either types/acts on your behalf in the focused app
or just talks back in a popup — powered by the [[Claude Agent SDK]].

The core loop:

**Hotkey → Popup (type goal) → Read screen → Think → Respond (type it out,
or talk back) → Logged**

It is explicitly **not** an ambient/always-watching assistant. The screen is
only read on-demand, at the moment of invocation — never in the background.

## Why this exists

- Most OS-level AI assistants either require a fixed menu of canned actions
  ("Rewrite", "Summarize") or are ambient/always-on, which trades away
  privacy and predictability. Clance is meant to sit in between: on-demand,
  open-ended, and local-first.
- Existing agent tooling (the Claude Agent SDK, Claude Code CLI) already
  solves reasoning, tool use, and session management well. The app's job is
  to be a thin OS-integration shell around that — screen capture, text
  injection, hotkey/tray presence — not to reinvent agent loops.
- Session-format compatibility with the Claude Code CLI is a deliberate
  choice: a session started via the hotkey popup should be resumable from a
  terminal (`claude --resume <id>`), and vice versa, so the two surfaces feel
  like one continuous workspace rather than two separate products.

## Core principles

- **Local-first.** Everything runs on the user's machine — session storage,
  history, config, extensions. The only network call is the request to
  Claude's API itself. No telemetry, no cloud sync, no external servers
  required to use the app.
- **Pluggable by design.** The app is a thin shell around the Claude Agent
  SDK's own extensibility primitives (skills, tools, MCP servers, hooks,
  subagents), not a closed feature set. The community should be able to
  extend what it can do without forking the core app.

## Prior art / reference points

- Spotlight-style popup UX (hotkey → small floating input) is the interaction
  model to emulate for activation, not full window management.
- Claude Code CLI's session JSONL format, skills (`SKILL.md`) convention,
  subagent format, and MCP config shape are the reuse targets throughout —
  see `docs/requirements.md` §4.5 and §4.8 for where this compatibility
  matters concretely.

## Source document

The original product-vision writeup lives in the Obsidian vault at
`Projects/Clance/Clance - Claude at a Glance.md` (symlinked into this repo's
docs as reference material during initial planning). This doc set
(`docs/background.md`, `docs/requirements.md`, `docs/design.md`) is the
canonical, git-tracked source going forward — the vault note is not updated
automatically as these evolve.
