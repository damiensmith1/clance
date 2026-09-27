import { EditorPane, MarkdownPreview } from "../editor/views.js";

const EXTENSIONS = /\.(md|markdown|mdown|mkd|mdx)$/i;

// Markdown: rendered first, since a document is mostly read, with the editor
// one click away. The rendered view follows unsaved edits.
export default {
  id: "markdown",
  match: (buffer) => (buffer.doc?.kind === "text" && EXTENSIONS.test(buffer.path) ? 10 : -1),
  views: [
    { id: "rendered", label: "Rendered", render: MarkdownPreview },
    { id: "source", label: "Source", render: EditorPane },
  ],
  defaultView: "rendered",
};
