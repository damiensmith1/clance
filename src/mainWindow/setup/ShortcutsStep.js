import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

const MODIFIER_LABELS = {
  Alt: "⌥ Option",
  Option: "⌥ Option",
  CommandOrControl: "⌘ Command",
  Cmd: "⌘ Command",
  Command: "⌘ Command",
  Control: "⌃ Control",
  Ctrl: "⌃ Control",
  Shift: "⇧ Shift",
  Super: "⌘ Command",
};

function acceleratorParts(accelerator) {
  return accelerator.split("+").map((part) => MODIFIER_LABELS[part] ?? part);
}

export function ShortcutsStep({ onComplete } = {}) {
  const [actions, setActions] = useState(null);
  const [values, setValues] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.clanceApp.getShortcutActions().then((list) => {
      setActions(list);
      const initial = {};
      for (const action of list) {
        initial[action.id] = action.defaultAccelerator;
      }
      setValues(initial);
    });
  }, []);

  function handleSave() {
    setError(null);
    setSaved(false);
    window.clanceApp
      .saveShortcuts(values)
      .then(() => {
        setSaved(true);
        setEditingId(null);
        if (onComplete) onComplete();
      })
      .catch((err) => {
        setError(err && err.message ? err.message : "Couldn't save that shortcut.");
      });
  }

  if (actions === null) {
    return html`<p class="empty-note">Loading…</p>`;
  }

  if (!onComplete) {
    return html`
      ${actions.map(
        (action) => html`
          <div class="preference-row">
            <div>
              <div class="preference-title">${action.label}</div>
              <div class="preference-description">${action.description}</div>
            </div>
            ${editingId === action.id
              ? html`
                  <div class="shortcut-edit">
                    <input
                      type="text"
                      value=${values[action.id] ?? ""}
                      onInput=${(e) => setValues({ ...values, [action.id]: e.target.value })}
                    />
                    <button class="btn-link" onClick=${handleSave}>Save</button>
                  </div>
                `
              : html`
                  <div class="shortcut-display">
                    ${acceleratorParts(values[action.id] ?? "").map(
                      (part) => html`<span class="kbd">${part}</span>`
                    )}
                    <button class="btn-link" onClick=${() => setEditingId(action.id)}>
                      Change
                    </button>
                  </div>
                `}
          </div>
        `
      )}
      ${error && html`<p class="setup-error">${error}</p>`}
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Set your shortcuts</h2>
      ${actions.map(
        (action) => html`
          <div class="shortcut-row">
            <label>${action.label}</label>
            <input
              type="text"
              value=${values[action.id] ?? ""}
              onInput=${(e) =>
                setValues({ ...values, [action.id]: e.target.value })}
            />
          </div>
        `
      )}
      ${error && html`<p class="setup-error">${error}</p>`}
      <button onClick=${handleSave}>${onComplete ? "Save and continue" : "Save"}</button>
      ${!onComplete && saved && html`<p class="setup-success">Saved.</p>`}
    </div>
  `;
}
