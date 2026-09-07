# Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-run setup wizard that gates all of Clance's
functionality (including global hotkey registration) behind three
sequential steps — connecting the user's Claude plan, granting macOS
permissions, and confirming keyboard shortcuts — with the same step
components reused permanently inside the Settings section afterward.

**Architecture:** Three small, independent main-process modules
(`claudeAuth.ts`, `permissions.ts`, `config.ts`+`shortcuts.ts`) are
aggregated by one `setupStatus.ts` module that is the single source of
truth for "is setup done" — both `index.ts`'s hotkey-gating logic and the
renderer's wizard-vs-shell fork read from it. The renderer gets three
step components (Preact) that are context-agnostic (used identically by
the wizard and by Settings), plus a small step-sequencing container.

**Tech Stack:** Same as App Shell — Electron main process (TypeScript),
Preact+htm renderer (no bundler), no test framework (verification via
`npm run build` + real launch checks over Chrome DevTools Protocol).

**Spec:** `docs/superpowers/specs/2026-09-06-setup-wizard-design.md`

## Global Constraints

- No CDN script tags, no bundler, no JSX transform — renderer code stays
  plain `<script type="module">`, matching the existing `src/mainWindow/`
  and `src/popup/` code.
- `.html`/`.css`/`.js` files under `src/` are never compiled by `tsc`
  (`tsconfig.json` has no `allowJs`) — they're copied to `dist/` by the
  `build` npm script's existing `cp -r src/mainWindow/. dist/mainWindow/`
  and `cp -r src/shared/. dist/shared/` steps, which already glob whole
  directories, so no build-script changes are needed anywhere in this plan.
- No test framework exists in this project. Verification is (a) `npm run
  build` compiling cleanly, and (b) real launch checks — either a small
  Node script requiring the compiled module directly (for main-process-only
  modules with no Electron API dependency), or driving the actual running
  app over Chrome DevTools Protocol and reading back real evaluated values
  (for anything involving IPC or rendered UI) — never "the process started
  with no console errors" alone, which does not prove behavior is correct.
- Auth and permission status are **never cached as a persisted "done"
  flag** — `checkClaudeAuth()` and `checkPermissions()` are live-checked on
  every call. Only the shortcuts step's chosen values, plus a
  `shortcutsConfigured` boolean, are persisted (there's no external system
  fact to check that step against, unlike the other two).
- Step components (`ConnectClaudeStep`, `PermissionsStep`,
  `ShortcutsStep`) must not know whether they're rendered inside the
  wizard or inside Settings — they take an optional `onComplete` callback
  and call it only if provided. Advancing to the next step is the
  wizard's job, never the step component's own.

---

### Task 1: Config store and shortcuts registry

**Files:**
- Create: `src/main/config.ts`
- Create: `src/main/shortcuts.ts`

**Interfaces:**
- Produces: `ClanceConfig` type, `readConfig(): ClanceConfig`,
  `writeConfig(config: ClanceConfig): void` from `config.ts`.
- Produces: `ShortcutAction` type, `SHORTCUT_ACTIONS: ShortcutAction[]`
  from `shortcuts.ts`.
- Consumed by: Task 4 (`setupStatus.ts`, `index.ts`), Task 5
  (`ShortcutsStep.js` via IPC).

- [ ] **Step 1: Write `src/main/config.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

export type ClanceConfig = {
  shortcuts: Record<string, string>;
  shortcutsConfigured: boolean;
};

const CONFIG_PATH = join(SESSION_CWD, "config.json");

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space" },
  shortcutsConfigured: false,
};

export function readConfig(): ClanceConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(config: ClanceConfig): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}
```

This reuses `SESSION_CWD` (`~/.clance/`) from the existing `src/main/paths.ts`
— the same directory the popup's session-id file already lives in — rather
than inventing a second config directory.

- [ ] **Step 2: Write `src/main/shortcuts.ts`**

```ts
export type ShortcutAction = {
  id: string;
  label: string;
  defaultAccelerator: string;
};

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "togglePopup",
    label: "Open Clance popup",
    defaultAccelerator: "Alt+Space",
  },
];
```

Today this array has exactly one entry, matching the existing hardcoded
hotkey. A future feature needing its own shortcut adds an entry here — no
redesign of `ShortcutsStep.js` (Task 5) or the wizard is needed for that.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Verify the config round-trips correctly, without touching the real `~/.clance/config.json`**

