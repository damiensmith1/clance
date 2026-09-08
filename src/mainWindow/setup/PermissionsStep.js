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
        onAction=${() => window.clanceApp.requestScreenRecordingAccess()}
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
      <p>Clance needs a couple of macOS permissions to read your screen and act on your behalf.</p>
      <${StatusCard}
        ok=${status.screenRecording}
        title="Screen Recording"
        description="Lets Clance read on-screen context when invoked."
        actionLabel=${status.screenRecording ? null : "Open Settings"}
        onAction=${() => window.clanceApp.requestScreenRecordingAccess()}
      />
      <${StatusCard}
        ok=${status.accessibility}
        title="Accessibility"
        description="Lets Clance type or act on your behalf in other apps."
        actionLabel=${status.accessibility ? null : "Open Settings"}
        onAction=${() => window.clanceApp.openAccessibilitySettings()}
      />
      <div class="setup-step-actions">
        <button class="btn-secondary" onClick=${refresh}>Recheck</button>
        ${bothGranted && onComplete && html`<button onClick=${onComplete}>Continue</button>`}
      </div>
    </div>
  `;
}
