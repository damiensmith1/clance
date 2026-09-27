import { EditorPane, SvgPreview } from "../editor/views.js";

// SVG is the one image with a source worth editing: the picture, drawn from
// the buffer's text, and the source.
export default {
  id: "svg",
  match: (buffer) => (buffer.doc?.kind === "text" && /\.svg$/i.test(buffer.path) ? 10 : -1),
  views: [
    { id: "image", label: "Image", render: SvgPreview },
    { id: "source", label: "Source", render: EditorPane },
  ],
  defaultView: "image",
};
