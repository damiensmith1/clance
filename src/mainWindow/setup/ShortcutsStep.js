import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

export function ShortcutsStep({ onComplete } = {}) {
  const [actions, setActions] = useState(null);
  const [values, setValues] = useState({});
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
        if (onComplete) onComplete();
      })
      .catch((err) => {
        setError(err && err.message ? err.message : "Couldn't save that shortcut.");
      });
  }

  if (actions === null) {
    return html`<div class="setup-step"><p>Loading…</p></div>`;
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
