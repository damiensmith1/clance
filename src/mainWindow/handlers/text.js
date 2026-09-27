import { EditorPane } from "../editor/views.js";

// Any readable text: the editor.
export default {
  id: "text",
  match: (buffer) => (buffer.doc?.kind === "text" ? 1 : -1),
  views: [{ id: "source", label: "Source", render: EditorPane }],
  defaultView: "source",
};
