---
title: Setup Wizard — Design
tags: [clance, design, superpowers-spec]
status: approved
---

# Setup Wizard — Design

## Overview

Sub-project **#2 of 5** in the main-application roadmap (App Shell, this
spec, then chat history, settings, extensibility UI). This adds a
first-run setup wizard that gates the entire app: **no functionality is
available — not even the global hotkey — until setup completes.**

The wizard has three sequential steps:

1. **Claude** — connect the user's Claude plan
2. **Permissions** — grant Screen Recording and Accessibility
3. **Shortcuts** — confirm/choose the keyboard shortcut(s) that trigger
   Clance's actions

Once all three are satisfied, the app "unlocks": the global hotkey
registers and the main window shows its normal sidebar (Chats/Skills &
Plugins/Settings) instead of the wizard. The same three checks — and the
same step components — resurface permanently inside the Settings section,
so a user can reconnect, re-grant a revoked permission, or rebind a
shortcut at any time after initial setup.

## Scope

**In scope:**

- A single source-of-truth "setup status" check (`getSetupStatus()`) that
  both the main process (hotkey gating) and the renderer (wizard-vs-shell)
  rely on, so there is never a second, divergent notion of "is setup done"
- Step 1: detect whether the `claude` CLI is installed; if not, link to
  Anthropic's official install docs; if installed but not logged in, a
  "Connect" button spawns `claude auth login` and awaits its result
- Step 2: live-check Screen Recording and Accessibility permission status
  via Electron's `systemPreferences` APIs; each shows a deep-link into the
  correct System Settings pane and a re-check action
- Step 3: a small shortcuts registry (id/label/default-accelerator per
  action) — today just one entry (open popup) — with the chosen
  accelerator(s) persisted to a new local config file
- Gating: the global hotkey does not register, and the main window opens
  itself automatically on launch (bypassing the need to click the Dock
  icon), whenever setup is incomplete
- The same three step components render permanently in the Settings
  section post-setup (not a separate reimplementation)

**Explicitly out of scope:**

- Reverse-engineering the Agent SDK's bundled binary to make auth fully
  dependency-free — this spec requires the `claude` CLI to be separately
  installed, with the wizard guiding the user through installing it if
  it's missing (see "Open questions" in the App Shell spec, now resolved
  this way)
- Requesting the Accessibility permission's *use* (the actual "type it
  out" text-injection feature) — only the permission *grant* is primed
  here; the feature itself is unbuilt
- Any settings unrelated to these three checks (model choice, theming,
  etc. — later specs)
- Supporting more than one shortcut-bound action's *UI* meaningfully (only
  one action — open popup — exists to bind today); the registry shape
  supports more, but the UI isn't tested against a longer list

## Architecture

### The setup-status mechanism

`src/main/setupStatus.ts` is the single aggregator every other piece reads
from — this directly answers "how do we know if the user has done setup":

```ts
export type ClaudeAuthStatus =
  | { installed: false }
  | { installed: true; loggedIn: false }
  | {
      installed: true;
      loggedIn: true;
      email?: string;
      organization?: string;
      subscriptionType?: string;
    };

export type PermissionsStatus = {
  screenRecording: boolean;
  accessibility: boolean;
};

export type SetupStatus = {
  claude: ClaudeAuthStatus;
  permissions: PermissionsStatus;
  shortcutsConfigured: boolean;
  isComplete: boolean;
};

export async function getSetupStatus(): Promise<SetupStatus> {
  const claude = await checkClaudeAuth();
  const permissions = checkPermissions();
  const { shortcutsConfigured } = readConfig();
  const isComplete =
    claude.installed &&
    claude.loggedIn &&
    permissions.screenRecording &&
    permissions.accessibility &&
    shortcutsConfigured;
  return { claude, permissions, shortcutsConfigured, isComplete };
}
```

Auth and permissions are **never cached as a persisted "done" flag** —
they're live-checked every call, since either can change outside the app
(the user logs out of Claude, or revokes a permission in System Settings).
Only the shortcuts step has real data to persist (the chosen
accelerator), plus a `shortcutsConfigured` boolean marking that the user
has been through that step at least once (there's no external system fact
to check it against, unlike the other two).

### Claude connection

`src/main/claudeAuth.ts`:

