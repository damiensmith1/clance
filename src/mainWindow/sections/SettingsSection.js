import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import {
  LaunchAtLoginRow,
  DefaultDirectoryRow,
  AssistantDeciderRow,
  usePreferences,
} from "../settings/PreferencesStep.js";
import { ConnectClaudeStep } from "../setup/ConnectClaudeStep.js";
import { PermissionsStep } from "../setup/PermissionsStep.js";
import { ShortcutsStep } from "../setup/ShortcutsStep.js";
import { DictationStep } from "../setup/DictationStep.js";
import { Logo } from "../../shared/icons.js";
import { Toggle } from "../components/Toggle.js";

// Reports whether a newer release exists and hands the user the Homebrew
// command to install it; see src/main/updates.ts for why Clance doesn't
// install updates itself.
function UpdateCheck() {
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  function runCheck() {
    setChecking(true);
    setCopied(false);
    window.clanceApp
      .checkForUpdates()
      .then(setCheck)
      .finally(() => setChecking(false));
  }

  function copyCommand() {
    navigator.clipboard.writeText(check.command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (checking) {
    return html`<span class="update-check">checking…</span>`;
  }
  if (check?.status === "available") {
    return html`
      <span class="update-check">
        <span class="update-available">${`clance ${check.latest} available`}</span>
        <code class="update-command">${check.command}</code>
        <button class="btn-secondary btn-small" onClick=${copyCommand}>${copied ? "Copied" : "Copy"}</button>
        <button class="btn-quiet btn-small" onClick=${() => window.clanceApp.openReleasePage(check.releaseUrl)}>
          Release notes
        </button>
      </span>
    `;
  }
  if (check?.status === "up-to-date") {
    return html`
      <span class="update-check">
        <span>up to date</span>
        <button class="btn-quiet btn-small" onClick=${runCheck}>Check again</button>
      </span>
    `;
  }
  if (check?.status === "error") {
    return html`
      <span class="update-check">
        <span>${check.message}</span>
        <button class="btn-quiet btn-small" onClick=${runCheck}>Try again</button>
      </span>
    `;
  }
  return html`<button class="btn-quiet btn-small" onClick=${runCheck}>Check for updates</button>`;
}

// Clance's local tools (screen, selection, typing, clicking) and the MCP server
// that gives them to sessions (localToolsServer.ts). Collapsed by default: one
// summary row, expanding to the server's health check and a switch per tool.
function ClanceToolsGroup({ onReady }) {
  const [tools, setTools] = useState(null);
  const [status, setStatus] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    window.clanceApp.listLocalTools().then((list) => {
      setTools(list);
      onReady?.();
    });
    window.clanceApp.localToolsServerStatus().then(setStatus);
  }, []);

  // The check starts the server if it wasn't running (see
  // checkLocalToolsServerHealth), so status is read again afterwards.
  function checkHealth() {
    setChecking(true);
    setHealth(null);
    window.clanceApp.checkLocalToolsServerHealth().then((result) => {
      setHealth(result);
      setChecking(false);
      window.clanceApp.localToolsServerStatus().then(setStatus);
    });
  }

  // Optimistic, then reconciled with what the main process saved.
  function toggleTool(name, enabled) {
    setTools((current) => current.map((tool) => (tool.name === name ? { ...tool, enabled } : tool)));
    window.clanceApp.setLocalToolEnabled(name, enabled).then(setTools);
  }

  function dismissPortChange() {
    window.clanceApp.dismissLocalToolsPortChange().then(setStatus);
  }

  const enabledCount = tools ? tools.filter((t) => t.enabled).length : 0;
  const host = status?.url ? status.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null;

  return html`
    ${status?.portChange &&
    html`
      <div class="notice notice-attention">
        <span class="status-dot session-dot-attention"></span>
        <span class="notice-body">
          <span class="notice-title">Local tools moved to a new port</span>
          <span class="notice-text">
            Another app was using port ${status.portChange.from}, so Clance switched to ${status.portChange.to}.
            Sessions started before the switch no longer have local tools; start a new session to use them.
          </span>
        </span>
        <button class="btn-secondary btn-small" onClick=${dismissPortChange}>Dismiss</button>
      </div>
    `}
    <div class="preference-row">
      <div>
        <div class="preference-title">Local tools</div>
        <div class="preference-description">
          ${tools
            ? `Let sessions see your screen and type or click for you. ${enabledCount} of ${tools.length} on.`
            : "Let sessions see your screen and type or click for you."}
        </div>
      </div>
      <div class="preference-row-actions">
        <span class="status-card-status ${status?.running ? "status-card-status-ok" : ""}">
          ${status === null ? "" : status.running ? "running" : "not running"}
        </span>
        <button class="btn-secondary btn-small" aria-expanded=${expanded} onClick=${() => setExpanded(!expanded)}>
          ${expanded ? "Hide" : "Show"}
        </button>
      </div>
    </div>
    ${expanded &&
    html`
      <div class="clance-tools-detail">
        <div class="tool-server">
          <span class="status-dot ${status?.running ? "status-dot-ok" : ""}"></span>
          <span class="tool-server-text">${status?.running ? "Local tools server is running" : "Local tools server isn't running"}</span>
          ${host && html`<span class="mono-label">${host}</span>`}
          <span class="tool-server-spacer"></span>
          ${health &&
          html`<span class="status status-plain ${health.ok ? "status-ok" : "status-danger"}">${health.detail.toLowerCase()}</span>`}
          <button class="btn-quiet btn-small" onClick=${checkHealth} disabled=${checking}>
            ${checking ? "Checking…" : "Check"}
          </button>
        </div>
        <div class="tool-list">
          ${(tools ?? []).map(
            (tool) => html`
              <div class="tool-row" key=${tool.name}>
                <div class="tool-row-main">
                  <span class="tool-row-name">${tool.name}</span>
                  <span class="tool-row-description">${tool.description}</span>
                </div>
                <span class="tool-row-tag ${tool.tier === "auto" ? "" : "tool-row-tag-attention"}">
                  ${tool.tier === "auto" ? "no prompt" : "asks first"}
                </span>
                <${Toggle} checked=${tool.enabled} label=${tool.name} onChange=${(on) => toggleTool(tool.name, on)} />
              </div>
            `
          )}
        </div>
        <p class="section-note">
          Tools only reach sessions while Accessibility is granted. Off means sessions can't use a tool at all;
          "asks first" tools still need your OK the first time in each session.
        </p>
      </div>
    `}
  `;
}

