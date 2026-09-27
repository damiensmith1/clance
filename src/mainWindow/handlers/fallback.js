import { FallbackView } from "../editor/views.js";

// Anything no other handler claims: its name and size, and ways out.
export default {
  id: "fallback",
  match: () => 0,
  views: [{ id: "info", label: "Info", render: FallbackView }],
  defaultView: "info",
};
