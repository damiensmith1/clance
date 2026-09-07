import { html } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";

export function StatusCard({ ok, title, description, actionLabel, onAction, actionVariant = "button" }) {
  return html`
    <div class="status-card ${ok ? "status-card-ok" : "status-card-warn"}">
      <span class="status-card-icon">${ok ? Icon.checkCircle(18) : Icon.warningTriangle(18)}</span>
      <span class="status-card-body">
        <span class="status-card-title">${title}</span>
        <span class="status-card-description">${description}</span>
      </span>
      ${actionLabel &&
      html`
        <button
          class=${actionVariant === "link" ? "btn-link" : "btn-primary btn-small"}
          onClick=${onAction}
        >
          ${actionLabel}
        </button>
      `}
    </div>
  `;
}