```bash
# Back up any real config so this test can't clobber it
if [ -f ~/.clance/config.json ]; then cp ~/.clance/config.json /tmp/clance-config-backup.json; fi

node -e "
const { readConfig, writeConfig } = require('./dist/main/config.js');
const before = readConfig();
console.log('before:', JSON.stringify(before));
writeConfig({ shortcuts: { togglePopup: 'Cmd+Shift+K' }, shortcutsConfigured: true });
const after = readConfig();
console.log('after:', JSON.stringify(after));
if (after.shortcuts.togglePopup !== 'Cmd+Shift+K' || after.shortcutsConfigured !== true) {
  console.log('FAIL: round-trip did not persist correctly');
  process.exit(1);
}
console.log('PASS');
"

# Restore whatever was there before (or remove the test file if nothing was)
if [ -f /tmp/clance-config-backup.json ]; then
  cp /tmp/clance-config-backup.json ~/.clance/config.json
  rm /tmp/clance-config-backup.json
else
  rm -f ~/.clance/config.json
fi
```

Expected: `PASS` printed, and `~/.clance/config.json` restored to
whatever it was before this test ran (verify with `cat ~/.clance/config.json`
if one existed, or `ls ~/.clance/config.json` reporting "No such file" if
none did).

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts src/main/shortcuts.ts
git commit -m "feat: add local config store and shortcuts registry"
```

---

### Task 2: Claude CLI auth check module

**Files:**
- Create: `src/main/claudeAuth.ts`

**Interfaces:**
- Produces: `ClaudeAuthStatus` type (discriminated union),
  `checkClaudeAuth(): Promise<ClaudeAuthStatus>`,
  `connectClaude(): Promise<ClaudeAuthStatus>`,
  `openInstallDocs(): Promise<void>` — all consumed by Task 4
  (`setupStatus.ts`, `index.ts`'s IPC handlers).

- [ ] **Step 1: Write `src/main/claudeAuth.ts`**

```ts
import { execFile, spawn } from "child_process";
import { shell } from "electron";

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

function parseAuthStatusJson(parsed: {
  loggedIn?: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}): ClaudeAuthStatus {
  if (!parsed.loggedIn) {
    return { installed: true, loggedIn: false };
  }
  return {
    installed: true,
    loggedIn: true,
    email: parsed.email,
    organization: parsed.orgName,
    subscriptionType: parsed.subscriptionType,
  };
}

export function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "status", "--json"], (error, stdout) => {
      if (error && error.code === "ENOENT") {
        resolve({ installed: false });
        return;
      }
      try {
        resolve(parseAuthStatusJson(JSON.parse(stdout)));
      } catch {
        resolve({ installed: true, loggedIn: false });
      }
    });
  });
}

export function connectClaude(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["auth", "login"], { stdio: "ignore" });
    child.on("exit", () => {
      checkClaudeAuth().then(resolve);
    });
    child.on("error", () => {
      resolve({ installed: false });
    });
  });
}

export function openInstallDocs(): Promise<void> {
  return shell.openExternal("https://code.claude.com/docs/en/setup");
}
```

Note the `error.code === "ENOENT"` branch is checked first and returns
early; any other error (non-zero exit, etc.) falls through to parsing
`stdout` as JSON, since `claude auth status --json` still prints valid
JSON on a "not logged in" result (verified: it always exits reporting a
`loggedIn` field, never throws for that case) — only a missing binary
produces ENOENT.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Verify `checkClaudeAuth()` against the real, currently-installed CLI**

This machine already has `claude` installed and logged in — use that
real state as the test, rather than mocking it:

```bash
node -e "
const { checkClaudeAuth } = require('./dist/main/claudeAuth.js');
checkClaudeAuth().then((status) => {
  console.log(JSON.stringify(status));
  if (!status.installed) {
    console.log('FAIL: expected installed:true on this machine');
    process.exit(1);
  }
  console.log('PASS');
});
"
```

Expected: prints a status object with `installed: true`. If `loggedIn` is
also `true`, it should include `email`/`organization`/`subscriptionType`
fields — inspect the printed JSON to confirm these look sensible (not
`undefined` printed as a literal string, which would indicate a field
name mismatch against the real `claude auth status --json` output shape).

Do **not** run a verification step that calls `connectClaude()` here —
that spawns a real `claude auth login` and opens a real browser; it's
covered by manual verification in Task 4 instead, where it's actually
wired to a UI action a human can choose to click.

- [ ] **Step 4: Commit**

```bash
git add src/main/claudeAuth.ts
git commit -m "feat: add Claude CLI auth check module"
```

---

### Task 3: macOS permissions check module

**Files:**
- Create: `src/main/permissions.ts`

**Interfaces:**
- Produces: `PermissionsStatus` type, `checkPermissions():
  PermissionsStatus`, `openScreenRecordingSettings(): Promise<void>`,
  `openAccessibilitySettings(): Promise<void>` — consumed by Task 4.

- [ ] **Step 1: Write `src/main/permissions.ts`**

```ts
import { shell, systemPreferences } from "electron";

