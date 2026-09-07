import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

export function ShortcutsStep({ onComplete } = {}) {
  const [actions, setActions] = useState(null);
  const [values, setValues] = useState({});

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
    window.clanceApp.saveShortcuts(values).then(() => {
      if (onComplete) onComplete();
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
      <button onClick=${handleSave}>Save and continue</button>
    </div>
  `;
}
