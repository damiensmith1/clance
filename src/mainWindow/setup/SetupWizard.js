import { h, html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { ConnectClaudeStep } from "./ConnectClaudeStep.js";
import { PermissionsStep } from "./PermissionsStep.js";
import { ShortcutsStep } from "./ShortcutsStep.js";
import { DictationStep } from "./DictationStep.js";
import { Logo } from "../../shared/icons.js";

// Dictation is last and optional: it never counts toward setup being
// complete (see setupStatus.ts), so it can be skipped, and someone who quits
// during it lands straight in the app next launch — it lives in Settings too.
const STEP_ORDER = ["claude", "permissions", "shortcuts", "dictation"];
const STEP_LABELS = { claude: "account", permissions: "permissions", shortcuts: "shortcuts", dictation: "dictation" };

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

  // ↩ presses the step's primary button, as its key hint says, unless the
  // user is typing or recording a shortcut.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== "Enter" || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
      if (e.target.closest?.("input, textarea, button, .shortcut-field")) return;
      const primary = document.querySelector(".setup-step-actions .btn-primary:not(:disabled)");
      if (!primary) return;
      e.preventDefault();
      primary.click();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const stepIndex = STEP_ORDER.indexOf(step);
  const goBack = stepIndex > 0 ? () => setStep(STEP_ORDER[stepIndex - 1]) : undefined;

  if (reloading) {
    return html`<div class="loading">Setting things up…</div>`;
  }

  return html`
    <div class="setup-wizard">
      <div class="setup-frame">
        <div class="setup-progress">
          ${Logo(22)}
          ${STEP_ORDER.map(
            (id, index) => html`
              <span
                class="setup-progress-step ${index === stepIndex
                  ? "setup-progress-step-current"
                  : index < stepIndex
                    ? "setup-progress-step-done"
                    : ""}"
                aria-current=${index === stepIndex ? "step" : undefined}
              >
                ${`0${index + 1} ${STEP_LABELS[id]}`}
              </span>
            `
          )}
        </div>
        ${step === "claude" && html`<${ConnectClaudeStep} onComplete=${advance} onBack=${goBack} />`}
        ${step === "permissions" && html`<${PermissionsStep} onComplete=${advance} onBack=${goBack} />`}
        ${step === "shortcuts" && html`<${ShortcutsStep} onComplete=${advance} onBack=${goBack} />`}
        ${step === "dictation" && html`<${DictationStep} onComplete=${advance} onBack=${goBack} />`}
      </div>
    </div>
  `;
}
