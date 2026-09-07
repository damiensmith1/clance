import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";
import { StatusCard } from "../components/StatusCard.js";

export function ConnectClaudeStep({ onComplete } = {}) {
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

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
    setError(null);
    window.clanceApp
      .connectClaude()
      .then(() =>
        refresh().then((full) => {
          setConnecting(false);
          if (full.claude.installed && full.claude.loggedIn && onComplete) {
            onComplete();
          } else if (!full.claude.loggedIn) {
            setError("Sign-in didn't complete — try again.");
          }
        })
      )
      .catch(() => {
        setConnecting(false);
        setError("Sign-in didn't complete — try again.");
      });
  }

  function handleDisconnect() {
    window.clanceApp.disconnectClaude().then(refresh);
  }

  if (status === null) {
    return html`<p class="empty-note">Checking…</p>`;
  }

  // Settings mode: a single compact status card, not the step-by-step flow.
  if (!onComplete) {
    if (!status.installed) {
      return html`<${StatusCard}
        ok=${false}
        title="Claude Account"
        description="Claude Code CLI isn't installed."
        actionLabel="Install"
        onAction=${() => window.clanceApp.openInstallDocs()}
      />`;
    }
    if (!status.loggedIn) {
      return html`<${StatusCard}
        ok=${false}
        title="Claude Account"
        description="Not connected."
        actionLabel=${connecting ? "Connecting…" : "Connect"}
        onAction=${handleConnect}
      />`;
    }
    return html`<${StatusCard}
      ok=${true}
      title="Claude Account"
      description="Connected to ${status.email ?? "your account"}${status.subscriptionType
        ? ` · ${status.subscriptionType} plan`
        : ""}."
      actionLabel="Disconnect"
      actionVariant="link"
      onAction=${handleDisconnect}
    />`;
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
        ${error && html`<p class="setup-error">${error}</p>`}
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
