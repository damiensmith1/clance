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

// The assistant's decision service, and the only setting on this page that
// changes what leaves the Mac.
//
// Off doesn't mean broken: ⌥A still works, on the commands Clance can match
// locally, and hands everything else to a Claude Code session. What's said
// here is what's actually sent — the command, the app's name and window
// title, and the list of things that could be done. Never a document, a
// field's contents, or anything dictated.
export function AssistantDeciderRow({ prefs, setPrefs }) {
  const assistant = prefs && prefs.assistant;

  function handleChange(enabled) {
    const decider = enabled ? "jev" : "local";
    setPrefs({ ...prefs, assistant: { ...assistant, decider } });
    window.clanceApp.setAssistantDecider(decider);
  }

  // On, but not actually running: no key is configured, so the assistant is
  // quietly on local matching. Said out loud here, because the toggle alone
  // would claim otherwise and the difference is the whole feature.
  const askedForJev = assistant && assistant.decider === "jev";
  const usingJev = assistant && assistant.active === "Jev";

  return html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Understand commands with Jev</div>
        <div class="preference-description">
          Sends what you said, the app you're in and what it can do to TypeSafe AI. Never your
          documents, what's in a field, or anything you dictate. Off, Clance matches commands on
          this Mac and hands the rest to Claude.
          ${askedForJev && !usingJev
            ? html`<strong>
                ${" "}No API key, so commands are being matched on this Mac. Put
                TYPESAFE_API_KEY in a .env file next to Clance and restart it.
              </strong>`
            : null}
        </div>
      </div>
      ${assistant &&
      html`<${Toggle}
        checked=${assistant.decider === "jev"}
        label="Understand commands with Jev"
        onChange=${handleChange}
      />`}
    </div>
  `;
}
