import { html } from "../../shared/vendor/preact-htm-standalone.module.js";

export function Toggle({ checked, onChange, label }) {
  return html`
    <button
      type="button"
      class="toggle ${checked ? "toggle-on" : ""}"
      role="switch"
      aria-checked=${checked}
      aria-label=${label}
      onClick=${() => onChange(!checked)}
    >
      <span class="toggle-thumb"></span>
    </button>
  `;
}
