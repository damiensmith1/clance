import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";
import { StatusCard } from "../components/StatusCard.js";

const INSTALL_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash";

export function ConnectClaudeStep({ onComplete, onBack, onReady } = {}) {
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  function refresh() {
    return window.clanceApp.getSetupStatus().then((full) => {
      setStatus(full.claude);
      return full;
    });
  }

  useEffect(() => {
    // In Settings, start from the last status Clance checked so the row is
    // ready at once; the fresh check replaces it if anything changed.
    if (!onComplete) {
      window.clanceApp.getLastSetupStatus().then((last) => {
        if (last) setStatus((current) => current ?? last.claude);
      });
    }
    refresh();
  }, []);

  useEffect(() => {
    if (status !== null) onReady?.();
  }, [status !== null]);

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

  function copyInstallCommand() {
    navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (status === null) {
    // In Settings the check can take a few seconds; hold the row's shape so
    // nothing below it moves when the result arrives.
    return onComplete
      ? html`<p class="empty-note">Checking…</p>`
      : html`<${StatusCard} title="Claude account" description="Checking your Claude plan…" status="checking…" />`;
  }

  const account = `${status.email ?? "your account"}${status.subscriptionType ? ` · ${status.subscriptionType} plan` : ""}`;

  // Settings mode: a single status row, not the step-by-step flow.
  if (!onComplete) {
    if (!status.installed) {
      return html`<${StatusCard}
        title="Claude account"
        description="Claude Code isn't installed on this Mac."
        status="not installed"
        tone="attention"
        actionLabel="How to install"
        onAction=${() => window.clanceApp.openInstallDocs()}
      />`;
    }
    if (!status.loggedIn) {
      return html`<${StatusCard}
        title="Claude account"
        description="Sign in so new sessions can start."
        status="signed out"
        tone="attention"
        actionLabel=${connecting ? "Signing in…" : "Sign in"}
        onAction=${handleConnect}
      />`;
    }
    return html`<${StatusCard}
      title="Claude account"
      description=${account}
      status="connected"
      tone="ok"
      actionLabel="Sign out"
      actionVariant="quiet"
      onAction=${handleDisconnect}
    />`;
  }

  const back = onBack && html`<button class="btn-quiet" onClick=${onBack}>Back</button>`;

  if (!status.installed) {
    return html`
      <div class="setup-step">
        <h2>Install Claude Code</h2>
        <p>Clance runs your sessions through the Claude Code CLI, using your existing Claude plan.</p>
        <div class="list-group-label">run in terminal</div>
        <div class="setup-command">
          <span class="setup-command-text"><span class="setup-command-prompt">$ </span>${INSTALL_COMMAND}</span>
          <button class="btn-secondary btn-small" onClick=${copyInstallCommand}>${copied ? "Copied" : "Copy"}</button>
        </div>
        <p class="setup-hint setup-hint-plain">
          Already have it? Clance looks in <code>~/.local/bin</code>, Homebrew and your shell's PATH.
          <button class="btn-link" onClick=${() => window.clanceApp.openInstallDocs()}>Other ways</button>
        </p>
        <div class="setup-step-actions">
          <span class="setup-step-actions-status status status-attention">claude not found</span>
          ${back}
          <button class="btn-secondary" onClick=${refresh}>Check again</button>
          <button class="btn-primary" disabled>Continue <span class="key-hint">↩</span></button>
        </div>
      </div>
    `;
  }

  if (!status.loggedIn) {
    return html`
      <div class="setup-step">
        <h2>Connect your Claude plan</h2>
        <p>Sign in once. Clance never sees your password; Claude Code keeps the login.</p>
        ${connecting &&
        html`
          <div class="setup-waiting">
            <span class="setup-waiting-icon"><span class="status-dot status-dot-live"></span></span>
            <span class="status-card-body">
              <span class="status-card-title">Finish signing in in your browser</span>
              <span class="status-card-description">We opened claude.ai. Come back here when it says you're done.</span>
            </span>
          </div>
        `}
        ${error && html`<p class="setup-error">${error}</p>`}
        <div class="setup-step-actions">
          <span class="setup-step-actions-status status status-ok">claude installed</span>
          ${back}
          ${connecting
            ? html`<button class="btn-primary" disabled>Continue <span class="key-hint">↩</span></button>`
            : html`<button class="btn-primary" onClick=${handleConnect}>Sign in <span class="key-hint">↩</span></button>`}
        </div>
      </div>
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Connect your Claude plan</h2>
      <p>Connected as ${account}.</p>
      <div class="setup-step-actions">
        <span class="setup-step-actions-status status status-ok">connected</span>
        ${back}
        <button class="btn-primary" onClick=${onComplete}>Continue <span class="key-hint">↩</span></button>
      </div>
    </div>
  `;
}
