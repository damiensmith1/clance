---
title: App Shell — Design
tags: [clance, design, superpowers-spec]
status: approved
---

# App Shell — Design

## Overview

Clance currently exists only as a menu-bar tray icon plus a hotkey-triggered 
popup (`src/main/popupWindow.ts`, `src/popup/`). This spec adds a second,
persistent **main application window** — the foundation for the "feature
rich" product surface: chat history, settings, skills/plugins management,
and (eventually) theming.

This is sub-project **#1 of 5** in the main-application roadmap:

1. **App shell** (this spec) — window, navigation, theming infrastructure
2. Onboarding / auth setup flow
3. Chat history browser (Clance's own + Claude Code CLI sessions)
4. Settings
5. Extensibility management UI (skills/tools/MCP servers)

Sub-projects 2–5 each get their own spec once this one ships. This spec
builds the shell only: a real window with sidebar navigation between
placeholder sections, styled consistently with the popup's "liquid glass"
aesthetic, on a theming token system that can grow into multiple themes
later without a rewrite.

## Scope

**In scope:**

- A new main `BrowserWindow`, native-traffic-light custom chrome, vibrancy
  matching the app's visual identity
- Permanent Dock icon (replacing today's `app.dock?.hide()`)
- Standard `activate` (Dock-click-to-reopen) and Cmd+Q (quit everything)
  behavior
- A minimal macOS application menu (Edit/Window roles) — required for
  copy/paste/undo to work in any text input in the app
- Sidebar navigation between three placeholder sections: **Chats**,
  **Skills & Plugins**, **Settings**
- Preact + htm wired in as the UI layer for the main window only (the popup
  stays vanilla JS)
- A CSS custom-property theming token system capturing the current
  dark-glass look as named tokens, with exactly one token set shipped
- Directory reorganization: `src/renderer/` → `src/popup/`, new
  `src/mainWindow/` and `src/shared/`

**Explicitly out of scope (future sub-projects):**

- Real chat history data or rendering
- Real settings fields or persistence
- Real skills/plugins/MCP enable-toggle logic
- The onboarding/auth flow UI itself
- A light-mode token set or theme picker UI (infrastructure supports it;
  not built now)
- Refactoring the popup's own CSS onto the new theme tokens (optional
  future cleanup, not required for this shell to work)

## Architecture

### Process & window model

Same Electron process as the popup — no second app, no IPC between
processes. `src/main/mainWindow.ts` (parallel to `popupWindow.ts`) owns a
singleton `BrowserWindow`:

```ts
new BrowserWindow({
  width: 960,
  height: 640,
  minWidth: 720,
  minHeight: 480,
  titleBarStyle: "hiddenInset",  // native traffic lights over custom content
  vibrancy: "sidebar",           // distinct from the popup's "hud" material
  visualEffectState: "active",
  webPreferences: {
    preload: join(__dirname, "../preload/mainWindow.js"),
    contextIsolation: true,
    nodeIntegration: false,
  },
})
```

`titleBarStyle: "hiddenInset"` is the standard Electron pattern for
Arc/Notion-style windows: macOS still draws the native traffic-light
buttons, but the rest of the title bar area is available for custom
content (the sidebar can extend to the top edge).

`mainWindow.ts` exports a single `openMainWindow()` function (create the
window if it doesn't exist yet, otherwise focus the existing one) —
mirroring the existing `toggleClancePopup()` singleton pattern in
`popupWindow.ts`. Both `index.ts`'s `activate` handler and `tray.ts`'s new
menu item call this same function.

### Dock icon & lifecycle

- `app.dock?.show()` replaces `app.dock?.hide()` in `src/main/index.ts` —
  called unconditionally at startup. The popup's tray-only behavior is
  unaffected; this is additive.
- `app.on("activate", () => openMainWindow())` — clicking the Dock icon
  with no window open reopens the main window (standard macOS convention).
- Closing the main window (red traffic light) hides/destroys just that
  window; the tray and popup keep running exactly as today (the existing
  `app.on("window-all-closed", () => {})` no-op already covers this).
- **Cmd+Q now quits the entire app** (tray, popup, and main window). This
  is a behavior change from today (where there was no real "app" to quit)
  but matches user expectation once there's a Dock icon and menu bar.

### Application menu

`Menu.setApplicationMenu()` with a minimal template: an App menu (About,
Quit) and an Edit menu using Electron's built-in roles (`undo`, `redo`,
`cut`, `copy`, `paste`, `selectAll`). Without this, none of those shortcuts
work in any text input anywhere in the app — this is a real functional
requirement, not polish.

### Tray menu

The existing tray menu (`src/main/tray.ts`) gains a new item, e.g. "Open
Clance", that calls the same `openMainWindow()` used by `activate`. The
existing "Open Clance" popup-toggle item and hotkey are unchanged and
remain independent of the main window.

## Code organization

```
src/
  main/
    index.ts
    tray.ts
    hotkey.ts
    popupWindow.ts
    mainWindow.ts          # new
    agent.ts
    screenCapture.ts
    paths.ts
  preload/
    popup.ts               # renamed from index.ts for clarity
    mainWindow.ts           # new — separate preload, separate API surface
  popup/                    # renamed from renderer/
    popup.html
    popup.js
    markdown.js
  mainWindow/               # new
    index.html
    app.js                  # root component, sidebar, section switcher
    sections/
      ChatsSection.js
      SkillsSection.js
      SettingsSection.js
  shared/                   # new
    theme.css
    vendor/
      preact-htm-standalone.module.js
```

Renaming `src/renderer/` → `src/popup/` and `src/preload/index.ts` →
`src/preload/popup.ts` is a small, mechanical rename now that there are two
renderer surfaces — keeping the generic old names would make the two
preload scripts and two renderer directories ambiguous.

## Preact + htm integration

`htm` publishes a `htm/preact/standalone` build — a single self-contained
ES module (no imports of its own) bundling Preact core, all the hooks, and
htm's tagged-template JSX-like syntax together, pre-bound as one `html`
helper. This is vendored as one file,
`src/shared/vendor/preact-htm-standalone.module.js`, rather than a CDN
`<script>` — a CDN tag would require network access just to launch the
app, breaking the project's local-first principle (the only network call
is meant to be the Claude API request itself). The file is ~13KB and loads
directly in Chromium via `<script type="module">`; no bundler or JSX
transform step is introduced.

