import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { LaunchAtLoginRow, DefaultDirectoryRow, usePreferences } from "../settings/PreferencesStep.js";
import { ConnectClaudeStep } from "../setup/ConnectClaudeStep.js";
import { PermissionsStep } from "../setup/PermissionsStep.js";
import { ShortcutsStep } from "../setup/ShortcutsStep.js";
import { DictationStep } from "../setup/DictationStep.js";
import { Logo } from "../../shared/icons.js";

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

// Each section loads its own data, at different speeds. The page stays
// hidden until all of them are ready, so it appears once instead of filling
// in row by row; after REVEAL_WAIT_MS it shows regardless, with any section
// still loading holding its shape.
const SECTIONS = ["claude", "permissions", "shortcuts", "dictation"];
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
