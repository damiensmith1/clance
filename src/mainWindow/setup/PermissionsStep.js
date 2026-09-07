import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

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
    return html`<div class="setup-step"><p>Checking…</p></div>`;
  }

  const bothGranted = status.screenRecording && status.accessibility;

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
