import { html } from "../../shared/vendor/preact-htm-standalone.module.js";

export function Toggle({ checked, onChange }) {
  return html`
    <button
      type="button"
      class="toggle ${checked ? "toggle-on" : ""}"
      role="switch"
      aria-checked=${checked}
      onClick=${() => onChange(!checked)}
    >
      <span class="toggle-thumb"></span>
    </button>
  `;
}
