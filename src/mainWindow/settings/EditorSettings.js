import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Toggle } from "../components/Toggle.js";
import { getEditorConfig, loadEditorConfig, updateEditorConfig } from "../editor/buffers.js";

// Settings for the editor (docs/design.md's "Editor"): text size, the indent a
// file with none of its own gets, and whether long lines wrap. A file's own
// indentation always wins over the default.

const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20];
const TAB_SIZES = [2, 4, 8];

export function EditorSettingsRows() {
  const [config, setConfig] = useState(getEditorConfig());
  useEffect(() => {
    loadEditorConfig().then(setConfig);
  }, []);

  async function update(patch) {
    setConfig(await updateEditorConfig(patch));
  }

  return html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Text size</div>
        <div class="preference-description">In the editor and file views.</div>
      </div>
      <select class="preference-select" value=${config.fontSize} onChange=${(e) => update({ fontSize: Number(e.target.value) })}>
        ${FONT_SIZES.map((size) => html`<option value=${size}>${size}</option>`)}
      </select>
    </div>
    <div class="preference-row">
      <div>
        <div class="preference-title">Indent</div>
        <div class="preference-description">Spaces for files that don't have an indent of their own yet.</div>
      </div>
      <select class="preference-select" value=${config.tabSize} onChange=${(e) => update({ tabSize: Number(e.target.value) })}>
        ${TAB_SIZES.map((size) => html`<option value=${size}>${size} spaces</option>`)}
      </select>
    </div>
    <div class="preference-row">
      <div>
        <div class="preference-title">Wrap long lines</div>
        <div class="preference-description">⌥Z toggles it from the editor.</div>
      </div>
      <${Toggle} checked=${config.wrap} label="Wrap long lines" onChange=${(on) => update({ wrap: on })} />
    </div>
  `;
}

// `clance .` from a terminal, like `code .`. The Homebrew cask links it; this
// row links it for anyone who installed some other way.
export function CommandLineRow() {
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  useEffect(() => {
    window.clanceApp.cliStatus().then(setStatus);
  }, []);

  async function install() {
    const outcome = await window.clanceApp.cliInstall();
    setResult(outcome);
    setStatus(await window.clanceApp.cliStatus());
  }

  const installed = status?.installed;
  return html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Command line</div>
        <div class="preference-description">
          ${installed
            ? html`<code>clance .</code> opens a folder, <code>clance file</code> a file. Linked at ${installed.replace(/^\/Users\/[^/]+/, "~")}.`
            : html`Install <code>clance</code> to open files and folders from a terminal, like <code>code .</code>`}
          ${result && !result.ok && html`<div class="preference-warning">${result.error}</div>`}
          ${result?.ok &&
          !result.onPath &&
          html`<div class="preference-warning">Add ${result.path.replace(/\/clance$/, "").replace(/^\/Users\/[^/]+/, "~")} to your PATH to use it.</div>`}
        </div>
      </div>
      ${!installed && html`<button class="btn-secondary btn-small" onClick=${install}>Install</button>`}
    </div>
  `;
}
