import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";

// The Jev key for a lode tab's "/" questions (docs/design.md's "Keys are
// Clance's to give"). Kept encrypted by the main process (lode.ts); the
// window only ever sees where the key comes from, never the key. Without
// one, a lode tab's "/" is off.

const SOURCES = {
  settings: "Set here.",
  environment: "From TYPESAFE_API_KEY in Clance's environment. One set here takes its place.",
  "env-file": "From the repo's .env (dev run). One set here takes its place.",
};

export function useJevStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    window.clanceApp.jevStatus().then(setStatus);
    return window.clanceApp.onJevStatus(setStatus);
  }, []);
  return status;
}

export function JevKeyRow() {
  const status = useJevStatus();
  const [key, setKey] = useState("");
  const [error, setError] = useState(null);

  async function save(value) {
    setError(null);
    try {
      await window.clanceApp.setJevKey(value);
      setKey("");
    } catch (e) {
      setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }

  const source = status?.source;
  return html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Jev key</div>
        <div class="preference-description">
          Lets a lode tab's <code>/</code> build the flow that answers a question.
          ${source ? ` ${SOURCES[source]}` : html` Get one from <a href="#" onClick=${(e) => (e.preventDefault(), window.clanceApp.openExternalUrl("https://docs.typesafe.ai"))}>TypeSafe</a>.`}
          ${error && html`<div class="preference-warning">${error}</div>`}
        </div>
      </div>
      <form class="jev-key-field" onSubmit=${(e) => (e.preventDefault(), key.trim() && save(key))}>
        <input
          class="preference-input"
          type="password"
          placeholder=${source === "settings" ? "••••••••" : "Paste a key"}
          value=${key}
          onInput=${(e) => setKey(e.target.value)}
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn-secondary btn-small" type="submit" disabled=${!key.trim()}>Save</button>
        ${source === "settings" && html`<button class="btn-quiet btn-small" type="button" onClick=${() => save(null)}>Remove</button>`}
      </form>
    </div>
  `;
}

// The setup wizard's step: optional, like dictation. Continue works with or
// without a key.
export function JevKeyStep({ onComplete, onBack }) {
  const status = useJevStatus();
  return html`
    <div class="setup-step">
      <h2>Ask lode questions</h2>
      <p>lode tabs show a project's code as cards. With a Jev key, typing <code>/</code> and a question builds the flow that answers it. You can add one later in Settings.</p>
      <${JevKeyRow} />
      <div class="setup-step-actions">
        <span class="setup-step-actions-status mono-label">${status?.source ? "key set" : "optional"}</span>
        ${onBack && html`<button class="btn-quiet" onClick=${onBack}>Back</button>`}
        <button class="btn-primary" onClick=${onComplete}>
          ${status?.source ? "Continue" : "Skip"} <span class="key-hint">↩</span>
        </button>
      </div>
    </div>
  `;
}
