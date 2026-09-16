---
title: Dictation (speech-to-text)
tags: [clance, design, requirements]
status: implemented
---
Testing 1, 2, 3.This is a test. 1, 2, 3, 4, 5, 6, 1.Well, that's a bit faster.What about now?I feel like it's getting slower.Is it faster in the app so open?I think it's way faster.Test, testing.
This is a test.I think it's so slow.Mmm.I think it's way faster now.This is buggy as fuck.This is the first.

Testing, one, two, three.
This is another test.
I think it's a bit faster.Hello.
Yeah. OK.
How about now? This will be fast.Blah blah blah blah blah.Yes.
# Dictation (speech-to-text)

System-wide, on-device dictation: press a global shortcut anywhere in
macOS, speak, and Clance types the transcript into whatever app you were
already in. Plus a Dictation tab in the main window holding every
transcript you've ever dictated, backed by SQLite on disk.

This supersedes the terminal-scoped framing of dictation in
`requirements.md` §"Dictation" and closes `design.md`'s open question
"Which local speech-to-text engine for dictation".

**Status: Phases 0–2 built (2026-09-16); Phase 3 outstanding.** The feature
works end to end — global shortcut, HUD, on-device transcription, insertion,
SQLite history, model install with spec-based recommendation. Two things are
deliberately still open: **hold-to-talk** (needs a native key listener, see
Phase 3) and **real-voice accuracy validation**, since the Phase 0 numbers
came from synthesized speech. Automated checks cover the store, the model
catalog, the WAV round trip through `whisper-cli`, and both renderers;
nothing automated can speak into a microphone.

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
  tools server. **Phase 0 closed this for good:** whisper.cpp hits 737 ms
  on the recommended model against a 1.5 s bar, so there's no latency
  deficit left for WhisperKit to recover.
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
- Positioned bottom-centre of the display under the cursor — not at the
  cursor like the popup, so it doesn't cover the field being dictated
  into. Sits 8px above the bottom of the *work area*, which macOS has
  already shrunk to exclude the Dock and menu bar; the original 120px
  double-counted that clearance and left the HUD floating well up the
  screen. Just above the Dock rather than over it — the HUD is at
  screen-saver window level and would otherwise cover Dock icons.
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
- **Thresholds key off GPU core count, not RAM.** This is the correction
  Phase 0 forced — see "Phase 0 results" below. RAM turned out not to be
  the binding constraint at all: `large-v3-turbo-q5_0` uses *less* peak
  RSS than `small.en` (740 MB vs 760 MB, being quantized) while running
  2.6× slower, because its encoder is far bigger. What decides whether a
  tier is usable is GPU throughput, so that's what the recommendation
  reads — via `system_profiler SPDisplaysDataType` ("Total Number of
  Cores", ~170 ms), with RAM and free disk kept only as guards.

  | Detected machine | Recommended | Download |
  |---|---|---|
  | Apple Silicon, ≤ 10 GPU cores (base M1–M4) | `small.en` | 488 MB |
  | Apple Silicon, > 10 GPU cores (Pro/Max/Ultra) | `large-v3-turbo-q5_0` | 574 MB |
  | < 4 GB RAM, or < 2× model size free on disk | step down one tier | |
  | Intel Mac (no Metal tier worth assuming) | `base.en` | 148 MB |

  The Pro/Max row is the one row still extrapolated rather than measured —
  there's no such machine here to test on. It should be treated as
  provisional until someone runs the spike on one; the fallback if it
  disappoints is simply that every Mac gets `small.en`, which is already
  known-good.
- Verified download sizes and pinned hashes, as measured:

  | Model | Bytes | SHA-256 (prefix) |
  |---|---|---|
  | `tiny.en` | 77,704,715 | `921e4cf8686fdd99…` |
  | `base.en` | 147,964,211 | `a03779c86df33230…` |
  | `small.en` | 487,614,201 | `c6138d6d58ecc832…` |
  | `large-v3-turbo-q5_0` | 574,041,195 | `394221709cd5ad1f…` |
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
- Per row: a single copy icon, nothing else. **Edit, re-insert, and
  per-row delete were each built and then removed (2026-09-16)** on use:
  editing a transcript of something you actually said has no purpose once
  the text is already pasted, re-insert needed a minimise-and-wait-400ms
  dance that never felt trustworthy, and per-row delete became redundant
  once bulk delete could be scoped by filter. Copy became an icon so it
  doesn't compete with the transcript text for attention. The FTS update
  trigger stays in the schema regardless, since dropping it would need a
  migration for no benefit.
- Full-text search across history (SQLite FTS5), combined with a date
  filter (All time / Today / 7 days / 30 days / a custom from-to range).
  Presets rather than a date picker by default: dictation history is
  browsed by recency, not absolute date. Ranges resolve at query time, so
  "Today" stays correct across midnight, and a custom end date covers the
  whole day rather than stopping at its midnight.
  - The custom range **prefills to the last 30 days** when first opened.
    That's partly UX (a useful window beats a filter that does nothing
    until both fields are set) and partly cosmetic: an empty
    `input[type=date]` renders Chromium's `yyyy-mm-dd` placeholder, which
    CSS cannot restyle. Keeping the fields populated is the only way to
    never show it.
  - The native control is stripped to a plain underlined field in the app's
    own sans; stock, it's a grey boxed Chromium widget that reads as a
    foreign control beside the flat filter chips.
  - **The calendar button is hidden outright** (`display: none` on
    `::-webkit-calendar-picker-indicator`). It is the only thing that opens
    Chromium's native date popover, and that popover is browser chrome —
    rendered outside the page and completely unstyleable, arriving with its
    own blue/orange highlights. Removing the button means it can never
    open, while the field stays fully editable: clicking a segment and
    typing digits, or arrow keys, are native date-input behaviour. A
    `title` supplies the affordance the glyph used to. Decided 2026-09-16
    over the alternatives of building a themed calendar (~150 lines) or
    dropping custom ranges for more presets.
  - Both fields carry the **same explicit width**. Chromium's intrinsic
    width for a date input turned out not to be stable between two
    otherwise identical fields (measured 84px vs 92px), leaving the pair
    visibly misaligned.
  - Two testing traps this surfaced, both of which produced passing
    assertions over broken UI:
    - **Chromium clips inside the date input's shadow DOM without
      reporting overflow**, so a `scrollWidth <= clientWidth` check passes
      while the last digit is visibly cut off. The test measures the text
      with canvas `measureText` and asserts the box can hold it.
    - `getComputedStyle` cannot read a `-webkit-` shadow pseudo-element, so
      asserting the picker button is hidden that way is meaningless. The
      test checks the shipped stylesheet text instead.
  - `min`/`max` are wired across the pair so the picker itself can't
    produce an inverted range.
  - Date values are formatted from local components, never
    `toISOString()`, which converts to UTC first and would show the wrong
    day for most of the evening west of Greenwich.
