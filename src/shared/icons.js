import { html } from "./vendor/preact-htm-standalone.module.js";

// Small, dependency-free line-icon set (no icon font/library, matches the
// project's no-CDN rule). Each icon is a plain SVG sized by its `size` prop
// and colored via `currentColor`, so it inherits text color from its
// context (className/style on the wrapping element).
function svg(size, children) {
  return html`
    <svg
      width=${size}
      height=${size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      ${children}
    </svg>
  `;
}

export const Icon = {
  chat: (size = 16) =>
    svg(size, html`<path d="M4 5.5h16v10.5H9l-4 3.5v-3.5H4V5.5z" />`),

  terminal: (size = 16) =>
    svg(
      size,
      html`<rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3" />
        <path d="M13 15h4" />`
    ),

  puzzle: (size = 16) =>
    svg(
      size,
      html`<path
        d="M9 4.5h3.2a1.4 1.4 0 0 1 1.4 1.6 1.6 1.6 0 0 0 3.2 0 1.4 1.4 0 0 1 1.4-1.6H21v3.8a1.4 1.4 0 0 1-1.6 1.4 1.6 1.6 0 0 0 0 3.2 1.4 1.4 0 0 1 1.6 1.4v3.8h-3.8a1.4 1.4 0 0 1-1.4-1.6 1.6 1.6 0 0 0-3.2 0 1.4 1.4 0 0 1-1.4 1.6H9v-3.8a1.4 1.4 0 0 0-1.6-1.4 1.6 1.6 0 0 1 0-3.2A1.4 1.4 0 0 0 9 8.3V4.5z"
      />`
    ),

  gear: (size = 16) =>
    svg(
      size,
      html`<circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        />`
    ),

  search: (size = 16) =>
    svg(
      size,
      html`<circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.8-4.8" />`
    ),

  filter: (size = 16) =>
    svg(size, html`<path d="M4 5h16l-6 7.5v5L10 20v-7.5L4 5z" />`),

  markdown: (size = 16) =>
    svg(
      size,
      html`<rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M6.5 15V9l3 3 3-3v6" />
        <path d="M15.5 9v6M13 13l2.5 2.5L18 13" />`
    ),

  robot: (size = 16) =>
    svg(
      size,
      html`<rect x="5" y="8" width="14" height="10" rx="2.5" />
        <path d="M12 8V5" /><circle cx="12" cy="4" r="1" />
        <circle cx="9" cy="13" r="1.3" /><circle cx="15" cy="13" r="1.3" />
        <path d="M9 16.5h6" />`
    ),

  person: (size = 16) =>
    svg(
      size,
      html`<circle cx="12" cy="8.5" r="3.2" />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />`
    ),

  plug: (size = 16) =>
    svg(
      size,
      html`<path d="M9 2v6M15 2v6" />
        <rect x="7" y="8" width="10" height="6" rx="2" />
        <path d="M12 14v3a4 4 0 0 1-4 4H6" />`
    ),

  moreVertical: (size = 16) =>
    svg(
      size,
      html`<circle cx="12" cy="5.5" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="18.5" r="1.1" fill="currentColor" stroke="none" />`
    ),

  chevronRight: (size = 16) => svg(size, html`<path d="M9 5l7 7-7 7" />`),

  checkCircle: (size = 16) =>
    svg(
      size,
      html`<circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.3l2.4 2.4 4.6-5.4" />`
    ),

  warningTriangle: (size = 16) =>
    svg(
      size,
      html`<path d="M12 4.5L21 19H3L12 4.5z" />
        <path d="M12 10v4" /><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />`
    ),

  paperclip: (size = 16) =>
    svg(
      size,
      html`<path
        d="M16.5 6.5l-7 7a3 3 0 0 0 4.2 4.2l7-7a5 5 0 0 0-7.1-7.1l-7 7a7 7 0 0 0 9.9 9.9"
      />`
    ),

  sparkle: (size = 16) =>
    svg(
      size,
      html`<path
        d="M12 3l1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3z"
      /><path d="M19 15l0.7 2.3L22 18l-2.3 0.7L19 21l-0.7-2.3L16 18l2.3-0.7L19 15z" />`
    ),

  close: (size = 16) => svg(size, html`<path d="M6 6l12 12M18 6L6 18" />`),

  popOut: (size = 16) =>
    svg(
      size,
      html`<path d="M14 4h6v6M20 4L10 14" />
        <path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />`
    ),

  copy: (size = 14) =>
    svg(
      size,
      html`<rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />`
    ),

  addServer: (size = 14) => svg(size, html`<path d="M12 5v14M5 12h14" />`),

  mic: (size = 16) =>
    svg(
      size,
      html`<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
        <path d="M19 11a7 7 0 0 1-14 0" />
        <path d="M12 19v3" />`
    ),

  arrowUp: (size = 16) => svg(size, html`<path d="M12 19V5M5 12l7-7 7 7" />`),
};
