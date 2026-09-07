---
title: Chat History Browser — Design
tags: [clance, design, superpowers-spec]
status: approved
---

# Chat History Browser — Design

## Overview

Sub-project **#3 of 5** in the main-application roadmap (App Shell and
Setup Wizard — sub-projects #1–#2 — are merged to main). This replaces
the Chats sidebar section's placeholder ("Chat history is coming soon.")
with a real, read-only browser over every session Clance can find under
`~/.claude/projects/` — both Clance's own sessions and real Claude Code
CLI sessions from any project on the machine.

The schema below is not assumed — it was verified by directly inspecting
two real session files during brainstorming: a small Clance-originated
session and this repo's own large, real Claude Code CLI transcript
(1,847 lines, 7.4MB).

## Scope

**In scope:**

- List every session found across all directories under
  `~/.claude/projects/`, sorted most-recent-first, each showing a title
  and a human-friendly project label
- Clicking a session shows its full transcript (text rendered as
  markdown, tool calls/results/thinking collapsed to compact summaries)
- A back action returns from the detail view to the list
- Moving the popup's existing `markdown.js` renderer to `src/shared/`
  so both the popup and the chat history detail view use the same,
  single markdown implementation

**Explicitly out of scope for v1:**

- Resuming/continuing a past session from the history view (read-only
  browsing only — the popup's "always starts fresh" design from App
  Shell/Setup Wizard is unchanged)
- SQLite indexing or any caching layer beyond what's described below —
  directory-scan performance is adequate at today's scale; this was
  already flagged as a deferred, not-required-for-v1 optimization in the
  original requirements doc
- Any cross-machine sync
- Search/filter across sessions (browsing the sorted list is enough for
  v1)

## What real session files actually look like

Each `.claude/projects/<encoded-project-path>/<session-uuid>.jsonl` file
is one JSON object per line. Verified by direct inspection:

**Only `"type": "user"` and `"type": "assistant"` lines are conversation
turns.** Everything else is internal Claude Code bookkeeping to skip
entirely — confirmed types seen in a real 1,847-line session:
`queue-operation`, `attachment`, `atis-latch`, `last-prompt`, `mode`,
`permission-mode`, `bridge-session`, `file-history-snapshot`,
`file-history-delta`, `ai-title`, `system`, `cost-state`, `relocated`,
`worktree-state`.

**`user`/`assistant` lines carry a `message` field** in the standard
Anthropic Messages API shape (`{ role, content }`), confirmed by direct
inspection — `content` is usually an array of blocks, occasionally a
plain string (older format). Content block `type`s actually observed in
a real, tool-heavy CLI session: `text` (239), `tool_use` (616),
`tool_result` (616), `thinking` (302). Clance's own sessions (talk-back
only, no tools granted) only ever produce `text` blocks — real CLI
sessions are far richer.

**Claude Code generates its own session titles inline** (`type:
"ai-title"`, field `aiTitle`), confirmed present in a real CLI session
(and regenerated multiple times as a conversation progresses) but
**absent entirely** from Clance's own SDK-driven sessions — the Agent
SDK doesn't generate these. This spec does not use `ai-title` for list
titles (see "List scanning" below for why); a future pass could use it
as an enhancement for CLI-originated sessions specifically.

**Project-path directory names are lossily encoded**: `/` and `.` are
both replaced with `-` (confirmed: `~/.clance`, i.e.
`/Users/x/.clance`, is stored under `-Users-x--clance` — the doubled
dash is the `/` before `.clance` *and* the `.` itself, both becoming
`-`). This makes exact decoding ambiguous in the general case (a literal
`-` or `.` in a real path segment is indistinguishable from the
separator it was replaced with) — not solved here; see "Project labels"
below for the pragmatic approach this spec actually takes.

## Architecture

### List scanning (`src/main/chatHistory.ts`)

```ts
export type SessionSummary = {
  id: string;           // the session UUID, from the filename
  filePath: string;     // absolute path to the .jsonl file
  projectLabel: string; // "Clance", or a best-effort project name
  title: string;        // derived below
  lastModified: string; // ISO timestamp, from fs.stat mtime
};

export async function listSessions(): Promise<SessionSummary[]>
```

Walks `~/.claude/projects/*/`, globbing each project directory for
`*.jsonl` files directly (some sessions have a same-named *directory*
alongside the `.jsonl` file — that holds attachments, not transcript
data, and is not touched). For each file:

- `lastModified` comes from `fs.stat` — cheap, no file content read.
- `title` comes from the **first** `type: "user"` line's text content,
  truncated (~70 chars), found by streaming the file line-by-line and
  stopping as soon as it's found — not a full-file read. This is why
  `ai-title` isn't used for list titles: getting the *latest* one (titles
  regenerate through a conversation) requires scanning to EOF, and some
  real session files here are 7–11MB; doing that for every session in a
  large history isn't worth it for v1. Sessions with no user text yet
  fall back to a literal "New conversation" title.
