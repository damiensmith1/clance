---
title: Background
tags: [clance, background]
status: draft
---

# Background

## What Clance is

Clance is a macOS menu-bar app (Apple Silicon) that puts the real Claude
Code CLI one hotkey away from anywhere on the system, with screen context
injected automatically. Press the hotkey, and an embedded terminal opens
running an actual `claude` process — VS Code's integrated-terminal model,
not a custom chat UI — pre-seeded with what you were looking at (frontmost
window title, a screenshot) so you can ask about it immediately.

The core loop:

**Hotkey → Embedded terminal opens (real `claude` process) → Context
injected → You talk to Claude Code directly → Session is a normal,
CLI-resumable session**

**Architecture pivot (superseded the original Agent SDK design):** Clance
originally embedded the Claude Agent SDK directly and rendered its own chat
UI (bubbles, avatars, a custom `proposeText` accept/reject flow for typing
into other apps). That was replaced entirely with embedded terminals
(`node-pty` + `xterm.js`) running the real CLI binary — see
`docs/design.md` §"Terminal-embedding architecture" for why and what
changed. Clance's job narrowed to being a **session launcher + context
provider**: it decides *which* session to open (new vs. resume vs. attach)
and *what context to hand it*, then gets out of the way and lets the CLI be
the CLI. Custom text-injection UI (propose/accept/reject) no longer exists;
if the user wants to type something out, they do it as they would with any
terminal-based Claude Code session.

It is explicitly **not** an ambient/always-watching assistant. The screen is
only read on-demand, at the moment of invocation — never in the background.

## Why this exists

- Most OS-level AI assistants either require a fixed menu of canned actions
  ("Rewrite", "Summarize") or are ambient/always-on, which trades away
  privacy and predictability. Clance is meant to sit in between: on-demand,
  open-ended, and local-first.
- The Claude Code CLI already solves reasoning, tool use, session
  management, and its own terminal UI well — reimplementing a chat
  interface on top of the Agent SDK was pure duplicated surface area with
  none of the CLI's polish (rendering, slash commands, permission
  prompts). The app's job is to be a thin OS-integration shell around the
  *real* CLI — screen capture, context injection, session launching,
  hotkey/tray presence, terminal embedding — not to reinvent an agent UI.
- Session-format compatibility with the Claude Code CLI is a deliberate
  choice, and now falls out for free rather than needing to be
  hand-maintained: every Clance-opened session *is* a real `claude`
  process, so a session started via the hotkey popup is trivially
  resumable from a terminal (`claude --resume <id>`), and vice versa — the
  two surfaces are literally the same underlying sessions, not two
  compatible-but-separate formats.
- Longer-term vision: Clance as "Claude CLI anywhere on your computer," with
  the app injecting context from whatever window/app you invoked it over,
  and future MCP tools for screen reading and system automation delegated
  to the CLI as the execution engine — Clance stays the context
  provider + session launcher, never the execution engine itself.

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