- **Bulk delete of whatever the filter currently selects** — always
  labelled "Delete all N", where N is the filtered count, behind an inline
  two-step confirm that names the count and says it can't be undone. The
  confirm sentence adds "matching" when a filter is active, so "Delete all"
  can't be misread as wiping the whole history.
  - Scoped by *filter*, not by the ids on screen: the list is paginated, so
    "delete all of these" has to mean everything matching, not just the
    visible page. `deleteTranscripts` and `queryTranscripts` share one
    `buildQuery` helper precisely so the two can never disagree about what
    "these" means.
  - The confirm sends the filter the visible list was built from (held in a
    ref), not a freshly recomputed one, so editing the search box while the
    confirm is open can't redirect the delete at a different set of rows.
  - Since this is now the *only* way to delete, the confirm carries the
    weight: it states the count and irreversibility rather than relying on
    the button label alone.

Note on building these strings: user-facing sentences here are assembled in
JS and interpolated once, not composed from several adjacent template
expressions. htm collapses the whitespace between adjacent expressions
inside a flex container, which shipped as "Delete 48matchingtranscripts?".
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
-- also serves the date-range filter, which orders and bounds on the same column

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

### Phase 0 — measurement spike ✅ done 2026-09-16

**Exit criterion met.** Target was stop→text under ~1.5 s for a 10 s
utterance on the recommended model; `small.en` in the chosen configuration
does it in **737 ms**. The WhisperKit decision stays closed.

