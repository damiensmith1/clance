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

// Where a brand-new Clance-created session opens — the popup hotkey, the
// pre-warmed pool spare, and the main window's "New Chat" all read this
// (see config.ts's getDefaultDirectory). Doesn't affect resuming an
// existing session, which always reopens in whatever directory it already
// belongs to. See docs/working-directory-design.md.
export function DefaultDirectoryRow({ prefs, setPrefs }) {
  if (!prefs) return html`<p class="empty-note">Loading…</p>`;

  async function handleBrowse() {
    const dir = await window.clanceApp.pickDirectory();
    if (!dir) return;
    setPrefs({ ...prefs, defaultDirectory: dir });
    window.clanceApp.setDefaultDirectory(dir);
  }

  function handleReset() {
    setPrefs({ ...prefs, defaultDirectory: null });
    window.clanceApp.setDefaultDirectory(null);
  }

  return html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Default Working Directory</div>
        <div class="preference-description">
          ${prefs.defaultDirectory
            ? html`New conversations open in <code>${prefs.defaultDirectory}</code>.`
            : "New conversations open in Clance's own directory."}
        </div>
      </div>
      <div class="preference-row-actions">
        ${prefs.defaultDirectory &&
        html`<button class="btn-link" onClick=${handleReset}>Reset</button>`}
        <button class="btn-link" onClick=${handleBrowse}>Browse…</button>
      </div>
    </div>
  `;
}
