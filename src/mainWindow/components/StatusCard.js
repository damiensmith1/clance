import { html } from "../../shared/vendor/preact-htm-standalone.module.js";

// A status row: title and description, then a mono status word and an
// optional action. `tone` colours the word — "ok" (green), "attention"
// (amber: the user must act), or "plain" for anything neutral, including an
// optional permission that's simply off.
export function StatusCard({ title, description, status, tone = "plain", actionLabel, onAction, actionVariant = "secondary" }) {
  return html`
    <div class="status-card">
      <span class="status-card-body">
        <span class="status-card-title">${title}</span>
        ${description && html`<span class="status-card-description">${description}</span>`}
      </span>
      ${status && html`<span class="status-card-status status-card-status-${tone}">${status}</span>`}
      ${actionLabel &&
      html`
        <button class=${actionVariant === "quiet" ? "btn-quiet btn-small" : "btn-secondary btn-small"} onClick=${onAction}>
          ${actionLabel}
        </button>
      `}
    </div>
  `;
}
