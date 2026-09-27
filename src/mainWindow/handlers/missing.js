import { EditorPane } from "../editor/views.js";

// A file that isn't on disk but git has: its last committed version,
// read-only. The header says why.
export default {
  id: "missing",
  match: (buffer) => (buffer.doc?.kind === "missing" ? 10 : -1),
  views: [{ id: "source", label: "Source", render: EditorPane }],
  defaultView: "source",
};