Method: Homebrew `whisper.cpp` 1.9.4 (Metal, `COREML=0`), four ggml tiers,
four ~7–11 s clips, 4 threads, each config run twice with the second
(warm page cache) reported. Machine: Apple M2, 8 GPU cores, 8 GB.

Latency and memory, per ~11 s clip:

| Model | Beam (default) | Greedy | Peak RSS | Verdict |
|---|---|---|---|---|
| `tiny.en` | 361 ms | 288 ms | 250 MB | too inaccurate |
| `base.en` | 460 ms | 380 ms | 360 MB | too inaccurate |
| `small.en` | 1013 ms | **853 ms** | 760 MB | **recommended** |
| `large-v3-turbo-q5_0` | 2440 ms | 2386 ms | 742 MB | misses the bar on this chip |

Five findings, three of which changed the plan:

1. **`small.en` is the first tier that gets technical vocabulary right,
   and it beats `large-v3-turbo-q5_0` at it** while being 2.6× faster.
   On the `node-pty` clip, `tiny.en` produced "no-PTY with a real ARG
   Vare" and `base.en` "Node-PTY with a real ARG-Veray … context arrived
   text", both unusable; `small.en` returned the sentence verbatim, while
   large-turbo merged "argv array" into "argvarray". Accuracy is not
   monotonic in model size here, so "bigger if it fits" would have been
   the wrong rule.
2. **`--prompt` seeding is a large accuracy win and nearly free — promoted
   from Phase 3 to Phase 1.** Seeding a term list turned *"Grab for
   register all hotkeys in source/main/index.ts … setup status as
   complete"* into *"Grep for registerAllHotkeys in src/main/index.ts …
   setupStatus is Complete"* — it recovers camelCase identifiers, fixes
   `src` vs. `source`, and corrects near-homophone commands, for +91 ms.
   Nothing else in the spike bought as much.
3. **Greedy (`-bo 1 -bs 1`) is strictly better than the default beam
   search here** — 646 ms vs 881 ms, 45 MB less resident, and *identical*
   output on every clip tested. Combined: **greedy + prompt is the
   shipping config at 737 ms / 723 MB**, still faster than default beam
   with no prompt at all, and more accurate.
4. **Recommend on GPU cores, not RAM** — the table above; large-turbo is
   simultaneously lighter and much slower than `small.en`.
5. **First-ever run pays an 18.2 s Metal shader compile** (`0.016 s` on
   every run after, from the Metal cache). Unmitigated, the very first
   dictation after install would appear to hang for 18 seconds. Phase 1
   must run a throwaway inference at the end of model install, while the
   progress UI is still on screen. This was the single most dangerous
   thing the spike surfaced and it is invisible in any steady-state
   benchmark.

Two caveats on the accuracy numbers, stated plainly because they bound how
much the above is worth:

- Clips were generated with macOS `say`, not spoken. Latency, RSS and the
  relative ordering of tiers are unaffected, but **the absolute word error
  rates are not trustworthy** and one apparent failure is a TTS artifact:
  every tier heard "tsconfig" as "sconfig" even with `tsconfig.json`
  explicitly in the prompt, because the synthesized audio genuinely
  lacks the /t/. Real-voice validation is still outstanding — the only
  Phase 0 question not closed.
