import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Toggle } from "../components/Toggle.js";

export function usePreferences() {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => {
    window.clanceApp.getPreferences().then(setPrefs);
  }, []);
  return [prefs, setPrefs];
}

// While preferences load, both rows render without their controls rather
// than as a shorter placeholder, so the page doesn't shift when they arrive.
export function LaunchAtLoginRow({ prefs, setPrefs }) {
  function handleChange(enabled) {
    setPrefs({ ...prefs, launchOnLogin: enabled });
    window.clanceApp.setLaunchOnLogin(enabled);
  }
  return html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Launch at login</div>
        <div class="preference-description">Open Clance when you log in to your Mac.</div>
      </div>
      ${prefs && html`<${Toggle} checked=${prefs.launchOnLogin} label="Launch at login" onChange=${handleChange} />`}
    </div>
  `;
}

// Where a brand-new Clance-created session opens — the popup hotkey, the
// pre-warmed pool spare, and the main window's new sessions all read this
// (see config.ts's getDefaultDirectory). Doesn't affect resuming an
// existing session, which always reopens in whatever directory it already
// belongs to. See docs/design.md's "Working directory".
export function DefaultDirectoryRow({ prefs, setPrefs }) {

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
        <div class="preference-title">Default folder</div>
        <div class="preference-description">
          Where new sessions start.
        </div>
      </div>
      ${prefs &&
      html`
        <div class="preference-row-actions">
          <span class="preference-value">${prefs.defaultDirectory || "~/.clance"}</span>
          ${prefs.defaultDirectory &&
          html`<button class="btn-quiet btn-small" onClick=${handleReset}>Reset</button>`}
          <button class="btn-secondary btn-small" onClick=${handleBrowse}>Change…</button>
        </div>
      `}
    </div>
  `;
}