export type PermissionsStatus = {
  screenRecording: boolean;
  accessibility: boolean;
};

export function checkPermissions(): PermissionsStatus {
  return {
    screenRecording:
      systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

export function openScreenRecordingSettings(): Promise<void> {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  );
}

export function openAccessibilitySettings(): Promise<void> {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
}
```

`isTrustedAccessibilityClient(false)` — passing `false` means "check only,
don't trigger macOS's own native permission-request dialog"; Clance
drives the user to System Settings itself via the deep link instead.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Verify `checkPermissions()` runs and returns real values**

This calls real, side-effect-free macOS APIs — no mocking needed. Because
this module imports `electron`, it must run inside an Electron process,
not plain Node:

```bash
(./node_modules/.bin/electron -e "
const { checkPermissions } = require('./dist/main/permissions.js');
console.log(JSON.stringify(checkPermissions()));
process.exit(0);
" > /tmp/clance-permissions-check.log 2>&1 &)
sleep 2
cat /tmp/clance-permissions-check.log
```

Expected: a line of JSON like `{"screenRecording":false,"accessibility":false}`
(or `true` for either, depending on this machine's actual granted state) —
confirm it's valid JSON with both boolean fields present, not an error or
`undefined`.

- [ ] **Step 4: Commit**

```bash
git add src/main/permissions.ts
git commit -m "feat: add macOS permissions check module"
```

---

### Task 4: Setup status aggregator, main-process gating, and IPC surface

**Files:**
- Create: `src/main/setupStatus.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/mainWindow.ts`

**Interfaces:**
- Consumes: `checkClaudeAuth`/`connectClaude`/`openInstallDocs` (Task 2),
  `checkPermissions`/`openScreenRecordingSettings`/`openAccessibilitySettings`
  (Task 3), `readConfig`/`writeConfig` (Task 1), the existing
  `registerHotkey(onTrigger, accelerator?)` from `src/main/hotkey.ts`
  (unchanged — it already accepts a custom accelerator as its second,
  optional parameter, so no changes to `hotkey.ts` are needed in this
  plan).
- Produces: `SetupStatus` type, `getSetupStatus(): Promise<SetupStatus>`
  from `setupStatus.ts` — consumed by Task 5/6's renderer code via IPC.
  Produces the full `window.clanceApp` API surface on the renderer side
  (`getSetupStatus`, `connectClaude`, `recheckPermissions`,
  `openScreenRecordingSettings`, `openAccessibilitySettings`,
  `openInstallDocs`, `getShortcutActions`, `saveShortcuts`,
  `completeSetup`) — every later task's renderer code calls these exact
  method names.

- [ ] **Step 1: Write `src/main/setupStatus.ts`**

```ts
import { checkClaudeAuth, ClaudeAuthStatus } from "./claudeAuth";
import { checkPermissions, PermissionsStatus } from "./permissions";
import { readConfig } from "./config";

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

- [ ] **Step 2: Update `src/main/index.ts`**

Change the imports and startup block from:

```ts
import { app, ipcMain, Menu } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys } from "./hotkey";
import { toggleClancePopup } from "./popupWindow";
import { openMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { askClance } from "./agent";
import { captureActiveDisplay } from "./screenCapture";
import { ensureSessionCwd, readLastSessionId, writeLastSessionId } from "./paths";

app.dock?.show();

let currentSessionId: string | undefined;
let warnedAboutScreenCapture = false;

app.whenReady().then(() => {
  ensureSessionCwd();
  currentSessionId = readLastSessionId();

  Menu.setApplicationMenu(createAppMenu());
  createTray(toggleClancePopup, openMainWindow);
  registerHotkey(toggleClancePopup);
});

app.on("activate", openMainWindow);
```

to:

```ts
import { app, ipcMain, Menu } from "electron";
import { createTray } from "./tray";
import { registerHotkey, unregisterAllHotkeys } from "./hotkey";
import { toggleClancePopup } from "./popupWindow";
import { openMainWindow } from "./mainWindow";
import { createAppMenu } from "./appMenu";
import { askClance } from "./agent";
import { captureActiveDisplay } from "./screenCapture";
import { ensureSessionCwd, readLastSessionId, writeLastSessionId } from "./paths";
import { getSetupStatus } from "./setupStatus";
import { readConfig, writeConfig } from "./config";
import { connectClaude, openInstallDocs } from "./claudeAuth";
import {
  checkPermissions,
  openScreenRecordingSettings,
  openAccessibilitySettings,
} from "./permissions";
import { SHORTCUT_ACTIONS } from "./shortcuts";

app.dock?.show();

let currentSessionId: string | undefined;
let warnedAboutScreenCapture = false;

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

app.on("activate", openMainWindow);
```

Then add the new IPC handlers. Insert this block after the existing
`app.on("window-all-closed", () => {});` line and before the existing
`ipcMain.on("submit-goal", ...)` handler:

```ts
ipcMain.handle("setup:get-status", () => getSetupStatus());

ipcMain.handle("setup:connect-claude", () => connectClaude());

ipcMain.handle("setup:open-install-docs", () => openInstallDocs());

ipcMain.handle("setup:recheck-permissions", () => checkPermissions());

ipcMain.handle("setup:open-screen-recording-settings", () =>
  openScreenRecordingSettings()
);

ipcMain.handle("setup:open-accessibility-settings", () =>
  openAccessibilitySettings()
);

ipcMain.handle("setup:get-shortcut-actions", () => SHORTCUT_ACTIONS);

ipcMain.handle(
  "setup:save-shortcuts",
  (_event, shortcuts: Record<string, string>) => {
    const config = readConfig();
    config.shortcuts = { ...config.shortcuts, ...shortcuts };
    config.shortcutsConfigured = true;
    writeConfig(config);
    return config;
  }
);

ipcMain.handle("setup:complete", async () => {
  const status = await getSetupStatus();
  if (status.isComplete) {
    const config = readConfig();
    registerHotkey(toggleClancePopup, config.shortcuts.togglePopup);
  }
  return status;
});
```

The rest of `index.ts` (the `submit-goal` and `new-conversation` handlers)
is unchanged.

- [ ] **Step 3: Replace `src/preload/mainWindow.ts`**

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clanceApp", {
  getSetupStatus: () => ipcRenderer.invoke("setup:get-status"),
  connectClaude: () => ipcRenderer.invoke("setup:connect-claude"),
  openInstallDocs: () => ipcRenderer.invoke("setup:open-install-docs"),
  recheckPermissions: () => ipcRenderer.invoke("setup:recheck-permissions"),
  openScreenRecordingSettings: () =>
    ipcRenderer.invoke("setup:open-screen-recording-settings"),
  openAccessibilitySettings: () =>
    ipcRenderer.invoke("setup:open-accessibility-settings"),
  getShortcutActions: () => ipcRenderer.invoke("setup:get-shortcut-actions"),
  saveShortcuts: (shortcuts: Record<string, string>) =>
    ipcRenderer.invoke("setup:save-shortcuts", shortcuts),
  completeSetup: () => ipcRenderer.invoke("setup:complete"),
});
```

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Verify the IPC surface responds correctly, over real CDP**

The main window's renderer has no UI for this yet (that's Tasks 5-7), but
`window.clanceApp` is already live via the preload script, so it can be
exercised directly:

```bash
(./node_modules/.bin/electron --remote-debugging-port=9260 . > /tmp/clance-task4-verify.log 2>&1 &)
sleep 3
cat /tmp/clance-task4-verify.log
curl -s http://localhost:9260/json | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);j.forEach(t=>console.log(t.url, t.webSocketDebuggerUrl))})"
```

Since setup is not yet complete on a fresh machine (no `shortcutsConfigured`
persisted yet), `index.ts`'s gating should have opened the main window
automatically — confirm the printed target list includes a page ending in
`mainWindow/index.html` without needing to click the Dock icon or tray
item.

Connect to that page's `webSocketDebuggerUrl` and evaluate:

```js
window.clanceApp.getSetupStatus().then((s) => JSON.stringify(s))
```

Expected: a real `SetupStatus` object — `claude.installed` should be
`true` on this machine (matches Task 2's verification), and `isComplete`
should be `false` (since `shortcutsConfigured` defaults to `false` and
was reset by Task 1's verification cleanup).

Then evaluate:

```js
window.clanceApp.getShortcutActions().then((a) => JSON.stringify(a))
```

Expected: `[{"id":"togglePopup","label":"Open Clance popup","defaultAccelerator":"Alt+Space"}]`.

Then evaluate:

```js
window.clanceApp.saveShortcuts({ togglePopup: "Alt+Space" }).then((c) => JSON.stringify(c))
```

Expected: returns the updated config with `shortcutsConfigured: true`.
Re-run the `getSetupStatus()` evaluate above — `shortcutsConfigured` should
now read `true` (permissions will likely still be `false` on a fresh dev
machine, so `isComplete` may still be `false` overall — that's expected;
the point is confirming this one field changed).

Afterward, clean up so later tasks start from a clean state:

```bash
pkill -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ."
rm -f ~/.clance/config.json
```

- [ ] **Step 6: Commit**

```bash
git add src/main/setupStatus.ts src/main/index.ts src/preload/mainWindow.ts
git commit -m "feat: add setup status aggregator, gating, and IPC surface"
```

---

### Task 5: The three step components

**Files:**
- Create: `src/mainWindow/setup/ConnectClaudeStep.js`
- Create: `src/mainWindow/setup/PermissionsStep.js`
- Create: `src/mainWindow/setup/ShortcutsStep.js`
- Modify: `src/mainWindow/index.html` (add CSS for the new components)

**Interfaces:**
- Consumes: `window.clanceApp.*` methods from Task 4.
- Produces: `ConnectClaudeStep`, `PermissionsStep`, `ShortcutsStep` —
  each a Preact function component taking an optional `{ onComplete }`
  prop and calling `onComplete()` only if it was provided, never assuming
  a parent context. Consumed by Task 6 (`SetupWizard.js`) and Task 7
  (`SettingsSection.js`).

- [ ] **Step 1: Write `src/mainWindow/setup/ConnectClaudeStep.js`**

```js
import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

