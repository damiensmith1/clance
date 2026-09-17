import { h, html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { StatusCard } from "../components/StatusCard.js";
import { Toggle } from "../components/Toggle.js";

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function progressLabel(progress) {
  if (!progress) return null;
  switch (progress.phase) {
    case "downloading": {
      const pct = progress.totalBytes
        ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
        : 0;
      return `Downloading… ${pct}%`;
    }
    case "verifying":
      return "Verifying checksum…";
    // The warm-up is a real ~18s wait on first install (Metal shader
    // compilation — see docs/design.md's "Models"), so it gets its own
    // label rather than looking like the download stalled at 100%.
    case "warming":
      return "Preparing model (one-time, ~20s)…";
    case "done":
      return "Installed";
    case "error":
      return progress.message || "Failed";
    default:
      return null;
  }
}

function metaLine(model, installing, progress) {
  const parts = [
    model.installed
      ? `${formatBytes(model.bytes)} on disk`
      : `${formatBytes(model.bytes)} to download`,
    `~${model.peakRssMb} MB while running`,
  ];
  if (installing) parts.push(progressLabel(progress));
  return parts.filter(Boolean).join(" \u00b7 ");
}

/**
 * Model management, microphone permission, and dictation preferences.
 *
 * Same dual-mode shape as the other steps in this directory (see
 * PermissionsStep): with `onComplete` it renders as a wizard step, without
 * it as plain rows for the Settings page and the Dictation tab.
 */
export function DictationStep({ onComplete, onBack, onReady } = {}) {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    if (data && settings) onReady?.();
  }, [Boolean(data && settings)]);
  const [mic, setMic] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [promptDraft, setPromptDraft] = useState(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [dictateShortcut, setDictateShortcut] = useState("Alt+D");

  useEffect(() => {
    window.clanceApp.getPreferences().then((prefs) => {
      if (prefs?.shortcuts?.dictate) setDictateShortcut(prefs.shortcuts.dictate);
    });
  }, []);

  function refresh() {
    return Promise.all([
      window.clanceApp.listDictationModels(),
      window.clanceApp.getDictationSettings(),
      window.clanceApp.recheckPermissions(),
    ]).then(([models, dictationSettings, permissions]) => {
      setData(models);
      setSettings(dictationSettings);
      setMic(permissions.microphone);
      // Only seed the draft on first load, so a refresh triggered by some
      // other control can't discard an in-progress edit.
      setPromptDraft((current) => (current === null ? dictationSettings.vocabulary : current));
    });
  }

  useEffect(() => {
    refresh();
    // A download keeps running after this view is closed, so on mount ask
    // what's in flight rather than assuming nothing is. Without this,
    // reopening Settings mid-download showed an Install button that then
    // failed with "already downloading".
    // Guarded: one missing bridge method shouldn't stop the whole pane
    // rendering. Re-attaching to a download in progress is a nicety, and
    // losing it is far better than an empty Settings screen.
    if (typeof window.clanceApp.activeDictationInstalls === "function") {
      window.clanceApp
        .activeDictationInstalls()
        .then((running) => {
          if (running && running.length > 0) setProgress(running[0]);
        })
        .catch(() => {});
    }
    return window.clanceApp.onDictationInstallProgress((p) => {
      setProgress(p);
      if (p.phase === "done" || p.phase === "error") {
        // Clear the bar shortly after either outcome, and re-read state so
        // the newly installed model shows as active.
        refresh();
        setTimeout(() => setProgress(null), 1500);
      }
    });
  }, []);

  function handleInstall(modelId) {
    setError(null);
    const model = models.find((m) => m.id === modelId);
    // Seeded with the real total so the bar is proportioned from the first
    // frame rather than starting at a bogus 0-of-0.
    setProgress({
      modelId,
      phase: "downloading",
      receivedBytes: 0,
      totalBytes: model ? model.bytes : 0,
    });
    window.clanceApp
      .installDictationModel(modelId)
      .then((result) => {
        // A cancelled install is not a failure; just drop the bar.
        if (result && result.outcome === "cancelled") setProgress(null);
        return refresh();
      })
      .catch((err) => {
        setError(err && err.message ? err.message : "Install failed.");
        setProgress(null);
      });
  }

  function handleRemove(modelId) {
    window.clanceApp.removeDictationModel(modelId).then(refresh);
  }

  function handleActivate(modelId) {
    window.clanceApp.setActiveDictationModel(modelId).then(refresh).catch(() => refresh());
  }

  // Microphone access can be granted in System Settings while this is open.
  useEffect(() => {
    const onFocus = () => window.clanceApp.recheckPermissions().then((p) => setMic(p.microphone));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  function handleMic() {
    window.clanceApp.requestMicrophone().then((granted) => {
      setMic(granted);
      // macOS only ever shows the prompt once; after a denial the only way
      // through is the Settings pane, so open it rather than leaving the
      // button looking broken.
      if (!granted) window.clanceApp.openMicrophoneSettings();
    });
  }

  function patchSettings(patch) {
    setSettings({ ...settings, ...patch });
    window.clanceApp.saveDictationSettings(patch);
  }

  function savePrompt() {
    if (promptDraft === null || promptDraft === settings.vocabulary) return;
    patchSettings({ vocabulary: promptDraft });
  }

  function resetPrompt() {
    window.clanceApp.saveDictationSettings({ vocabulary: null }).then((saved) => {
      setSettings(saved);
      setPromptDraft(saved.vocabulary);
    });
  }

  if (!data || !settings) {
    return html`<p class="empty-note">Loading…</p>`;
  }

  const { models, recommendation, binaryAvailable } = data;
  const anyInstalled = models.some((m) => m.installed);

  // Written for someone who installed Clance from the command line, not a
  // developer running a dev build — it previously said "In a dev build, …".
  // "Check again" re-resolves the binary, which isn't cached until it's
  // found, so installing it and pressing the button is enough.
  const engineCard = !binaryAvailable
    ? html`
        <${StatusCard}
          title="Speech engine"
          description="Dictation runs on whisper.cpp. Install it with brew install whisper.cpp, then check again."
          status="not installed"
          tone="attention"
          actionLabel="Check again"
          onAction=${refresh}
        />
      `
    : null;

  const micCard = html`
    <${StatusCard}
      title="Microphone"
      description="So Clance can hear you when you dictate."
      status=${mic ? "granted" : "not granted"}
      tone=${mic ? "ok" : "attention"}
      actionLabel=${mic ? null : "Grant"}
      onAction=${handleMic}
    />
  `;

  function renderModelRow(model) {
        const isRecommended = model.id === recommendation.modelId;
        const installing = progress && progress.modelId === model.id && progress.phase !== "done";
        return html`
          <div class="item-card item-card-static dictation-model" key=${model.id}>
            <span class="item-card-icon ${model.active ? "item-card-icon-accent" : ""}">
              ${Icon.mic(16)}
            </span>
            <span class="item-card-body">
              <span class="item-card-title">
                ${model.label}
                ${model.active
                  ? html`<span class="dictation-badge">active</span>`
                  : isRecommended
                    ? html`<span class="dictation-badge dictation-badge-muted">recommended</span>`
                    : null}
              </span>
              <span class="item-card-description">${model.note}</span>
              <span class="item-card-meta">${metaLine(model, installing, progress)}</span>
              ${installing
                ? html`
                    <span class="install-bar" role="progressbar">
                      <span
                        class="install-bar-fill ${progress.phase !== "downloading"
                          ? "install-bar-fill-indeterminate"
                          : ""}"
                        style=${`width: ${
                          progress.phase === "downloading" && progress.totalBytes
                            ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
                            : 100
                        }%`}
                      ></span>
                    </span>
                  `
                : null}
            </span>
            <span class="item-card-actions">
              ${installing
                ? html`<button
                    class="btn-quiet btn-small"
                    onClick=${() => window.clanceApp.cancelDictationInstall(model.id)}
                  >
                    Cancel
                  </button>`
                : model.installed
                  ? html`
                      ${!model.active &&
                      html`<button class="btn-secondary btn-small" onClick=${() => handleActivate(model.id)}>
                        Use
                      </button>`}
                      <button class="btn-quiet btn-small" onClick=${() => handleRemove(model.id)}>
                        Remove
                      </button>
                    `
                  : html`<button
                      class="btn-secondary btn-small"
                      disabled=${!binaryAvailable}
                      onClick=${() => handleInstall(model.id)}
                    >
                      Install
                    </button>`}
            </span>
          </div>
        `;
  }

  const modelList = html`<div class="list-group">${models.map(renderModelRow)}</div>`;
  const activeModel = models.find((m) => m.active);
  const anyInstalling = Boolean(progress && progress.phase !== "done" && progress.phase !== "error");

  // Settings shows the model as one row; the full list opens from Change…
  // (and stays open while a download is running, so its progress is visible).
  const modelSection = html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Speech model</div>
        <div class="preference-description">
          ${activeModel
            ? activeModel.id === recommendation.modelId
              ? "Runs on this Mac. Recommended for your GPU."
              : "Runs on this Mac."
            : recommendation.reason}
        </div>
      </div>
      <div class="preference-row-actions">
        <span class="preference-value">${activeModel ? `${activeModel.id} · ${formatBytes(activeModel.bytes)}` : "none"}</span>
        <button
          class="btn-secondary btn-small"
          aria-expanded=${showAllModels}
          onClick=${() => setShowAllModels(!showAllModels)}
        >
          ${showAllModels ? "Done" : activeModel ? "Change…" : "Choose…"}
        </button>
      </div>
    </div>
    ${(showAllModels || anyInstalling) && html`<div class="dictation-model-list">${modelList}</div>`}
  `;

  const preferenceRows = html`
    <div class="preference-row">
      <div>
        <div class="preference-title">Type the transcript for me</div>
        <div class="preference-description">
          Off copies it to the clipboard instead.
        </div>
      </div>
      <${Toggle}
        checked=${settings.insertMode === "paste"}
        label="Type the transcript for me"
        onChange=${(on) => patchSettings({ insertMode: on ? "paste" : "clipboard" })}
      />
    </div>
    <div class="preference-row">
      <div>
        <div class="preference-title">Keep recordings</div>
        <div class="preference-description">
          Audio is deleted after transcribing. Transcripts are always saved.
        </div>
      </div>
      <${Toggle}
        checked=${settings.keepAudio}
        label="Keep recordings"
        onChange=${(on) => patchSettings({ keepAudio: on })}
      />
    </div>
    <div class="dictation-prompt-row">
      <div class="preference-title">Transcription prompt</div>
      <div class="preference-description">
        Words whisper should expect, like names, code identifiers and file paths. It shapes the
        vocabulary; it isn't an instruction, so "remove filler words" won't work.
      </div>
      <textarea
        class="dictation-prompt"
        rows="4"
        value=${promptDraft}
        onInput=${(e) => setPromptDraft(e.target.value)}
        onBlur=${savePrompt}
      ></textarea>
      <div class="dictation-prompt-actions">
        ${promptDraft !== settings.vocabulary
          ? html`<button class="btn-secondary btn-small" onClick=${savePrompt}>Save prompt</button>`
          : html`<span class="preference-description">Saved</span>`}
        <button class="btn-quiet btn-small" onClick=${resetPrompt}>Reset to default</button>
      </div>
    </div>
  `;

  if (!onComplete) {
    return html`
      ${engineCard} ${modelSection}
      ${error && html`<p class="setup-error">${error}</p>`}
      ${anyInstalled ? preferenceRows : null}
    `;
  }

  // Onboarding leads with a single recommended model rather than the full
  // catalog: a new user shouldn't have to weigh four speech models to try
  // the feature. The rest are one click away in a menu. The card follows
  // whichever model is downloading or active, so a different pick shows too.
  const recommended = models.find((m) => m.id === recommendation.modelId);
  const cardModel =
    models.find((m) => progress?.modelId === m.id) ?? models.find((m) => m.active) ?? recommended;
  const downloading = Boolean(progress && progress.phase !== "done" && progress.phase !== "error");
  const cardInstalling = downloading && progress.modelId === cardModel?.id;
  const shortcutGlyphs = dictateShortcut
    .split("+")
    .map((part) => ({ Alt: "⌥", Option: "⌥", Command: "⌘", CommandOrControl: "⌘", Control: "⌃", Shift: "⇧" })[part] ?? part)
    .join("");

  const finishLabel = anyInstalled || downloading ? "Finish setup" : "Skip for now";
  const pct =
    cardInstalling && progress.phase === "downloading" && progress.totalBytes
      ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
      : null;

  return html`
    <div class="setup-step">
      <h2>Dictate anywhere</h2>
      <p>
        Press ${shortcutGlyphs}, talk, and Clance types what you said where your cursor is. Optional,
        and it never leaves this Mac.
      </p>
      ${engineCard}
      ${cardModel &&
      html`
        <div class="model-card">
          <div class="model-card-head">
            <span class="model-card-name">${cardModel.id}</span>
            <span class="model-card-tag ${cardModel.installed ? "model-card-tag-ok" : ""}">
              ${cardModel.active
                ? "active"
                : cardModel.installed
                  ? "installed"
                  : cardModel.id === recommendation.modelId
                    ? "recommended for this Mac"
                    : ""}
            </span>
            <span class="model-card-spacer"></span>
            ${cardInstalling
              ? html`<button class="btn-quiet btn-small" onClick=${() => window.clanceApp.cancelDictationInstall(cardModel.id)}>
                  Cancel
                </button>`
              : cardModel.installed
                ? !cardModel.active &&
                  html`<button class="btn-secondary btn-small" onClick=${() => handleActivate(cardModel.id)}>Use</button>`
                : html`<button
                    class="btn-secondary btn-small"
                    disabled=${!binaryAvailable}
                    onClick=${() => handleInstall(cardModel.id)}
                  >
                    Install
                  </button>`}
          </div>
          <span class="model-card-text">
            ${cardModel.id === recommendation.modelId ? recommendation.reason : cardModel.note}
          </span>
          ${cardInstalling &&
          html`
            <div class="model-card-progress">
              <div class="model-card-progress-row">
                <span>${progress.phase === "downloading" ? "downloading" : progressLabel(progress)}</span>
                <span class="model-card-progress-detail">
                  ${pct === null
                    ? ""
                    : `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)} · ${pct}%`}
                </span>
              </div>
              <span class="progress" role="progressbar" aria-valuenow=${pct ?? undefined}>
                <span
                  class="progress-fill ${pct === null ? "progress-fill-indeterminate" : ""}"
                  style=${`width: ${pct ?? 100}%`}
                ></span>
              </span>
            </div>
          `}
        </div>
      `}
      <div class="model-menu-wrap">
        <button
          class="btn-quiet btn-small setup-more"
          aria-haspopup="menu"
          aria-expanded=${showAllModels}
          onClick=${() => setShowAllModels(!showAllModels)}
        >
          Use a different model
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        ${showAllModels &&
        html`
          <div class="menu model-menu" role="menu">
            ${models.map(
              (model) => html`
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked=${model.id === cardModel?.id}
                  onClick=${() => {
                    setShowAllModels(false);
                    if (model.installed) handleActivate(model.id);
                    else handleInstall(model.id);
                  }}
                >
                  <span class="menu-check">${model.id === cardModel?.id ? "✓" : ""}</span>
                  <span class="menu-item-title">${model.id}</span>
                  <span class="menu-item-detail">
                    ${[
                      formatBytes(model.bytes),
                      model.id === recommendation.modelId ? "recommended" : model.installed ? "installed" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              `
            )}
          </div>
        `}
      </div>
      ${micCard}
      ${error && html`<p class="setup-error">${error}</p>`}
      <div class="setup-step-actions">
        ${downloading &&
        !anyInstalled &&
        html`<span class="setup-step-actions-status mono-label">download continues if you finish</span>`}
        ${onBack && html`<button class="btn-quiet" onClick=${onBack}>Back</button>`}
        <button class=${anyInstalled || downloading ? "btn-primary" : "btn-secondary"} onClick=${onComplete}>
          ${finishLabel}${(anyInstalled || downloading) && html` <span class="key-hint">↩</span>`}
        </button>
      </div>
    </div>
  `;
}