(The naive alternative — vendoring `preact.module.js` and
`hooks.module.js` as separate files — doesn't work standalone: Preact's
hooks module imports its core via the bare specifier `import ... from
"preact"`, which only resolves inside a `node_modules`-aware toolchain or
behind an import map. The `htm/preact/standalone` build avoids this
entirely by having no imports at all, which is simpler than adding an
import map for a two-file split.)

```js
import { h, html, render, useState } from "../shared/vendor/preact-htm-standalone.module.js";

function App() {
  const [section, setSection] = useState("chats");
  return html`
    <div class="shell">
      <nav class="sidebar">
        <button onClick=${() => setSection("chats")}>Chats</button>
        <button onClick=${() => setSection("skills")}>Skills & Plugins</button>
        <button onClick=${() => setSection("settings")}>Settings</button>
      </nav>
      <main>${renderSection(section)}</main>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
```

## Navigation

No router library. `App`'s `useState` holds the active section id; sidebar
buttons call `setSection(id)`; the main content area renders whichever
section component matches. At 3–5 sections this is simpler and more
transparent than introducing routing, and matches the project's
minimal-dependency posture.

Each section component (`ChatsSection`, `SkillsSection`, `SettingsSection`)
is a stub for this spec — e.g. a centered "Chats — coming soon" message —
so the real navigation shell, chrome, and theming can be verified
end-to-end before any of sub-projects #2–5 build real content into them.

## Theming tokens

`src/shared/theme.css` defines the current dark-glass palette as named CSS
custom properties on `:root`, e.g.:

```css
:root {
  --surface-bg: rgba(255, 255, 255, 0.04);
  --surface-border: rgba(255, 255, 255, 0.14);
  --text-primary: rgba(255, 255, 255, 0.95);
  --text-secondary: rgba(255, 255, 255, 0.55);
  --radius-lg: 20px;
  --radius-md: 8px;
}
```

Only this one token set ships now. A future light theme is just a second
block gated on `:root[data-theme="light"]` — no structural change needed
when that's built. `src/mainWindow/` consumes these tokens; the popup's own
CSS is left as-is (its hardcoded values already match this palette) unless
a future cleanup pass migrates it too.

## Testing approach

No behavioral test framework exists in this project yet (matches its
current state — verification has been manual/scripted-CDP so far). For
this shell:

- `npm run build` must compile cleanly (TypeScript changes are limited to
  `mainWindow.ts`, the renamed preload file, and `index.ts`'s dock/menu/tray
  wiring).
- Manual verification: main window opens via Dock icon and tray menu item,
  shows the sidebar and three stub sections, traffic lights and vibrancy
  render correctly, Cmd+Q quits everything, closing the window leaves the
  tray/popup running.

## Open questions for later specs

- **Auth gating:** should the main window show an onboarding/auth overlay
  if the user hasn't connected their Claude plan yet, or is that a fully
  separate first-run window? Deferred to the onboarding/auth spec
  (sub-project #2) — this shell doesn't know or care about auth state.
- **Popup CSS → shared tokens:** worth doing eventually so the popup and
  main window can't visually drift apart, but not required for this spec.
