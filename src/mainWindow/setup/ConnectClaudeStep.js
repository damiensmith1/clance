import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";

export function ConnectClaudeStep({ onComplete } = {}) {
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);

  function refresh() {
    return window.clanceApp.getSetupStatus().then((full) => {
      setStatus(full.claude);
      return full;
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleConnect() {
    setConnecting(true);
    window.clanceApp.connectClaude().then(() => {
      setConnecting(false);
      refresh().then((full) => {
        if (full.claude.installed && full.claude.loggedIn && onComplete) {
          onComplete();
        }
      });
    });
  }

  if (status === null) {
    return html`<div class="setup-step"><p>Checking…</p></div>`;
  }

  if (!status.installed) {
    return html`
      <div class="setup-step">
        <h2>Connect your Claude plan</h2>
        <p>
          Clance uses the Claude Code CLI to talk to Claude, and it looks
          like it isn't installed yet.
        </p>
        <button onClick=${() => window.clanceApp.openInstallDocs()}>
          See install instructions
        </button>
        <button onClick=${refresh}>I've installed it</button>
      </div>
    `;
  }

  if (!status.loggedIn) {
    return html`
      <div class="setup-step">
        <h2>Connect your Claude plan</h2>
        <p>Claude Code is installed. Click below to sign in — this opens your browser.</p>
        <button onClick=${handleConnect} disabled=${connecting}>
          ${connecting ? "Connecting…" : "Connect"}
        </button>
      </div>
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Connect your Claude plan</h2>
      <p>
        Connected as ${status.email ?? "your account"}${status.subscriptionType
          ? ` · ${status.subscriptionType} plan`
          : ""}.
      </p>
      ${onComplete && html`<button onClick=${onComplete}>Continue</button>`}
    </div>
  `;
}