```ts
export function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  // execFile("claude", ["auth", "status", "--json"]); ENOENT -> { installed: false }.
  // Otherwise parse stdout JSON into the installed+loggedIn+account shape.
}

export function connectClaude(): Promise<ClaudeAuthStatus> {
  // spawn("claude", ["auth", "login"]) — this opens the user's browser and
  // blocks until the OAuth round-trip completes or fails. Await its exit,
  // then call checkClaudeAuth() again and return the fresh result.
}
```

No polling loop is needed: `claude auth login` itself blocks in its own
process until the browser-based login finishes (success or failure), so
awaiting its exit is sufficient. If `claude` isn't installed, the "Claude"
step shows a short explanation and a button opening Anthropic's official
Claude Code docs via `shell.openExternal` — Clance does not embed an
install command of its own, so it can never go stale if Anthropic changes
how the CLI is installed.

### Permissions

`src/main/permissions.ts`:

```ts
export function checkPermissions(): PermissionsStatus {
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

export function openScreenRecordingSettings(): void {
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
}

export function openAccessibilitySettings(): void {
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
}
```

`isTrustedAccessibilityClient(false)` — the `false` means "check only,
don't trigger macOS's own native permission-request dialog," since Clance
drives the user to System Settings itself via the deep link instead.

### Shortcuts registry and persistence

`src/main/config.ts` — a small local JSON store, distinct from session
storage (`paths.ts`'s `SESSION_CWD`), but living in the same `~/.clance/`
directory:

```ts
export type ClanceConfig = {
  shortcuts: Record<string, string>; // action id -> accelerator
  shortcutsConfigured: boolean;
};

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space" },
  shortcutsConfigured: false,
};

export function readConfig(): ClanceConfig { /* read ~/.clance/config.json, fall back to DEFAULT_CONFIG */ }
export function writeConfig(config: ClanceConfig): void { /* write it */ }
```

`src/main/shortcuts.ts` defines the registry the Shortcuts step renders
against:

```ts
export type ShortcutAction = { id: string; label: string; defaultAccelerator: string };

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "togglePopup", label: "Open Clance popup", defaultAccelerator: "Alt+Space" },
];
```

Today this array has one entry; the Shortcuts step iterates it rather
than hardcoding a single field, so a later feature that needs its own
shortcut just adds an entry here — no UI redesign. `hotkey.ts`'s
`registerHotkey` already takes an accelerator parameter (it does today),
so gating just means index.ts reads `config.shortcuts.togglePopup` instead
of relying on `registerHotkey`'s hardcoded default.

### Gating in `index.ts`

```ts
app.whenReady().then(async () => {
  ensureSessionCwd();
  currentSessionId = readLastSessionId();

  Menu.setApplicationMenu(createAppMenu());
  createTray(toggleClancePopup, openMainWindow);

  const status = await getSetupStatus();
  if (status.isComplete) {
    const config = readConfig();
    registerHotkey(toggleClancePopup, config.shortcuts.togglePopup);
  } else {
    openMainWindow();
  }
});
```

If setup is incomplete, the main window opens itself immediately on
launch rather than waiting for a Dock/tray click — the user must always
land somewhere actionable, never a bare Dock icon with no visible next
step. A new IPC handler (`setup:complete`, invoked by the wizard once its
last step finishes) re-runs `getSetupStatus()` and, if now complete, calls
`registerHotkey` there and then — this is what makes the hotkey become
live within the same running session, not just on next launch.

### Renderer: wizard vs. shell fork

`src/mainWindow/app.js`'s `App` component becomes a thin switcher:

```js
function App() {
  const [status, setStatus] = useState(null); // null = still loading

  useEffect(() => {
    window.clanceApp.getSetupStatus().then(setStatus);
  }, []);

  if (status === null) return html`<div class="loading">Loading…</div>`;
  if (!status.isComplete) {
    return html`<${SetupWizard} initialStatus=${status} />`;
  }
  return html`<${Shell} />`;
}
```

`src/mainWindow/Shell.js` is the existing sidebar+content markup,
extracted verbatim out of today's `app.js` so `App` no longer owns that
layout directly.

`src/mainWindow/setup/SetupWizard.js` owns step-sequencing state (which of
`claude`/`permissions`/`shortcuts` is active, advancing on each step's
completion, calling `clanceApp.completeSetup()` after the last one) and
renders exactly one of three step components at a time:

- `src/mainWindow/setup/ConnectClaudeStep.js`
- `src/mainWindow/setup/PermissionsStep.js`
- `src/mainWindow/setup/ShortcutsStep.js`

Each step component's job is only to show current status and expose its
own actions (connect / open-settings-and-recheck / choose-accelerator) —
it does not know whether it's being rendered inside the wizard or inside
Settings. Advancing to the next step, or not, is the wizard's
responsibility as the parent; Settings renders the same components
standalone with no "advance" behavior at all.

### Settings becomes real

`src/mainWindow/sections/SettingsSection.js` replaces its placeholder
with the same three step components, each showing live status
(connected account + disconnect, permission status + re-check, current
shortcut bindings + rebind) — this is the first stub section in the App
Shell to get real content, and it doubles as the reconnect/recovery path
if a permission is later revoked or the Claude session logs out.

### Preload surface

`src/preload/mainWindow.ts` replaces its empty `clanceApp: {}` with the
real API surface this flow needs:

```ts
contextBridge.exposeInMainWorld("clanceApp", {
  getSetupStatus: () => ipcRenderer.invoke("setup:get-status"),
  connectClaude: () => ipcRenderer.invoke("setup:connect-claude"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("setup:open-screen-recording-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("setup:open-accessibility-settings"),
  recheckPermissions: () => ipcRenderer.invoke("setup:recheck-permissions"),
  getShortcutActions: () => ipcRenderer.invoke("setup:get-shortcut-actions"),
  saveShortcuts: (shortcuts) => ipcRenderer.invoke("setup:save-shortcuts", shortcuts),
  completeSetup: () => ipcRenderer.invoke("setup:complete"),
});
```

All `ipcMain.handle("setup:...")` registrations live in `index.ts`
alongside the existing `submit-goal`/`new-conversation` handlers, matching
the codebase's current pattern of registering everything in one place
rather than spreading `ipcMain` calls across many files.

## Data flow

1. App launches → `index.ts` calls `getSetupStatus()`.
2. Incomplete → main window opens automatically, hotkey not registered.
3. `app.js` calls `clanceApp.getSetupStatus()` (same underlying function,
   via IPC) and renders `SetupWizard` at whichever step is still
   unsatisfied (not necessarily step 1 — e.g. if Claude is already
   connected from a prior run but permissions were revoked, the wizard
   opens straight to the Permissions step).
4. User completes each step; `SetupWizard` calls `clanceApp.completeSetup()`
   after the last one.
5. `completeSetup` handler re-checks status; if complete, persists nothing
   new itself (the individual steps already persisted what needed
   persisting) but registers the hotkey and signals the renderer to
   switch to `Shell`.

## Error handling

- `claude auth login` exits non-zero, or the browser flow is abandoned:
  `connectClaude()`'s promise resolves with the fresh (still
  not-logged-in) status rather than throwing — the step just shows
  "not connected yet" and lets the user retry, not a hard error state.
