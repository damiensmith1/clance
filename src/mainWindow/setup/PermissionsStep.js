import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";
import { StatusCard } from "../components/StatusCard.js";

export function PermissionsStep({ onComplete } = {}) {
  const [status, setStatus] = useState(null);
  // The restart hint only appears once the user has actually been sent to
  // System Settings — before that it would just be noise.
  const [openedScreenSettings, setOpenedScreenSettings] = useState(false);

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
    return html`<p class="empty-note">Checking…</p>`;
  }

  // Accessibility is the only hard requirement — it's what lets Clance type
  // and click for you. Screen Recording is optional (see setupStatus.ts).
  const canContinue = status.accessibility;

  if (!onComplete) {
    return html`
      <${StatusCard}
        ok=${status.screenRecording}
        title="Screen Recording (optional)"
        description=${status.screenRecording
          ? "Clance can read your screen when a session asks to."
          : "Off. Sessions can't look at your screen — everything else works."}
        actionLabel=${status.screenRecording ? null : "Grant Access"}
        onAction=${() => window.clanceApp.requestScreenRecordingAccess()}
      />
      <${StatusCard}
        ok=${status.accessibility}
        title="Accessibility"
        description="Required for Clance to type, click, or edit fields on your behalf."
        actionLabel=${status.accessibility ? null : "Grant Access"}
        onAction=${() => window.clanceApp.openAccessibilitySettings()}
      />
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Grant permissions</h2>
      <p>
        Clance needs Accessibility to type and click on your behalf. Screen Recording is
        optional — without it, everything works except letting a session look at your screen.
      </p>
      <${StatusCard}
        ok=${status.accessibility}
        title="Accessibility"
        description="Lets Clance type, click, or edit fields in other apps on your behalf."
        actionLabel=${status.accessibility ? null : "Open Settings"}
        onAction=${() => window.clanceApp.openAccessibilitySettings()}
      />
      <${StatusCard}
        ok=${status.screenRecording}
        title="Screen Recording (optional)"
        description="Lets a session look at your screen when it needs to."
        actionLabel=${status.screenRecording ? null : "Open Settings"}
        onAction=${() => {
          setOpenedScreenSettings(true);
          window.clanceApp.requestScreenRecordingAccess();
        }}
      />
      ${!status.screenRecording && openedScreenSettings
        ? html`
            <p class="setup-hint">
              Already switched it on? macOS only applies Screen Recording after Clance
              restarts.
              <button class="btn-link" onClick=${() => window.clanceApp.relaunchApp()}>
                Restart Clance
              </button>
            </p>
          `
        : null}
      <div class="setup-step-actions">
        <button class="btn-secondary" onClick=${refresh}>Recheck</button>
        ${canContinue &&
        onComplete &&
        html`<button onClick=${onComplete}>
          ${status.screenRecording ? "Continue" : "Continue without Screen Recording"}
        </button>`}
      </div>
    </div>
  `;
}