export function ConnectClaudeStep({ onComplete } = {}) {
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);

  function refresh() {
    return window.clanceApp.getSetupStatus().then((full) => {
      setStatus(full.claude);
      return full;
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleConnect() {
    setConnecting(true);
    window.clanceApp.connectClaude().then(() => {
      setConnecting(false);
      refresh().then((full) => {
        if (full.claude.installed && full.claude.loggedIn && onComplete) {
          onComplete();
        }
      });
    });
  }

  if (status === null) {
    return html`<div class="setup-step"><p>Checking…</p></div>`;
  }

  if (!status.installed) {
    return html`
      <div class="setup-step">
        <h2>Connect your Claude plan</h2>
        <p>
          Clance uses the Claude Code CLI to talk to Claude, and it looks
          like it isn't installed yet.
        </p>
        <button onClick=${() => window.clanceApp.openInstallDocs()}>
          See install instructions
        </button>
        <button onClick=${refresh}>I've installed it</button>
      </div>
    `;
  }

  if (!status.loggedIn) {
    return html`
      <div class="setup-step">
        <h2>Connect your Claude plan</h2>
        <p>Claude Code is installed. Click below to sign in — this opens your browser.</p>
        <button onClick=${handleConnect} disabled=${connecting}>
          ${connecting ? "Connecting…" : "Connect"}
        </button>
      </div>
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Connect your Claude plan</h2>
      <p>
        Connected as ${status.email ?? "your account"}${status.subscriptionType
          ? ` · ${status.subscriptionType} plan`
          : ""}.
      </p>
      ${onComplete && html`<button onClick=${onComplete}>Continue</button>`}
    </div>
  `;
}
```

- [ ] **Step 2: Write `src/mainWindow/setup/PermissionsStep.js`**

```js
import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

export function PermissionsStep({ onComplete } = {}) {
  const [status, setStatus] = useState(null);

  function refresh() {
    return window.clanceApp.recheckPermissions().then((s) => {
      setStatus(s);
      return s;
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  if (status === null) {
    return html`<div class="setup-step"><p>Checking…</p></div>`;
  }

  const bothGranted = status.screenRecording && status.accessibility;

  return html`
    <div class="setup-step">
      <h2>Grant permissions</h2>
      <div class="permission-row">
        <span>Screen Recording</span>
        <span>${status.screenRecording ? "Granted" : "Not granted"}</span>
        ${!status.screenRecording &&
        html`<button onClick=${() => window.clanceApp.openScreenRecordingSettings()}>
          Open Settings
        </button>`}
      </div>
      <div class="permission-row">
        <span>Accessibility</span>
        <span>${status.accessibility ? "Granted" : "Not granted"}</span>
        ${!status.accessibility &&
        html`<button onClick=${() => window.clanceApp.openAccessibilitySettings()}>
          Open Settings
        </button>`}
      </div>
      <button onClick=${refresh}>Recheck</button>
      ${bothGranted && onComplete && html`<button onClick=${onComplete}>Continue</button>`}
    </div>
  `;
}
```

- [ ] **Step 3: Write `src/mainWindow/setup/ShortcutsStep.js`**

This step uses a plain text field for the accelerator string (e.g.
"Alt+Space") rather than a press-to-record key-capture UI — a deliberate
v1 simplification; only one action exists to bind today, and building a
key-capture widget is a meaningfully larger UI investment than this
feature currently justifies.

```js
import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

export function ShortcutsStep({ onComplete } = {}) {
  const [actions, setActions] = useState(null);
  const [values, setValues] = useState({});

  useEffect(() => {
    window.clanceApp.getShortcutActions().then((list) => {
      setActions(list);
      const initial = {};
      for (const action of list) {
        initial[action.id] = action.defaultAccelerator;
      }
      setValues(initial);
    });
  }, []);

  function handleSave() {
    window.clanceApp.saveShortcuts(values).then(() => {
      if (onComplete) onComplete();
    });
  }

  if (actions === null) {
    return html`<div class="setup-step"><p>Loading…</p></div>`;
  }

  return html`
    <div class="setup-step">
      <h2>Set your shortcuts</h2>
      ${actions.map(
        (action) => html`
          <div class="shortcut-row">
            <label>${action.label}</label>
            <input
              type="text"
              value=${values[action.id] ?? ""}
              onInput=${(e) =>
                setValues({ ...values, [action.id]: e.target.value })}
            />
          </div>
        `
      )}
      <button onClick=${handleSave}>Save and continue</button>
    </div>
  `;
}
```

- [ ] **Step 4: Add CSS for the new components**

In `src/mainWindow/index.html`, add this block right after the existing
`.section-placeholder p { color: var(--text-secondary); }` rule (still
inside the same `<style>` tag):

```css
.setup-wizard {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  padding: 32px;
  box-sizing: border-box;
}
.setup-step {
  max-width: 420px;
  text-align: center;
}
.setup-step h2 {
  margin: 0 0 12px;
  color: var(--text-primary);
}
.setup-step p {
  color: var(--text-secondary);
  margin: 0 0 16px;
}
.setup-step button {
  background: var(--surface-active);
  color: var(--text-primary);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md);
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  margin: 4px;
  font-family: inherit;
}
.permission-row,
.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--surface-border);
  text-align: left;
}
.shortcut-row input {
  background: var(--surface-bg);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  padding: 4px 8px;
  font-size: 13px;
  font-family: inherit;
}
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: var(--text-secondary);
}
```

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: no TypeScript errors (these are plain `.js`/`.html` files, so
this mainly confirms nothing else broke).

- [ ] **Step 6: Verify each component renders and behaves correctly in isolation**

Since `SetupWizard`/`app.js` don't import these components yet, verify
each one by dynamically importing and mounting it directly inside the
real running app's main window over CDP, rather than building a
standalone test harness — a standalone page would have no
`window.clanceApp` (it only exists via the real preload script), and
these components depend on it from the moment they mount.

```bash
(./node_modules/.bin/electron --remote-debugging-port=9261 . > /tmp/clance-task5-verify.log 2>&1 &)
sleep 3
cat /tmp/clance-task5-verify.log
curl -s http://localhost:9261/json
```

Connect to the `mainWindow/index.html` page's `webSocketDebuggerUrl` (the
window should have auto-opened since setup is still incomplete) and
evaluate, one component at a time:

```js
import("./setup/ConnectClaudeStep.js").then(async (m) => {
  const { render, h } = await import("../shared/vendor/preact-htm-standalone.module.js");
  render(h(m.ConnectClaudeStep, {}), document.getElementById("root"));
});
```

Wait ~500ms for the async status check, then evaluate
`document.body.innerText` — expected to contain "Connect your Claude
plan" and, since this machine has `claude` installed and logged in,
either "Connect" (if the step's own status check somehow reports
logged-out) or "Connected as" followed by whatever email
`checkClaudeAuth()` reported in Task 2's verification (do not hardcode a
specific email in this check — read it back from the same account info
Task 2 already confirmed). Repeat the same
dynamic-import-and-render pattern for `PermissionsStep` (expect to see
"Grant permissions", "Screen Recording", "Accessibility", and their
granted/not-granted state) and `ShortcutsStep` (expect "Set your
shortcuts" and an input pre-filled with "Alt+Space").

For `ShortcutsStep`, also verify the save path: evaluate
`document.querySelector('.shortcut-row input').value = "Cmd+Shift+K"` then
dispatch an `input` event on it
(`document.querySelector('.shortcut-row input').dispatchEvent(new Event('input', { bubbles: true }))`),
then click save
(`document.querySelector('.setup-step button:last-child').click()`), then
confirm via `window.clanceApp.getSetupStatus().then(s => JSON.stringify(s))`
that `shortcutsConfigured` is now `true`. Clean up afterward:

```bash
pkill -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ."
rm -f ~/.clance/config.json
```

- [ ] **Step 7: Commit**

```bash
git add src/mainWindow/setup/ src/mainWindow/index.html
git commit -m "feat: add setup wizard step components"
```

---

### Task 6: Wizard shell — Shell extraction, SetupWizard, and app.js fork

**Files:**
- Create: `src/mainWindow/Shell.js`
- Create: `src/mainWindow/setup/SetupWizard.js`
- Modify: `src/mainWindow/app.js`

**Interfaces:**
- Consumes: `ConnectClaudeStep`/`PermissionsStep`/`ShortcutsStep` (Task
  5), `window.clanceApp.getSetupStatus`/`completeSetup` (Task 4).
- Produces: `Shell` component (extracted, unchanged behavior from
  today's sidebar/content markup) and `SetupWizard` component — both
  consumed only by `app.js`, not by any later task.

- [ ] **Step 1: Create `src/mainWindow/Shell.js` with the extracted sidebar/content markup**

```js
import { h, html, useState } from "../shared/vendor/preact-htm-standalone.module.js";
import { ChatsSection } from "./sections/ChatsSection.js";
import { SkillsSection } from "./sections/SkillsSection.js";
import { SettingsSection } from "./sections/SettingsSection.js";

const SECTIONS = {
  chats: { label: "Chats", Component: ChatsSection },
  skills: { label: "Skills & Plugins", Component: SkillsSection },
  settings: { label: "Settings", Component: SettingsSection },
};

export function Shell() {
  const [sectionId, setSectionId] = useState("chats");
  const ActiveSection = SECTIONS[sectionId].Component;

  return html`
    <div class="shell">
      <nav class="sidebar">
        ${Object.entries(SECTIONS).map(
          ([id, { label }]) => html`
            <button
              class=${id === sectionId ? "active" : ""}
              onClick=${() => setSectionId(id)}
            >
              ${label}
            </button>
          `
        )}
      </nav>
      <main class="content">
        <${ActiveSection} />
      </main>
    </div>
  `;
}
```

This is the exact markup and logic that lived directly in `app.js`'s
`App` function before this task — only the function name changed (`App`
→ `Shell`) and it moved to its own file.

- [ ] **Step 2: Create `src/mainWindow/setup/SetupWizard.js`**

```js
import { h, html, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { ConnectClaudeStep } from "./ConnectClaudeStep.js";
import { PermissionsStep } from "./PermissionsStep.js";
import { ShortcutsStep } from "./ShortcutsStep.js";

const STEP_ORDER = ["claude", "permissions", "shortcuts"];

function firstIncompleteStep(status) {
  if (!(status.claude.installed && status.claude.loggedIn)) return "claude";
  if (!(status.permissions.screenRecording && status.permissions.accessibility)) {
    return "permissions";
  }
  if (!status.shortcutsConfigured) return "shortcuts";
  return "claude"; // shouldn't happen if isComplete was already true
}

export function SetupWizard({ initialStatus }) {
  const [step, setStep] = useState(firstIncompleteStep(initialStatus));
  const [reloading, setReloading] = useState(false);

  function advance() {
    const currentIndex = STEP_ORDER.indexOf(step);
    const nextStep = STEP_ORDER[currentIndex + 1];
    if (nextStep) {
      setStep(nextStep);
      return;
    }
    setReloading(true);
    window.clanceApp.completeSetup().then(() => {
      window.location.reload();
    });
  }

  if (reloading) {
    return html`<div class="loading">Setting things up…</div>`;
  }

  return html`
    <div class="setup-wizard">
      ${step === "claude" && html`<${ConnectClaudeStep} onComplete=${advance} />`}
      ${step === "permissions" && html`<${PermissionsStep} onComplete=${advance} />`}
      ${step === "shortcuts" && html`<${ShortcutsStep} onComplete=${advance} />`}
    </div>
  `;
}
```

`window.location.reload()` after the last step is the simplest way to get
`app.js` to re-fetch status and switch to `Shell` — it re-runs the whole
mount cycle rather than needing a callback threaded up through `App`.

- [ ] **Step 3: Replace `src/mainWindow/app.js`**

```js
import { h, html, render, useState, useEffect } from "../shared/vendor/preact-htm-standalone.module.js";
import { Shell } from "./Shell.js";
import { SetupWizard } from "./setup/SetupWizard.js";

function App() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    window.clanceApp.getSetupStatus().then(setStatus);
  }, []);

  if (status === null) {
    return html`<div class="loading">Loading…</div>`;
  }
  if (!status.isComplete) {
    return html`<${SetupWizard} initialStatus=${status} />`;
  }
  return html`<${Shell} />`;
}