- `projectLabel`: exactly matching `SESSION_CWD`'s own encoded form
  (computed at runtime as `SESSION_CWD.replace(/[/.]/g, "-")`, so it's
  portable across machines/usernames, not hardcoded) is labeled
  `"Clance"`. Everything else gets a best-effort label: naive-decode the
  directory name (`replace(/-/g, "/")`) and take the last path segment
  — e.g. `-Users-x-Documents-projects-glance` → `"glance"`. This
  sidesteps the encoding's fundamental ambiguity by only ever showing a
  short, human-recognizable project name, not attempting to reconstruct
  a real filesystem path.

Sorted by `lastModified` descending before returning.

### Session detail (`chatHistory:get-session`)

```ts
export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool"; label: string }
  | { type: "thinking" };

export type ChatTurn = {
  role: "user" | "assistant";
  blocks: ChatBlock[];
};

export type SessionDetail = {
  id: string;
  projectLabel: string;
  title: string;
  turns: ChatTurn[];
};

export async function getSession(filePath: string): Promise<SessionDetail | null>
```

Takes the `filePath` the renderer already has from `listSessions()`
(echoed back across IPC, not re-derived from an id — this is an opaque
string the renderer only ever got from Clance's own trusted `listSessions`
result, never user-typed, so passing it back directly is safe and avoids
a redundant re-scan to find the file by id). Only now is the full file
read and parsed, filtered to `user`/`assistant` lines, and each one's
content blocks normalized:

- `text` blocks pass through as-is (rendered as markdown by the
  renderer, via the shared `markdown.js` — see below).
- `tool_use` blocks collapse to `{ type: "tool", label }`, where `label`
  is the tool name plus a short primary argument when one's easy to
  extract (e.g. a Bash command, a file path) — this spec does not
  attempt to reconstruct Claude Code's own rich tool-call UI, just a
  recognizable one-liner.
- `tool_result` blocks collapse the same way, labeled with a short
  preview of the result text (truncated), not the full output.
- `thinking` blocks collapse to `{ type: "thinking" }` with no content
  — the renderer shows a fixed "💭 Thinking…" label, never the raw
  (often large, and in Clance's context not useful) thinking text.
- A plain-string `content` (the older-format edge case observed) is
  treated as a single `text` block.

### Shared markdown renderer

`src/popup/markdown.js` today is a classic (non-module) script defining
a global `renderMarkdown`, loaded via a plain `<script src="markdown.js">`
tag and used by `popup.js` the same way. This spec moves it to
`src/shared/markdown.js` as a proper ES module (`export function
renderMarkdown`), matching every other main-window file's convention —
which means `popup.html`/`popup.js` also switch to `type="module"` +
`import`, a small, mechanical, cross-cutting change to otherwise-
untouched popup files, called out explicitly here since it's easy to
miss. Verify the popup still renders markdown identically afterward
(same CDP-driven verification approach used throughout this project).
The chat history detail view imports the same function for its `text`
blocks — one markdown implementation, not two.

### Renderer (`src/mainWindow/sections/ChatsSection.js`)

Replaces the placeholder with a list↔detail toggle (`useState` between
`"list"` and a selected session), not a true side-by-side split pane —
simpler, and reasonable at the main window's current size
(960×640, min 720×480). The list shows each session's title, a relative
timestamp, and project label; clicking one fetches and shows its detail
view (turns rendered in the same "ambient transcript" style already
established by the popup — dim prompt line, full-opacity reply, no chat
bubbles); a back button returns to the list, re-fetching it fresh (a
session's title/position may have changed since the list was first
shown).

## Data flow

1. `ChatsSection` mounts → calls `chatHistory:list-sessions` → renders
   the sorted list.
2. User clicks a session → calls `chatHistory:get-session` with that
   session's `filePath` → renders the detail view.
3. User clicks back → re-fetches `chatHistory:list-sessions` → renders
   the list again.

## Error handling

- A session file that fails to parse (malformed JSON on some line,
  truncated file) is skipped for that line only — `listSessions`/
  `getSession` continue past unparseable lines rather than failing the
  whole session or the whole list.
- `~/.claude/projects/` not existing at all (a fresh machine with no
  Claude Code history yet) is not an error — `listSessions` returns an
  empty array, and the UI shows an empty-state message rather than
  erroring.

## Testing approach

Same as the rest of this project: no test framework. `npm run build`
compiling cleanly, plus real launch verification via Chrome DevTools
Protocol — reading back actual rendered list/detail content, not just
"no console errors." This project's own real, already-existing session
files (including the large CLI one this design was based on) are
available on the development machine as real test data — no synthetic
fixtures needed.

## Open questions for the implementation plan

- Exact tool-name/primary-argument extraction heuristic for `tool_use`
  labels (e.g. how to find "the primary argument" across different tool
  shapes) — resolve with real examples from the CLI session file during
  implementation rather than guessing every tool's input shape upfront.
- Whether the "New conversation" fallback title (for a session with no
  user text yet) can actually occur in practice, or is purely defensive.
