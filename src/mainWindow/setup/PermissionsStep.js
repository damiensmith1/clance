import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";
import { StatusCard } from "../components/StatusCard.js";

export function PermissionsStep({ onComplete } = {}) {
  const [status, setStatus] = useState(null);

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

  const bothGranted = status.screenRecording && status.accessibility;

  if (!onComplete) {
    return html`
      <${StatusCard}
        ok=${status.screenRecording}
        title="Screen Recording"
        description="Required so Clance can read on-screen context when invoked."
        actionLabel=${status.screenRecording ? null : "Grant Access"}
        onAction=${() => window.clanceApp.openScreenRecordingSettings()}
      />
      <${StatusCard}
        ok=${status.accessibility}
        title="Accessibility"
        description="Required for Clance to type or act on your behalf."
        actionLabel=${status.accessibility ? null : "Grant Access"}
        onAction=${() => window.clanceApp.openAccessibilitySettings()}
      />
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Grant permissions</h2>
      <div class="permission-row">
        <span>Screen Recording</span>
        <span>${status.screenRecording ? "Granted" : "Not granted"}</span>
        ${!status.screenRecording &&
        html`<button onClick=${() => window.clanceApp.openScreenRecordingSettings()}>
          Open Settings
        </button>`}
      </div>
      <div class="permission-row">
        <span>Accessibility</span>
        <span>${status.accessibility ? "Granted" : "Not granted"}</span>
        ${!status.accessibility &&
        html`<button onClick=${() => window.clanceApp.openAccessibilitySettings()}>
          Open Settings
        </button>`}
      </div>
      <button onClick=${refresh}>Recheck</button>
      ${bothGranted && onComplete && html`<button onClick=${onComplete}>Continue</button>`}
    </div>
  `;
}