render(html`<${App} />`, document.getElementById("root"));
```

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Verify the full wizard-to-shell flow end to end, over real CDP**

```bash
rm -f ~/.clance/config.json  # ensure a clean "setup incomplete" starting state
(./node_modules/.bin/electron --remote-debugging-port=9262 . > /tmp/clance-task6-verify.log 2>&1 &)
sleep 3
cat /tmp/clance-task6-verify.log
curl -s http://localhost:9262/json
```

Confirm the main window auto-opened (setup incomplete) and connect to its
`webSocketDebuggerUrl`. Evaluate `document.body.innerText` — expected to
contain "Connect your Claude plan" (the wizard should have started on the
`claude` step, or skipped straight to `permissions` if this machine's
`claude` is already logged in — check which; either is correct behavior
depending on `getSetupStatus()`'s live result at that moment).

Drive the wizard forward by evaluating clicks on whatever step is showing
(same pattern as Task 5's manual verification) until you reach the
Shortcuts step, save the default shortcut, and confirm:
- `document.body.innerText` no longer shows any setup-step heading — it
  should show the real sidebar with "Chats"/"Skills & Plugins"/"Settings".
- `document.querySelectorAll('.sidebar button').length === 3` (same check
  the App Shell plan's Task 4 used) — proves `Shell` still works
  identically after extraction.

Also confirm — this is the actual gating requirement from the spec — that
before completing setup, the global hotkey was NOT registered. There's no
direct CDP check for `globalShortcut` state, so verify indirectly: check
`/tmp/clance-task6-verify.log` for the specific warning
`hotkey.ts` logs on failed registration (`Failed to register global
hotkey`) — it should NOT appear (since registration is skipped entirely,
not attempted and failed). Then, after completing setup in the same
running process, confirm no such warning appeared either (registration
should have succeeded silently) — the definitive proof is functional:
pressing the configured accelerator should now toggle the popup, but
since a real keypress can't be sent via CDP, accept the log-based
absence-of-error check plus the fact that `completeSetup`'s handler
(Task 4) was already verified to call `registerHotkey` when status is
complete.

```bash
pkill -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ."
rm -f ~/.clance/config.json
```

- [ ] **Step 6: Commit**

```bash
git add src/mainWindow/Shell.js src/mainWindow/setup/SetupWizard.js src/mainWindow/app.js
git commit -m "feat: wire setup wizard into main window, extract Shell"
```

---

### Task 7: Settings section shows real connection/permission/shortcut status

**Files:**
- Modify: `src/mainWindow/sections/SettingsSection.js`
- Modify: `src/mainWindow/index.html` (small CSS addition)

**Interfaces:**
- Consumes: `ConnectClaudeStep`/`PermissionsStep`/`ShortcutsStep` (Task
  5), rendered with no `onComplete` prop at all.
- Produces: nothing further downstream — this is the last task in this
  plan.

- [ ] **Step 1: Replace `src/mainWindow/sections/SettingsSection.js`**

```js
import { html } from "../../shared/vendor/preact-htm-standalone.module.js";
import { ConnectClaudeStep } from "../setup/ConnectClaudeStep.js";
import { PermissionsStep } from "../setup/PermissionsStep.js";
import { ShortcutsStep } from "../setup/ShortcutsStep.js";