- `whisper.cpp` from Homebrew links shared `ggml`/`llama.cpp` libraries.
  Fine for measurement; the shipped binary needs to be self-contained, so
  Phase 1's build script must produce a static `whisper-cli`, and its
  timings should be re-confirmed once (no reason to expect a change, but
  it's a different binary).

Reproduce: `bench.sh` / `bench2.sh` from this spike are scratch scripts,
deliberately not committed. Models are cached in `~/.clance/models/`,
which is already the path Phase 1 will read from.

### Phase 1 — end-to-end dictation ✅ done 2026-09-16

The goal was one working path: shortcut → speak → text appears.

- `scripts/fetch-whisper-binary.sh` — build/fetch `whisper-cli` arm64;
  wire into `package.json` `build.extraResources`.
- `src/main/whisperModels.ts` — catalog, spec detection, recommendation,
  download + SHA-256 verify + atomic install, removal, "what's installed".
  **Ends every install with a throwaway inference to force the 18.2 s
  Metal shader compile while the progress UI is still up** (Phase 0
  finding 5) — without this the first real dictation looks like a hang.
- `src/main/dictation.ts` — orchestrator and state machine
  (`idle → recording → transcribing → inserting`). **Spawns `whisper-cli`
  per utterance** — resolved, see the open questions — with the Phase 0
  shipping config: `-bo 1 -bs 1 --prompt <term list> -nt -l en -t 4`.
  Calls into `frontApp.ts` to insert.
- Vocabulary seeding ships here, not in Phase 3. A built-in term list
  (the project's own idiom: `tsconfig`, `argv`, `src`, `dist`, camelCase
  identifiers) is most of the win; user-editable comes later.
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

### Phase 2 — history and the Dictation tab ✅ done 2026-09-16

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

### Fixes found by using it (2026-09-16)

Three defects the automated checks couldn't have caught, all found in real use:

- **The Dock icon vanished when the HUD appeared.** Cause:
  `setVisibleOnAllWorkspaces` transforms the app between
  `UIElementApplication` and `ForegroundApplication`, and Electron
  documents that this "will hide the window and dock for a short time."
  Fixed with `skipTransformProcessType: true`, which keeps the
  all-workspaces/over-full-screen behaviour without touching activation
  policy, plus an idempotent `app.dock.show()` after showing the HUD —
  the isolated repro was flaky, so the guard doesn't rely on the primary
  fix alone.
- **A transcription couldn't be stopped.** The Escape hotkey was released
  the moment recording ended, and pressing the dictate key during
  transcription hit an early `return`, so a slow or wedged `whisper-cli`
  could only be waited out. Escape now stays registered until the machine
  reaches idle, the dictate key cancels from the transcribing state, and
  the child process handle is held so `cancelDictation` can actually kill
  it. A cancel that lands mid-transcription now also skips the paste and
  the history write, instead of pasting text the user has just abandoned.
  Consolidated into one `settleToIdle()` so no exit path can leave the
  Escape hotkey, duration timer, or tray indicator dangling.
- **No way to stop dictation from the menu bar.** The HUD is frameless and
  non-focusable, so it has no close button and can't receive `⌘W`. Added a
  Dictation menu with Start/Stop and Cancel. Its accelerators are display
  only (`registerAccelerator: false`) — the real binding is the global
  shortcut, which works with no window open. A live status line was
  considered and dropped: the menu is built once at startup, so it would
  have been stale more often than correct.

### Why the HUD is faster when the main window is open (2026-09-16)

Observed: the HUD appears noticeably quicker with the Clance app window
open than with nothing open. Two macOS/Chromium behaviours explain it, and
neither is in Clance's own code path:

1. **Chromium throttles backgrounded renderers.** `backgroundThrottling`
   defaults to true, so timers and animation frames in a page Chromium
   considers background are deprioritised. A pre-warmed HUD sits *hidden*
   between dictations — meaning the one renderer that must paint a live
   level meter the instant the hotkey fires is exactly the one being
   throttled. A visible main window keeps the app and its
   GPU/compositor work active, and the HUD benefits from that.
2. **macOS App Nap.** An app with no visible windows that isn't frontmost
   can be suspended by the OS, which slows the *main* process too — the
   side that calls `showInactive()`.

Fixed (1) with `backgroundThrottling: false` on the HUD window, which is
cheap and targeted: it applies to one small always-alive window, not the
app.

(2) is **not** addressed. Preventing App Nap needs a
`powerSaveBlocker` with `prevent-app-suspension` held for the app's whole
lifetime, which costs battery permanently to save a fraction of a second
on an occasional interaction. Worth revisiting only if the HUD still feels
sluggish from a cold, idle app.

**Honest limitation: this fix is reasoned from documented behaviour, not
from a before/after measurement, and it is unverified.** Three attempts to
instrument it all hung, and the hangs turned out to be an artifact of the
probe rather than evidence of anything: they occurred during *window
setup*, before any measurement ran, on a transparent screen-saver-level
all-workspaces window that was never shown. `hud-check.js` calls
`executeJavaScript` on an ordinary hidden window without trouble, so the
hangs say nothing about throttling either way. (An earlier version of this
note claimed they corroborated the diagnosis — they don't.) Perceived
speed from a cold, idle app is the only test that settles it.

One incidental finding worth keeping: the level meter is driven directly
by AudioWorklet messages setting styles, *not* `requestAnimationFrame`.
That matters, because rAF is precisely what throttling suspends — an
otherwise conventional rAF-driven meter would freeze whenever the app was
inactive.

### Fourth round: the HUD took seconds to appear (2026-09-16)

Pressing the hotkey and waiting a beat before anything shows up undermines
the whole feature, so this got measured rather than guessed at. Cold, the
path from press to visible HUD was **~1.04s of strictly serial work**:

| Step | Cold | Warm |
|---|---|---|
| `readFrontmostTitle()` — loads the nut-js native addon | 296 ms | 8 ms |
| `checkAvailability()` — resolves the binary, stats the model | 398 ms | 44 ms |
| `showHud()` — creates the window, loads its page | 345 ms | 1 ms |

Everything in that list is cacheable and none of it depends on what the
user does, so two changes:

- **`warmDictation()` at startup** (`index.ts`, alongside the existing
  `warmLoginShellPath` / `warmAgentPool`): pre-creates the HUD window and
  loads its page, loads the nut-js addon, and caches the binary path and
  machine specs. Fire-and-forget, so it never delays launch, and each
  piece is independently best-effort. The HUD renderer only touches
  `getUserMedia` on a `dictation:start` message, so pre-creating it does
  **not** open the microphone.
- **The frontmost-title read came off the critical path.** It's only
  metadata for the history row, which isn't written until after
  transcription, yet the HUD was sitting behind it. It now resolves in
  parallel and `handleAudio` awaits it at the one point it's needed.

Result: **first dictation 1039 ms → 101 ms**, subsequent ~45 ms.

Pre-creating the HUD at launch also means it exists from startup rather
than from first use, which makes the `activate`-handler fix below
load-bearing from the first Dock click rather than only after a dictation.

### Third round: the dock icon went dead after a dictation (2026-09-16)

Launch Clance, never open the main window, dictate once (which works),
then click the Dock icon — nothing happens, and the app looks dead.

`index.ts`'s `activate` handler only reopens the main window when
`BrowserWindow.getAllWindows().length === 0`. That guard is deliberate and
must stay: revealing the popup reactivates the whole app (hiding it uses
`app.hide()`, see `popupWindow.ts`'s `hideWidgetKeepAlive`), which fires
the same `activate` event a Dock click does, and unconditionally opening
the main window there defeats the point of a quiet overlay — that's
commit bbae727.

But the HUD is also a `BrowserWindow`, and it's kept alive (hidden) after
its first use so the *next* dictation appears instantly instead of
reloading a page. So after one dictation the count was permanently ≥ 1 and
the Dock click was silently swallowed.

Fixed by excluding *just the HUD* from that count. The popup still counts,
preserving bbae727 exactly; the HUD can never be the cause of an
activation anyway, since it's `focusable: false` and only ever shown via
`showInactive()`. Note this same class of bug would have applied to any
future always-alive utility window.

Known remaining edge, not fixed: clicking the Dock icon *during* a
recording now opens the main window, which takes focus, so the transcript
pastes there rather than into the app you started in. Deliberate — the
Dock click is an explicit request for the app — but worth knowing.

### Second round of use-driven fixes (2026-09-16)

- **Search box had a heavy amber focus ring.** `.search-input` is designed
  as a *wrapper* around an `<input>`, with the outline reset scoped to the
  descendant (`.search-input input { outline: none }`). It had been applied
  to the `<input>` itself, so it picked up the border-bottom but never the
  outline reset, leaving the platform default ring. Now matches
  `ChatsSection`'s structure exactly.
- **Insert / Edit row actions removed** — see the row-actions requirement
  above. Their IPC handlers, preload methods, and
  `updateTranscriptText` went with them rather than being left as dead
  code.

### What the build added beyond this plan

Three things the plan didn't anticipate, all found by building it:

- **`reconcileActiveModel()`** (`dictation.ts`). `activeModel` can be
  null-but-installable — weights dropped into `~/.clance/models` by hand, a
  config reset, or the active model removed while another remained — and
  without this dictation reports "no model installed" while sitting next to
  working weights. It prefers the machine's recommended model, then the
  *best* other installed one. The first version took `MODEL_CATALOG.find`,
  which silently adopted `tiny.en` — the one tier Phase 0 rejected as too
  inaccurate — because the catalog is ordered smallest-first. Caught by the
  smoke test asserting the recommendation, not by reading the code.
- **Duplicate-accelerator rejection** in `setup:save-shortcuts`. The
  handler validated each accelerator individually but never compared them,
  so binding two actions to one key "saved" fine and then one hotkey
  silently stopped responding (`globalShortcut.register` just returns
  false for the loser). Unreachable with one action; adding dictation made
  it reachable.
- **`readFrontmostTitle()` / `pasteAtCursor()`** (`frontApp.ts`). The plan
  flagged the `capturedWindow` race; the fix is two functions that don't
  touch that slot at all. `pasteAtCursor` also deliberately skips
  `focusTarget` — since the HUD never takes focus, refocusing would *cause*
  the bug it was meant to prevent by pulling focus to whatever the popup
  last captured.

### Phase 3 — refinement (outstanding, each independently droppable)

Two items landed early because they were a few lines each once the rest
existed: the **menu-bar recording indicator** (`tray.ts`'s
`setTrayRecording`, driven from the state machine — the only always-visible
signal that the mic is live when the HUD is on another display) and the
**vocabulary editor** (a plain field in `DictationStep`, since Phase 0
promoted the seeding itself into Phase 1). The rest below is untouched.

- Hold-to-talk via `uiohook-napi` (native dep; Accessibility already
  granted). The main thing standing between v1 and feature parity with
  Wispr Flow.
- ~~Making the `--prompt` term list user-editable~~ — **done**, and
  promoted to a full multi-line editor with a reset-to-default in
  `DictationStep`, labelled "Transcription prompt". The copy states
  plainly that whisper's initial prompt primes *vocabulary* and is not an
  instruction the model follows — "remove filler words" will not work, and
  a user editing a box labelled "prompt" would otherwise reasonably assume
  it would. (Instruction-following cleanup is the separate, still-deferred
  LLM pass below.)
- Optional LLM cleanup pass (strip filler words, punctuate) through the
  `claude` CLI that's already embedded. **Default off** — it adds latency
  and, unlike everything else here, sends the transcript to a model.
- Streaming/partial transcripts in the HUD while speaking.
- ~~Menu-bar recording indicator~~ — **done** (`setTrayRecording`).
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

- [x] Does `small.en` clear the latency bar on an 8 GB M2, and is its
      accuracy on technical vocabulary good enough to be the default
      recommendation? **Yes to both, resolved 2026-09-16** — 737 ms in the
      shipping config against a 1.5 s bar, and it's the *first* tier that
      transcribes this project's own vocabulary correctly. The
      load-bearing assumption held.
- [x] Warm `whisper-cli` process vs. spawn-per-utterance — **resolved:
      spawn per utterance.** Measured overhead is ~150 ms of process/Metal
      init plus ~200 ms model load, so a warm process would save ~350 ms
      of the 737 ms. Not worth holding 723 MB resident permanently on an
      8 GB machine to get under a bar already being cleared. Revisit only
      if the real-voice numbers come in much worse.
- [ ] Real-voice validation of the accuracy findings. The tier ordering
      and all timing/memory numbers are sound, but the spike's clips were
      synthesized with `say`, so absolute accuracy is unverified — this is
      the one Phase 0 question still open, and it needs a human to record
      a few utterances.
- [ ] Ship the `whisper-cli` binary prebuilt in the bundle, or build it on
      first use? Bundling is the better UX and keeps code inside the signed
      bundle, but adds a build-time dependency and grows the app; it also
      forces the hardened-runtime question below. Phase 0 adds a
      constraint either way: the Homebrew build links shared `ggml` and
      `llama.cpp` libraries, so whatever path is chosen must produce a
      **statically linked** `whisper-cli` rather than one that assumes
      Homebrew is present on the user's machine. (`cmake` is also not
      installed on this dev machine — a from-source build adds that too.)
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