- `claude` binary missing entirely: distinguished from "installed but
  logged out" via the `installed: false` variant, driving the
  install-instructions UI instead of a login button.
- Permission checks never throw — `systemPreferences` calls are
  synchronous and side-effect-free; there's no failure mode beyond
  "granted" / "not granted."

## Testing approach

Same as the rest of this project: no test framework. `npm run build`
compiling cleanly, plus real launch verification via Chrome DevTools
Protocol (checking actual rendered wizard-step content and status
transitions, not just "no console errors") — the pattern established in
the App Shell plan's Task 4, which produced real evidence instead of
false confidence.

One thing that cannot be verified via CDP alone in a dev/CI environment:
the actual `claude auth login` browser round-trip and the actual macOS
permission grant require a human in the loop. Implementation verification
should mock/stub `checkClaudeAuth`/`checkPermissions` at the boundary
where needed to test the wizard's step-sequencing logic without requiring
a live login or a real permission grant every time — the exact boundary
for this is an implementation-plan-level decision, not resolved here.

## Open questions for the implementation plan

- Exact `claude auth status --json` and `claude auth login` exit-code/error
  semantics under failure (network error mid-login, user closes the
  browser tab, `claude` binary present but corrupted) — verify these
  empirically during implementation rather than assuming.
- Where exactly to link for "install the Claude Code CLI" — confirm the
  current official docs URL at implementation time rather than trusting
  one written into this spec, since install docs URLs can change.
