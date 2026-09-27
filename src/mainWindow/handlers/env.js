import { html, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { EditorPane } from "../editor/views.js";
import { maskValues } from "../editor/setup.js";
import { setHandlerExtensions } from "../editor/buffers.js";

const ENV_FILE = /(^|\/)(\.env(\..+)?|[^/]+\.env)$/;

// Masking is off until asked for, and remembered per buffer while it's open.
function MaskToggle({ buffer }) {
  const [masked, setMasked] = useState(Boolean(buffer.masked));
  function toggle() {
    const next = !masked;
    buffer.masked = next;
    setMasked(next);
    setHandlerExtensions(buffer, next ? [maskValues] : []);
  }
  return html`
    <button class="btn-quiet btn-small ${masked ? "is-on" : ""}" title="Hide values, e.g. while screen sharing" onClick=${toggle}>
      ${masked ? "Show values" : "Mask values"}
    </button>
  `;
}

// A .env file: the editor with .env highlighting, and a toggle that draws
// every value as dots. Masking changes what's shown, never what's saved.
export default {
  id: "env",
  match: (buffer) => (buffer.doc?.kind === "text" && ENV_FILE.test(buffer.path) ? 10 : -1),
  views: [{ id: "source", label: "Source", render: EditorPane }],
  defaultView: "source",
  Actions: MaskToggle,
};
