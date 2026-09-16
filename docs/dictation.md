---
title: Dictation (speech-to-text)
tags: [clance, design, requirements]
status: proposed
---

# Dictation (speech-to-text)

System-wide, on-device dictation: press a global shortcut anywhere in
macOS, speak, and Clance types the transcript into whatever app you were
already in. Plus a Dictation tab in the main window holding every
transcript you've ever dictated, backed by SQLite on disk.

This supersedes the terminal-scoped framing of dictation in
`requirements.md` §"Dictation" and closes `design.md`'s open question
"Which local speech-to-text engine for dictation". **Decided, not yet
implemented** — this doc is the spec and build plan, not a record of
shipped behavior.

## Problem

`requirements.md` has listed dictation as an unimplemented requirement
since before the terminal-embedding pivot, blocked on a design question:
the original "populate a text input" model didn't map onto a terminal's
stdin, so it was parked.

That framing was too narrow. Scoping dictation to Clance's own terminals
makes it a convenience for one surface. Scoping it to *the whole OS* makes
it a reason to keep Clance running — a peer feature to the popup rather
than a detail of it. The reference points are Wispr Flow, superwhisper,
and MacWhisper: hold or press a key anywhere, talk, get text where your
cursor already was.

Two things make this cheap for Clance specifically, and both are the real
reason to build it now:

1. **The hard half is already built and hardened.** `src/main/frontApp.ts`
   already injects text into an arbitrary frontmost app —
   `pasteViaClipboard` (clipboard write + synthetic `Cmd+V`, with
   save/restore of the user's clipboard and a settle delay),
   `focusTarget`, `captureFrontmostWindow`, and a title-matching retarget
   path that deliberately fails closed against window-title spoofing. This
   exists to back the `insert_text` MCP tool. Dictation's "…and it types"
   step is a call into code already in the repo.
2. **Accessibility permission is already granted.** It's a setup-wizard
   requirement (`PermissionsStep`) because `insert_text` needs it.
   Dictation needs exactly the same grant and nothing more, so there's no
   new permission wall for existing users beyond the microphone itself.

What's genuinely new is: audio capture, a local transcription engine, a
model catalog with install management, transcript storage, a recording
HUD, and a second global shortcut.

## Decision: engine and model format

**whisper.cpp (`whisper-cli`) running ggml models, Metal-accelerated.**

Considered and rejected:

- **WhisperKit (Argmax).** Faster on Apple Silicon — it targets the Neural
  Engine directly rather than the GPU — and is the better long-term answer
  on pure performance. Rejected for v1 because it's a Swift package with
  its own CoreML model format and its own signing story; whisper.cpp is a
  single self-contained binary invoked as a child process, which is
  exactly the shape this codebase already uses for `claude` and the local
  tools server. Revisit if measured latency disappoints.
- **Apple's `Speech` framework** (`SpeechAnalyzer`/`SpeechTranscriber` on
  macOS 26, which is what system dictation itself uses). Free, no model
  download, no binary to ship. Rejected because it has no model selection
  at all, which makes the "recommend a model for this machine, then
  install it" requirement meaningless, and because it needs a Swift helper
  binary to reach from Node anyway. Worth reconsidering as a zero-install
  fallback tier.
- **Cloud STT.** Violates the local-first principle in
  `requirements.md`. Non-starter; audio never leaves the device.

**Binary distribution: bundle a prebuilt `arm64` `whisper-cli` as an
`extraResources` entry; download only model weights at runtime.** This
keeps the "install" the user presses to a weights download (which is what
they actually expect to wait on) and keeps executable code inside the
signed app bundle rather than fetched at runtime. A build-time script
compiles or fetches the binary; it is not committed to the repo.

Downloading weights *is* a network call, and this doc should not pretend
otherwise — it's a one-time fetch from Hugging Face over HTTPS, verified
against a pinned SHA-256, and no audio or transcript ever leaves the
machine.

## Decision: storage

