import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function PreferencesStep() {
  const [prefs, setPrefs] = useState(null);

  useEffect(() => {
    window.clanceApp.getPreferences().then(setPrefs);
  }, []);

  function handleThemeChange(theme) {
    setPrefs({ ...prefs, theme });
    window.clanceApp.setTheme(theme);
  }

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
        <label>Appearance</label>
        <div class="theme-options">
          ${THEME_OPTIONS.map(
            (option) => html`
              <button
                class=${prefs.theme === option.value ? "active" : ""}
                onClick=${() => handleThemeChange(option.value)}
              >
                ${option.label}
              </button>
            `
          )}
        </div>
      </div>
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
