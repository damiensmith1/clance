import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";

export function PreferencesStep() {
  const [prefs, setPrefs] = useState(null);

  useEffect(() => {
    window.clanceApp.getPreferences().then(setPrefs);
  }, []);

  function handleLaunchOnLoginChange(enabled) {
    setPrefs({ ...prefs, launchOnLogin: enabled });
    window.clanceApp.setLaunchOnLogin(enabled);
  }

  if (!prefs) {
    return html`<div class="setup-step"><p>Loading…</p></div>`;
  }

  return html`
    <div class="setup-step">
      <h2>Preferences</h2>
      <div class="preference-row">
        <label>Launch Clance at login</label>
        <input
          type="checkbox"
          checked=${prefs.launchOnLogin}
          onChange=${(e) => handleLaunchOnLoginChange(e.target.checked)}
        />
      </div>
    </div>
  `;
}