export function SettingsSection() {
  return html`
    <div class="section-settings">
      <h2>Settings</h2>
      <${ConnectClaudeStep} />
      <${PermissionsStep} />
      <${ShortcutsStep} />
    </div>
  `;
}
```

None of the three step components receive an `onComplete` prop here —
per Task 5's contract, each one simply omits its "Continue" button in
that case and behaves as a standalone status/action panel.

- [ ] **Step 2: Add CSS for the Settings layout**

In `src/mainWindow/index.html`, change:

```css
      .section-placeholder h2 {
        margin: 0 0 8px;
        color: var(--text-primary);
      }
      .section-placeholder p {
        color: var(--text-secondary);
      }
```

to:

```css
      .section-placeholder h2,
      .section-settings h2 {
        margin: 0 0 8px;
        color: var(--text-primary);
      }
      .section-placeholder p {
        color: var(--text-secondary);
      }
      .section-settings .setup-step {
        max-width: none;
        text-align: left;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--surface-border);
      }
```

(The `.setup-step`/`.permission-row`/`.shortcut-row` rules Task 5 already
added still apply here; this just overrides the wizard's centered,
narrow-column layout with a left-aligned, full-width one appropriate for
a settings page.)

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Verify Settings shows real status and never tries to advance**

```bash
(./node_modules/.bin/electron --remote-debugging-port=9263 . > /tmp/clance-task7-verify.log 2>&1 &)
sleep 3
curl -s http://localhost:9263/json
```

Since setup is likely complete by now if you followed Task 6's
verification through to the end (or drive it to completion again if not
— same steps as Task 6), connect to the main window and evaluate clicks
on the "Settings" sidebar button, then check `document.body.innerText` —
expected to contain "Settings", "Connect your Claude plan" (or
"Connected as..."), "Grant permissions", and "Set your shortcuts" all on
the same page. Confirm there is no "Continue" button text anywhere in
`document.body.innerText` within the Settings section (query
`document.querySelector('.section-settings').innerText` specifically) —
proving the step components correctly suppressed their advance button
when no `onComplete` was passed.

```bash
pkill -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ."
```

- [ ] **Step 5: Commit**

```bash
git add src/mainWindow/sections/SettingsSection.js src/mainWindow/index.html
git commit -m "feat: show real connection, permission, and shortcut status in Settings"
```
