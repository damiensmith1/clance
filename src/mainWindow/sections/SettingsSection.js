import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { LaunchAtLoginRow, DefaultDirectoryRow, usePreferences } from "../settings/PreferencesStep.js";
import { ConnectClaudeStep } from "../setup/ConnectClaudeStep.js";
import { PermissionsStep } from "../setup/PermissionsStep.js";
import { ShortcutsStep } from "../setup/ShortcutsStep.js";
import { DictationStep } from "../setup/DictationStep.js";

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
    return html`<span class="update-check">Checking…</span>`;
  }
  if (check?.status === "available") {
    return html`
      <span class="update-check">
        <span class="update-available">${`Clance ${check.latest} is available`}</span>
        <code class="update-command">${check.command}</code>
        <button class="btn-link" onClick=${copyCommand}>${copied ? "Copied" : "Copy"}</button>
        <button class="btn-link" onClick=${() => window.clanceApp.openReleasePage(check.releaseUrl)}>
          Release notes
        </button>
      </span>
    `;
  }
  if (check?.status === "up-to-date") {
    return html`
      <span class="update-check">
        <span>You're on the latest version</span>
        <button class="btn-link" onClick=${runCheck}>Check again</button>
      </span>
    `;
  }
  if (check?.status === "error") {
    return html`
      <span class="update-check">
        <span>${check.message}</span>
        <button class="btn-link" onClick=${runCheck}>Try again</button>
      </span>
    `;
  }
  return html`<button class="btn-link" onClick=${runCheck}>Check for Updates</button>`;
}

export function SettingsSection() {
  const [prefs, setPrefs] = usePreferences();
  const [version, setVersion] = useState(null);

  useEffect(() => {
    window.clanceApp.getAppVersion().then(setVersion);
  }, []);

  return html`
    <div class="section-page">
      <h1 class="page-title">Settings</h1>
      <p class="page-subtitle">Configure your workspace and monitor system health.</p>

      <section class="extension-group">
        <h2 class="group-title">System Health</h2>
        <${ConnectClaudeStep} />
        <${PermissionsStep} />
      </section>

      <section class="extension-group">
        <h2 class="group-title">Preferences</h2>
        <${LaunchAtLoginRow} prefs=${prefs} setPrefs=${setPrefs} />
        <${DefaultDirectoryRow} prefs=${prefs} setPrefs=${setPrefs} />
        <${ShortcutsStep} />
      </section>

      <section class="extension-group">
        <h2 class="group-title">Dictation</h2>
        <${DictationStep} />
      </section>

      <footer class="settings-footer">
        <span>${version ? `Clance v${version} · Built for macOS` : "Clance · Built for macOS"}</span>
        <${UpdateCheck} />
      </footer>
    </div>
  `;
}
