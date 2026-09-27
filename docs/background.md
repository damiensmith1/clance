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
openable as terminal tabs; a view of what those sessions have changed in a
git repository; a file explorer and a lightweight editor over any file on the
Mac; dictation history; and settings. It is meant to be the only development
tool open: sessions, terminals and the code they write, in one window.

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
- **Reading the code is part of using the agent.** When the model writes the
  code, the work left for the person is reading it — and reading a change
  means reading the code around it, not just the diff. Clance already has the
  terminal the code is run from and the sessions that wrote it, so the next
  reason to leave the window was to go and look at the files: hence a
  Changes pane that says what is moving, and file tabs that show the whole
  file with its changes marked in place. Committing and pushing are the exits
  from the reading loop rather than the point of it, and branching, rebasing
  and history surgery stay where they already work, in a terminal or in the
  session next door.
- **…and so is touching it up.** Clance was first a *read-only* IDE, on the
  grounds that the session writes the code. In use, the one reason left to
  open another editor was the small edits that aren't worth a prompt: an
  environment variable, a renamed constant, a line the agent got almost
  right, a file dragged in from Finder. Leaving the window for a two-second
  edit costs more than the edit, and asking a session to make it costs more
  still. So Clance becomes a lightweight IDE — an editor, file operations,
  project search and opening any file from Finder — enough that nothing else
  needs to be open while developing. Claude is still the main author; the
  editor is for everything around it. That is also why Clance doesn't try to
  be VS Code: no debugger, no language servers, no extension marketplace.
  Refactoring across a codebase is a prompt, not a menu.

## Principles

- **On demand, never ambient.** Nothing on screen is captured unless the
  model calls a screen tool. The microphone is only open while dictating.
- **Local-first.** Config, history and transcripts stay on the Mac, and
  speech is transcribed on-device. The network is used for Claude itself (by
  the CLI), speech model downloads and a user-triggered update check. No
  telemetry, no accounts, no servers of Clance's own.
- **The CLI is the engine.** Clance starts and connects sessions; the model
  decides what to do. New capabilities are MCP tools the CLI calls, gated by
  the CLI's own permission prompts rather than a Clance-built approval UI.
- **Extend through Claude Code.** Skills, MCP servers, hooks and plugins set
  up for Claude Code work in Clance unchanged. Clance doesn't define its own
  plugin format. Its one extension point of its own is file types: how a
  kind of file is shown and edited is a handler in a registry, added in the
  codebase rather than loaded from disk, because anything loaded into the
  main window can reach the bridge that types into terminals.
- **The agent and the person share the files.** A session may be writing the
  file that's open in an editor. Nothing either side does may silently
  overwrite the other: saving is explicit, and a file that changed underneath
  unsaved edits asks before anything is lost.

## Reference points

- **Spotlight** — hotkey, small floating window, gone as quickly as it came.
- **VS Code's Source Control panel** — the file list an engineer already
  knows, minus the parts of a git client nobody reaches for. Its layout is
  what Clance's first attempt copied and had to abandon: a sidebar file
  picker stretched across a window is a poor way to read a changeset.
- **VS Code's integrated terminal** — a real process in an embedded terminal
  instead of a reimplemented interface.
- **VS Code, the editor** — the keys an engineer's hands already know (⌘S,
  ⌘F, ⌘D, ⌥↑, ⇧⌘F) and an explorer that creates, renames and moves files,
  without the debugger, language servers or marketplace. Lighter on purpose:
  the heavy lifting happens in the session next door.
- **Wispr Flow, superwhisper** — dictation that works in every app.
