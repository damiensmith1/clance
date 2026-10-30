import { html } from "../../shared/vendor/preact-htm-standalone.module.js";

// A menu item: title, optional right-aligned mono detail and shortcut.
// mousedown is swallowed so clicking an item doesn't blur a search field
// (which would close a command menu before the click lands).
export function MenuItem({ title, detail, shortcut, active, disabled, onSelect }) {
  return html`
    <button
      class="menu-item ${active ? "menu-item-active" : ""}"
      role="menuitem"
      disabled=${disabled}
      onMouseDown=${(e) => e.preventDefault()}
      onClick=${onSelect}
    >
      <span class="menu-item-title">${title}</span>
      <span class="menu-item-detail">${detail ?? ""}</span>
      ${shortcut && html`<span class="menu-shortcut">${shortcut}</span>`}
    </button>
  `;
}
