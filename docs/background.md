---
title: Background
tags: [clance, background]
---

# Background

## What Clance is

Clance is a macOS menu-bar app for Apple Silicon that puts Claude Code one
hotkey away from anywhere on the system. Press ⌥Space in any app and a small
floating terminal opens with a new Claude Code session — the real `claude`
CLI, with your skills, MCP servers and settings. The session also has local
"computer use" tools: it can look at the screen, read highlighted text, type
into the app you were in, and click.

Press ⌥D anywhere to dictate. Clance transcribes on the Mac and types the
text wherever your cursor was.

A main window holds the rest: every Claude Code session on the machine,
openable as terminal tabs; dictation history; installed skills and MCP
servers; and settings.

## Why it exists

- **Between canned actions and ambient agents.** OS-level AI assistants tend
  to be either a fixed menu of actions ("Rewrite", "Summarize") or ambient
  agents that watch everything, trading away privacy and predictability.
  Clance is open-ended but only acts when asked.
- **Claude Code already does the hard part.** Reasoning, tool use, permission
  prompts, slash commands, session storage and a polished terminal UI all
  exist in the CLI. An early version of Clance embedded the Claude Agent SDK
  and drew its own chat UI; it was replaced by the real CLI in an embedded
  terminal because the CLI was better at everything the custom UI duplicated.
  Clance's job is the part the CLI can't do from a terminal: global hotkeys,
  a floating window, access to the screen, keyboard and mouse, and dictation.
- **One kind of session.** Every Clance conversation is a real Claude Code
  session, so there's no second format to keep compatible. Start a session in
  the popup and resume it with `claude --resume`; start one in a terminal and
  open it in Clance.
- **Dictation belongs system-wide.** Speaking is often faster than typing,
  into any app, not just Claude. Clance already needs reliable text insertion
  into other apps for its tools, which makes on-device dictation a small step
  and a reason to keep it running.

## Principles

- **On demand, never ambient.** Nothing on screen is captured unless the
  model calls a screen tool or the user presses ⌘⇧R. The microphone is only
  open while dictating.
- **Local-first.** Config, history and transcripts stay on the Mac, and
  speech is transcribed on-device. The network is used for Claude itself (by
  the CLI), speech model downloads and a user-triggered update check. No
  telemetry, no accounts, no servers of Clance's own.
- **The CLI is the engine.** Clance starts and connects sessions; the model
  decides what to do. New capabilities are MCP tools the CLI calls, gated by
  the CLI's own permission prompts rather than a Clance-built approval UI.
- **Extend through Claude Code.** Skills, MCP servers, hooks and plugins set
  up for Claude Code work in Clance unchanged. Clance doesn't define its own
  plugin format.

## Reference points

- **Spotlight** — hotkey, small floating window, gone as quickly as it came.
- **VS Code's integrated terminal** — a real process in an embedded terminal
  instead of a reimplemented interface.
- **Wispr Flow, superwhisper** — dictation that works in every app.
