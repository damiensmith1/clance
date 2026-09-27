import { ImageView } from "../editor/views.js";

// A bitmap image, shown at its size.
export default {
  id: "image",
  match: (buffer) => (buffer.doc?.kind === "image" ? 10 : -1),
  views: [{ id: "image", label: "Image", render: ImageView }],
  defaultView: "image",
};
