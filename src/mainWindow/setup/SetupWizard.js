import { h, html, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { ConnectClaudeStep } from "./ConnectClaudeStep.js";
import { PermissionsStep } from "./PermissionsStep.js";
import { ShortcutsStep } from "./ShortcutsStep.js";
import { DictationStep } from "./DictationStep.js";
import { Logo } from "../../shared/icons.js";

// Dictation is last and optional: it never counts toward setup being
// complete (see setupStatus.ts), so it can be skipped, and someone who quits
// during it lands straight in the app next launch — it lives in Settings too.
const STEP_ORDER = ["claude", "permissions", "shortcuts", "dictation"];

function firstIncompleteStep(status) {
  if (!(status.claude.installed && status.claude.loggedIn)) return "claude";
  // Accessibility only — Screen Recording is optional (see setupStatus.ts).
  if (!status.permissions.accessibility) {
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
      <div class="setup-frame">
        <span class="setup-logo">${Logo(44)}</span>
        ${step === "claude" && html`<${ConnectClaudeStep} onComplete=${advance} />`}
        ${step === "permissions" && html`<${PermissionsStep} onComplete=${advance} />`}
        ${step === "shortcuts" && html`<${ShortcutsStep} onComplete=${advance} />`}
        ${step === "dictation" && html`<${DictationStep} onComplete=${advance} />`}
      </div>
    </div>
  `;
}
