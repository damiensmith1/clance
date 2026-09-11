import { html } from "../../shared/vendor/preact-htm-standalone.module.js";
import { LaunchAtLoginRow, DefaultDirectoryRow, usePreferences } from "../settings/PreferencesStep.js";
import { ConnectClaudeStep } from "../setup/ConnectClaudeStep.js";
import { PermissionsStep } from "../setup/PermissionsStep.js";
import { ShortcutsStep } from "../setup/ShortcutsStep.js";

export function SettingsSection() {
  const [prefs, setPrefs] = usePreferences();

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

      <footer class="settings-footer">
        <span>Clance v0.1.0 · Built for macOS</span>
        <span class="btn-link">Check for Updates</span>
      </footer>
    </div>
  `;
}