// Each section loads its own data, at different speeds. The page stays
// hidden until all of them are ready, so it appears once instead of filling
// in row by row; after REVEAL_WAIT_MS it shows regardless, with any section
// still loading holding its shape.
const SECTIONS = ["claude", "permissions", "tools", "shortcuts", "dictation"];
const REVEAL_WAIT_MS = 1000;

export function SettingsSection() {
  const [prefs, setPrefs] = usePreferences();
  const [version, setVersion] = useState(null);
  const [readySections, setReadySections] = useState([]);
  const [waitedLongEnough, setWaitedLongEnough] = useState(false);

  useEffect(() => {
    window.clanceApp.getAppVersion().then(setVersion);
    const timer = setTimeout(() => setWaitedLongEnough(true), REVEAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  function ready(id) {
    return () => setReadySections((current) => (current.includes(id) ? current : [...current, id]));
  }

  const revealed = waitedLongEnough || (prefs && SECTIONS.every((id) => readySections.includes(id)));

  return html`
    <div class="section-page ${revealed ? "" : "settings-pending"}">
      <header class="page-header">
        <h1 class="page-title">Settings</h1>
      </header>

      <section class="extension-group">
        <h2 class="group-title">access</h2>
        <${ConnectClaudeStep} onReady=${ready("claude")} />
        <${PermissionsStep} onReady=${ready("permissions")} />
      </section>

      <section class="extension-group">
        <h2 class="group-title">clance tools</h2>
        <${ClanceToolsGroup} onReady=${ready("tools")} />
      </section>

      <section class="extension-group">
        <h2 class="group-title">general</h2>
        <${LaunchAtLoginRow} prefs=${prefs} setPrefs=${setPrefs} />
        <${DefaultDirectoryRow} prefs=${prefs} setPrefs=${setPrefs} />
      </section>

      <section class="extension-group">
        <h2 class="group-title">shortcuts</h2>
        <${ShortcutsStep} onReady=${ready("shortcuts")} />
      </section>

      <section class="extension-group">
        <h2 class="group-title">dictation</h2>
        <${DictationStep} onReady=${ready("dictation")} />
      </section>

      <section class="extension-group">
        <h2 class="group-title">assistant</h2>
        <${AssistantDeciderRow} prefs=${prefs} setPrefs=${setPrefs} />
      </section>

      <footer class="settings-footer">
        <span class="settings-footer-brand">
          ${Logo(14)}
          <span>${version ? `clance ${version}` : "clance"}</span>
        </span>
        <${UpdateCheck} />
      </footer>
    </div>
  `;
}
