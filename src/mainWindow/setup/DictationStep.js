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
    // compilation — see docs/dictation.md Phase 0), so it gets its own
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
export function DictationStep({ onComplete } = {}) {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [mic, setMic] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [promptDraft, setPromptDraft] = useState(null);

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
    setProgress({ modelId, phase: "downloading", receivedBytes: 0, totalBytes: 0 });
    window.clanceApp
      .installDictationModel(modelId)
      .then(refresh)
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

  const engineCard = !binaryAvailable
    ? html`
        <${StatusCard}
          ok=${false}
          title="Speech engine missing"
          description="whisper-cli wasn't found. In a dev build, install it with 'brew install whisper.cpp'."
        />
      `
    : null;

  const micCard = html`
    <${StatusCard}
      ok=${Boolean(mic)}
      title="Microphone"
      description=${mic
        ? "Clance can record audio for dictation."
        : "Required so Clance can hear you when you dictate."}
      actionLabel=${mic ? null : "Grant Access"}
      onAction=${handleMic}
    />
  `;

  const modelList = html`
    <div class="list-group">
      ${models.map((model) => {
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
                  ? html`<span class="dictation-badge">Active</span>`
                  : isRecommended
                    ? html`<span class="dictation-badge dictation-badge-muted">Recommended</span>`
                    : null}
              </span>
              <span class="item-card-description">${model.note}</span>
              <span class="item-card-meta">${metaLine(model, installing, progress)}</span>
            </span>
            <span class="item-card-actions">
              ${installing
                ? html`<button
                    class="btn-link"
                    onClick=${() => window.clanceApp.cancelDictationInstall(model.id)}
                  >
                    Cancel
                  </button>`
                : model.installed
                  ? html`
                      ${!model.active &&
                      html`<button class="btn-link" onClick=${() => handleActivate(model.id)}>
                        Use
                      </button>`}
                      <button class="btn-link" onClick=${() => handleRemove(model.id)}>
                        Remove
                      </button>
                    `
                  : html`<button
                      class="btn-primary btn-small"
                      disabled=${!binaryAvailable}
                      onClick=${() => handleInstall(model.id)}
                    >
                      Install
                    </button>`}
            </span>
          </div>
        `;
      })}
    </div>
  `;

  const modelSection = html`
    <div class="dictation-subsection">
      <div class="list-group-label">Speech model</div>
      <p class="preference-description dictation-recommendation">
        Recommended for this Mac: <strong>${
          (models.find((m) => m.id === recommendation.modelId) || {}).label
        }</strong> — ${recommendation.reason}
      </p>
      ${modelList}
    </div>
  `;

  const preferenceRows = html`
    <div class="dictation-subsection">
      <div class="list-group-label">Preferences</div>
    </div>
    <div class="preference-row">
      <div>
        <div class="preference-title">Type the transcript automatically</div>
        <div class="preference-description">
          ${settings.insertMode === "paste"
            ? "Dictated text is pasted straight into whatever app you're in."
            : "Dictated text is only copied to the clipboard — paste it yourself with ⌘V."}
        </div>
      </div>
      <${Toggle}
        checked=${settings.insertMode === "paste"}
        onChange=${(on) => patchSettings({ insertMode: on ? "paste" : "clipboard" })}
      />
    </div>
    <div class="preference-row">
      <div>
        <div class="preference-title">Keep the audio files too</div>
        <div class="preference-description">
          Your transcripts are always saved to History. This is about the raw
          recording, which is deleted right after it's transcribed unless you
          turn this on — only useful for debugging a mis-transcription.
        </div>
      </div>
      <${Toggle}
        checked=${settings.keepAudio}
        onChange=${(on) => patchSettings({ keepAudio: on })}
      />
    </div>
    <div class="dictation-prompt-row">
      <div class="preference-title">Transcription prompt</div>
      <div class="preference-description">
        Passed to whisper as its initial prompt. It primes the model's
        expected <em>vocabulary</em> — it is not an instruction the model
        follows, so terms and example phrasing help, but directions like
        "remove filler words" will not. Measurably improves code
        identifiers, camelCase, and file paths.
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
          ? html`<button class="btn-primary btn-small" onClick=${savePrompt}>Save prompt</button>`
          : html`<span class="preference-description">Saved</span>`}
        <button class="btn-link" onClick=${resetPrompt}>Reset to default</button>
      </div>
    </div>
  `;

  if (!onComplete) {
    return html`
      ${engineCard} ${micCard} ${modelSection}
      ${error && html`<p class="setup-error">${error}</p>`}
      ${anyInstalled ? preferenceRows : null}
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Set up dictation</h2>
      <p>
        Install a speech model and Clance can type what you say into any app, entirely on
        this Mac. You can skip this and come back later from Settings.
      </p>
      ${engineCard} ${micCard} ${modelSection}
      ${error && html`<p class="setup-error">${error}</p>`}
      <div class="setup-step-actions">
        <button class="btn-secondary" onClick=${onComplete}>
          ${anyInstalled ? "Continue" : "Skip for now"}
        </button>
      </div>
    </div>
  `;
}
