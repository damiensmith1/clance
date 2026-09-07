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