**`node:sqlite` (Node's built-in SQLite), not `better-sqlite3`.**

Verified working in this project's actual runtime — Electron 44.2.0 ships
Node 24.20.0, and `DatabaseSync` against `:memory:` and a real file both
work with no flag:

```
$ ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "…"
electron-node 24.20.0
sqlite OK 1
```

This matters more than it sounds: the alternative is a native addon
needing `@electron/rebuild` against Electron's ABI on every Electron bump,
which this project already carries for `node-pty` and would rather not
carry twice. `node:sqlite` is still flagged experimental upstream (it
emits an `ExperimentalWarning`), so all access goes through one thin
wrapper module — swapping engines later is a one-file change.

## Functional requirements

### Global dictation shortcut

- A second global shortcut, alongside `togglePopup` — a new entry in
  `SHORTCUT_ACTIONS` (`src/main/shortcuts.ts`), so it inherits the
  existing rebinding UI (`ShortcutsStep`) and persistence
  (`config.shortcuts`) for free. Proposed default `Alt+D`.
- Press to start, press again to stop and transcribe. `Escape` cancels and
  discards.
- **Hold-to-talk is explicitly a Phase 3 item, not v1.** Electron's
  `globalShortcut` delivers no key-*up* event, so genuine push-to-talk is
  impossible with it — it needs a native global key listener
  (`uiohook-napi`), which is another native rebuild, though notably it
  needs only the Accessibility grant Clance already has. This is the one
  place v1 will feel different from Wispr Flow, so it's called out rather
  than buried.
- Auto-stop on sustained silence (default ~1.5s of sub-threshold RMS), and
  a hard cap on utterance length (default 5 min) so a forgotten recording
  can't grow unbounded in memory.
- Dictation's shortcut **must not be gated on Claude auth.** Today
  `registerAllHotkeys` only runs when `getSetupStatus().isComplete`, which
  requires `claude` installed *and* logged in. Dictation touches nothing
  Claude-related; gating it that way would be wrong.

### Recording HUD

- A small always-on-top window showing recording state, elapsed time, a
  live input-level meter, and the resolved target app.
- **It must never take key focus.** This is the single most important
  constraint in the feature. The popup widget takes focus deliberately;
  if the HUD does, the frontmost app changes and the transcript pastes
  into the wrong place. So: `focusable: false` + `showInactive()`. Done
  right, focus never leaves the user's app and no refocus step is needed
  at all.
- Positioned bottom-center of the display under the cursor — not at the
  cursor like the popup, so it doesn't cover the field being dictated
  into.
- Because it can't receive key events, `Escape`-to-cancel is implemented
  as a temporary `globalShortcut` registered for the duration of the
  recording and unregistered on stop.

### Transcript insertion

- Default: paste at the cursor in the app that was frontmost when the
  shortcut fired, via `frontApp.ts`'s existing `typeIntoCapturedWindow`.
  Insert at cursor, never replace the field.
- Inherits that path's accepted trade-off: the user's clipboard is briefly
  overwritten and restored ~500ms later, and a non-text clipboard payload
  (image, files) is lost. Acceptable here for the same reason it was there.
- This works inside Clance's own terminals too, with no special-casing —
  xterm.js handles `Cmd+V` like any other app. That incidentally satisfies
  the original "dictate into the embedded CLI" requirement.
- Fallback when Accessibility is denied, or on explicit preference:
  clipboard-only, with the HUD confirming "copied — press ⌘V". Dictation
  should degrade, not fail, without keystroke injection.

### Model catalog, recommendation, and install

- A catalog of ggml models with download size, approximate runtime memory,
  and a relative quality/speed note. Candidate set: `tiny.en`, `base.en`,
  `small.en`, `large-v3-turbo-q5_0`, `large-v3-turbo`.
- Clance inspects the machine and **recommends exactly one**, with a
  one-line reason the user can read ("Apple M2, 8 GB — small.en balances
  accuracy against memory here"). Inputs, all cheap and local:
  `sysctl -n hw.memsize`, `machdep.cpu.brand_string`,
  `hw.perflevel0.physicalcpu`, and free space on the volume holding
  `~/.clance`.
- The full catalog stays selectable. The recommendation is a default, not
  a restriction.
- **Provisional** thresholds, to be calibrated by the Phase 0 spike rather
  than shipped on the strength of this table:

  | Detected machine | Recommended | Download |
  |---|---|---|
  | ≤ 8 GB RAM | `small.en` | ~466 MB |
  | 16 GB RAM | `large-v3-turbo-q5_0` | ~574 MB |
  | ≥ 32 GB RAM | `large-v3-turbo` | ~1.6 GB |
  | < 2× model size free on disk | step down one tier | |
  | Intel Mac | `base.en` | ~142 MB |

  For reference, the development machine here (Apple M2, 8 GB, ~14.6 GB
  free) resolves to `small.en` — so the common path is exercised by
  default during development rather than only on paper.
- Install is a background download with visible progress, resumable,
  SHA-256 verified before being moved into place, cancellable, and
  atomically renamed so a partial file is never loadable. Models live in
  `~/.clance/models/`. Installed models can be removed to reclaim disk.
- Multiple models may be installed; one is active.

### Dictation tab and history

- A new main-window tab type, `dictation` — a new `LAUNCHER_ITEMS` entry,
  a new `renderTabContent` case in `Shell.js`, and
  `sections/DictationSection.js`. It's a singleton like the Sessions tab,
  which the layout store's existing `findTabAnywhere` already handles
  (opening it when it's already open in another pane focuses it there).
  It's stateless, so layout rehydration needs no special handling.
- Reverse-chronological list of every transcript: text, timestamp,
  duration, target app, model used, transcription wall time.
- Per row: copy, re-insert into the frontmost app, edit, delete.
- Full-text search across history (SQLite FTS5).
- The tab is also where dictation is configured — model management, mic
  permission, shortcut, preferences — surfaced as a `DictationStep`
  component reused in Settings, matching how `SettingsSection` already
  reuses `ConnectClaudeStep`/`PermissionsStep`/`ShortcutsStep`.

### Microphone permission

- `NSMicrophoneUsageDescription` in `package.json`'s
  `build.mac.extendInfo`. Without it, macOS kills the app on first mic
  touch rather than prompting.
- Request via `systemPreferences.askForMediaAccess("microphone")`, status
  via `getMediaAccessStatus("microphone")` — unlike Screen Recording,
  there *is* a real request API here, so no `requestScreenRecordingAccess`-
  style trick is needed.
- Add `microphone` to `PermissionsStatus`, but **do not add it to
  `setupStatus.ts`'s `isComplete`.** Dictation is optional; a user who
  never dictates must not be held in the setup wizard over a mic grant.
  It's surfaced as a status card in the dictation UI instead.

### Privacy

- Audio is captured, transcribed locally, and the buffer discarded. No
  audio file is retained unless the user opts in (`keepAudio`, default
  off) for debugging.
- Transcripts persist in plaintext SQLite under `~/.clance/`, same trust
  boundary as `config.json` and the CLI's own session JSONL. Worth stating
  plainly: dictation history is a log of things the user said, so "delete"
  must really delete, including from the FTS index.

## Data model

`~/.clance/dictation.db`:

```sql
CREATE TABLE transcripts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,          -- epoch ms
  duration_ms   INTEGER NOT NULL,          -- audio length
  transcribe_ms INTEGER NOT NULL,          -- engine wall time
  model         TEXT    NOT NULL,          -- catalog id, e.g. "small.en"
  target_app    TEXT,                      -- window title at capture, nullable
  inserted      INTEGER NOT NULL DEFAULT 0 -- did the paste land
);

CREATE INDEX idx_transcripts_created_at ON transcripts(created_at DESC);

CREATE VIRTUAL TABLE transcripts_fts USING fts5(
  text, content='transcripts', content_rowid='id'
);
-- plus AI/AD/AU triggers to keep FTS in sync
```

`user_version` carries the schema version; migrations are forward-only and
run at open.

Config additions to `ClanceConfig` (`src/main/config.ts`), merged by the
existing defaults-spread so an older on-disk config picks them up:

```ts
dictation: {
  activeModel: string | null;   // null = not installed yet
  insertMode: "paste" | "clipboard";
  autoStopSilenceMs: number;
  maxDurationMs: number;
  keepAudio: boolean;
}
```

`shortcuts.dictate` comes along automatically via `DEFAULT_CONFIG.shortcuts`.

## Implementation plan

### Phase 0 — measurement spike (no product code)

Answer the questions this doc is currently guessing at, before building UI
on top of them.

1. Build/obtain `whisper-cli` for `arm64`, run `small.en` and
   `large-v3-turbo-q5_0` over sample utterances on the M2/8 GB dev
   machine.
2. Record: cold vs. warm start, real-time factor, peak RSS, and quality on
   technical vocabulary (`tsconfig`, `npm`, file paths, identifiers) —
   which is the vocabulary that actually matters for this app's users and
   where the small models tend to fall down.
3. Decide from data: the recommendation thresholds above; whether to keep
   a warm `whisper-cli` process or spawn per utterance; whether
   `--prompt` seeding with technical terms is worth it.

Exit criterion: stop→text under ~1.5s for a 10s utterance with the
recommended model. If that fails, reopen the WhisperKit decision before
writing any UI.

### Phase 1 — end-to-end dictation, no history, no UI polish

The goal is one working path: shortcut → speak → text appears.

- `scripts/fetch-whisper-binary.sh` — build/fetch `whisper-cli` arm64;
  wire into `package.json` `build.extraResources`.
- `src/main/whisperModels.ts` — catalog, spec detection, recommendation,
  download + SHA-256 verify + atomic install, removal, "what's installed".
- `src/main/dictation.ts` — orchestrator and state machine
  (`idle → recording → transcribing → inserting`), spawns `whisper-cli`,
  calls into `frontApp.ts` to insert.
- `src/main/dictationWindow.ts` — the non-focusable HUD window.
- `src/dictationHud/{index.html,hud.js}` + `src/preload/dictationHud.ts` —
  `getUserMedia` + an `AudioWorklet` downsampling to 16 kHz mono, RMS
  level for the meter and silence detection, PCM to main over IPC, written
  as a WAV under `~/.clance/dictation/audio/` for the engine. Audio
  capture has to live in a renderer; the main process has no
  `getUserMedia`. The HUD needs to render a meter anyway, so it doubles as
  the recorder rather than adding a second hidden window.
- `src/main/permissions.ts` — add `microphone` to `PermissionsStatus`
  (and *not* to `isComplete`).
- `src/main/shortcuts.ts` — add the `dictate` action.
- `src/main/hotkey.ts` / `index.ts` — generalize `registerAllHotkeys` to
  iterate `SHORTCUT_ACTIONS` instead of hardcoding `shortcuts.togglePopup`,
  and let dictation's registration bypass the `isComplete` gate.
- `package.json` — `NSMicrophoneUsageDescription` in `build.mac.extendInfo`;
  add `dist/dictationHud` to the `build` script's `mkdir -p`/`cp -r` list
  (easy to miss — the renderer dirs are copied, not compiled).

Two things to be careful about in this phase:

- **`capturedWindow` in `frontApp.ts` is module-level state shared with the
  popup flow.** If dictation calls `captureFrontmostWindow()` it clobbers
  whatever the popup captured, and vice versa. Either have capture return
  a handle the caller holds, or give dictation its own slot. Don't let two
  features race one global.
- **Duplicate accelerators.** `setup:save-shortcuts` validates each
  accelerator individually but never checks two actions for collision;
  with only one action that was unreachable, and a second action makes it
  reachable — the second `globalShortcut.register` silently fails. Add the
  collision check with the action.

### Phase 2 — history and the Dictation tab

- `src/main/dictationStore.ts` — the `node:sqlite` wrapper: open,
  migrate, insert, list (paginated), FTS search, update text, delete.
- `src/mainWindow/sections/DictationSection.js` — the tab: history list,
  search, per-row actions.
- `src/mainWindow/setup/DictationStep.js` — mic status card, model
  catalog with the recommendation called out, install/remove with
  progress, shortcut row, preferences. Reused in `SettingsSection`.
- `Shell.js` — `LAUNCHER_ITEMS` entry + `renderTabContent` case.
- `src/preload/mainWindow.ts` — `dictation:*` IPC surface.
- Reuse the existing unused `Icon.mic` in `src/shared/icons.js` — it's
  been sitting there since the pre-terminal-pivot design with no call
  sites, and this is what it was drawn for.
- Optionally offer the dictation step as a wizard step for new users;
  skippable, and it must not block `isComplete`.

### Phase 3 — refinement (each independently droppable)

- Hold-to-talk via `uiohook-napi` (native dep; Accessibility already
  granted). The main thing standing between v1 and feature parity with
  Wispr Flow.
- `--prompt` vocabulary seeding from a user-editable term list, if Phase 0
  shows it helps.
- Optional LLM cleanup pass (strip filler words, punctuate) through the
  `claude` CLI that's already embedded. **Default off** — it adds latency
  and, unlike everything else here, sends the transcript to a model.
- Streaming/partial transcripts in the HUD while speaking.
- Menu-bar recording indicator via `tray.setTitle`/`setImage` (`tray.ts`
  currently renders a plain "Clance" text label).
- Per-app insert-mode overrides.

## Out of scope

- Real-time duplex voice conversation with the model. `sep10talks.md`
  already separates that from dictation; this is voice → text → normal
  turn, nothing streaming.
- Text-to-speech / speaking responses back.
- Non-English-first transcription. The `.en` models are the recommended
  tier; multilingual works via `large-v3-turbo` but isn't a v1 goal.
- Speaker diarization, meeting recording, long-form file transcription.
  This is an input method, not a transcription product.
- Windows/Linux. macOS-only, consistent with the rest of Clance.

## Open questions

- [ ] Does `small.en` clear the latency bar on an 8 GB M2, and is its
      accuracy on technical vocabulary good enough to be the default
      recommendation? (Phase 0 decides; it's the load-bearing assumption
      in this whole plan.)
- [ ] Warm `whisper-cli` process vs. spawn-per-utterance — a warm process
      cuts model load time off every dictation but holds ~1 GB resident on
      a machine that may only have 8 GB.
- [ ] Ship the `whisper-cli` binary prebuilt in the bundle, or build it on
      first use? Bundling is the better UX and keeps code inside the signed
      bundle, but adds a build-time dependency and grows the app; it also
      forces the hardened-runtime question below.
- [ ] Hardened runtime and entitlements. `scripts/dev-packaged.sh`
      deliberately signs without `--options runtime` today. A bundled
      native binary plus mic access will eventually need
      `com.apple.security.device.audio-input` and a real entitlements
      file. Worth deciding before Phase 1 ships, not after.
- [ ] History retention: unbounded, or a configurable cap / auto-prune?
- [ ] Should a dictated transcript be *editable* in the HUD before it's
      inserted (a confirm step), or always inserted immediately with
      history as the undo path? Immediate is faster and matches the
      reference apps; a confirm step is safer for a misrecognition pasted
      into something irreversible.
