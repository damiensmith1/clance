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
