import { h, html, render, useState, useEffect } from "../shared/vendor/preact-htm-standalone.module.js";
import { Shell } from "./Shell.js";
import { SetupWizard } from "./setup/SetupWizard.js";

function App() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    window.clanceApp.getSetupStatus().then(setStatus);
  }, []);

  if (status === null) {
    return html`<div class="loading">Loading…</div>`;
  }
  if (!status.isComplete) {
    return html`<${SetupWizard} initialStatus=${status} />`;
  }
  return html`<${Shell} />`;
}

render(html`<${App} />`, document.getElementById("root"));
