import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Toggle } from "../components/Toggle.js";

export function usePreferences() {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => {
    window.clanceApp.getPreferences().then(setPrefs);
  }, []);
  return [prefs, setPrefs];
}

export function LaunchAtLoginRow({ prefs, setPrefs }) {
  if (!prefs) return html`<p class="empty-note">Loading…</p>`;
  function handleChange(enabled) {
    setPrefs({ ...prefs, launchOnLogin: enabled });
    window.clanceApp.setLaunchOnLogin(enabled);
  }
  return html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Launch at Login</div>
        <div class="preference-description">Automatically open Clance when you start your computer.</div>
      </div>
      <${Toggle} checked=${prefs.launchOnLogin} onChange=${handleChange} />
    </div>
  `;
}
