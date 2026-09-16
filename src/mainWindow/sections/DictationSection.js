import { h, html, useEffect, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { DictationStep } from "../setup/DictationStep.js";

const TABS = [
  { id: "history", label: "History" },
  { id: "settings", label: "Setup & Models" },
];

function relativeTime(ms) {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(ms).toLocaleDateString();
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function TranscriptRow({ transcript, onDelete }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(transcript.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return html`
    <div class="item-card item-card-static">
      <span class="item-card-body">
        <span class="dictation-text">${transcript.text}</span>
        <span class="item-card-meta">
          ${relativeTime(transcript.createdAt)} · ${formatDuration(transcript.durationMs)} spoken ·
          transcribed in ${transcript.transcribeMs}ms · ${transcript.model}
          ${transcript.targetApp ? html` · into ${transcript.targetApp}` : null}
          ${!transcript.inserted
            ? html`<span class="pill pill-muted">clipboard only</span>`
            : null}
        </span>
      </span>
      <span class="item-card-actions">
        <button class="btn-link" onClick=${handleCopy}>${copied ? "Copied" : "Copy"}</button>
        <button class="btn-link" onClick=${() => onDelete(transcript.id)}>Delete</button>
      </span>
    </div>
  `;
}

export function DictationSection() {
  const [tab, setTab] = useState("history");
  const [transcripts, setTranscripts] = useState(null);
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [shortcut, setShortcut] = useState(null);
  const searchTimer = useRef(null);

  function load(searchQuery = "") {
    const request = searchQuery.trim()
      ? window.clanceApp.searchTranscripts(searchQuery)
      : window.clanceApp.listTranscripts(200, 0);
    return request.then(setTranscripts);
  }

  function refreshMeta() {
    window.clanceApp.dictationStats().then(setStats);
    window.clanceApp.dictationAvailability().then(setAvailability);
  }

  useEffect(() => {
    load();
    refreshMeta();
    // The configured accelerator, not the action's default, so the hint
    // can't drift from whatever the user rebound it to.
    window.clanceApp.getPreferences().then((prefs) => {
      setShortcut((prefs && prefs.shortcuts && prefs.shortcuts.dictate) || "Alt+D");
    });

    // Keeps an open tab live while dictation happens elsewhere in the OS.
    return window.clanceApp.onNewTranscript((transcript) => {
      setTranscripts((current) => (current ? [transcript, ...current] : [transcript]));
      refreshMeta();
    });
  }, []);

  function handleQuery(value) {
    setQuery(value);
    // Debounced: every keystroke would otherwise run an FTS query over the
    // whole history.
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(value), 180);
  }

  function handleDelete(id) {
    window.clanceApp.deleteTranscript(id).then(() => {
      setTranscripts((current) => current.filter((t) => t.id !== id));
      refreshMeta();
    });
  }

  const shortcutHint = (shortcut || "Alt+D")
    .replace("Alt", "⌥")
    .replace("CommandOrControl", "⌘")
    .replace("Command", "⌘")
    .replace("Control", "⌃")
    .replace("Shift", "⇧")
    .replace(/\+/g, "");

  return html`
    <div class="section-page">
      <h1 class="page-title">Dictation</h1>
      <p class="page-subtitle">
        Press <span class="kbd">${shortcutHint}</span> anywhere in macOS to talk. Clance
        transcribes on this Mac and types the result where your cursor is.
      </p>

      ${availability && !availability.ready
        ? html`
            <div class="status-card status-card-warn">
              <span class="status-card-icon">${Icon.warningTriangle(18)}</span>
              <span class="status-card-body">
                <span class="status-card-title">Dictation isn't ready yet</span>
                <span class="status-card-description">${availability.message}</span>
              </span>
              ${availability.reason === "no-model" &&
              html`<button class="btn-primary btn-small" onClick=${() => setTab("settings")}>
                Install a model
              </button>`}
            </div>
          `
        : null}

      <div class="segmented">
        ${TABS.map(
          (t) => html`
            <button
              class="segmented-item ${tab === t.id ? "segmented-item-active" : ""}"
              onClick=${() => setTab(t.id)}
            >
              ${t.label}
            </button>
          `
        )}
      </div>

      ${tab === "history"
        ? html`
            <section class="extension-group">
              <div class="group-title-row">
                <h2 class="group-title">
                  ${stats ? `${stats.count} transcript${stats.count === 1 ? "" : "s"}` : "History"}
                </h2>
                ${transcripts && transcripts.length > 0
                  ? html`<span class="pill pill-muted">
                      ${formatDuration(stats ? stats.totalDurationMs : 0)} dictated
                    </span>`
                  : null}
              </div>
              <div class="search-row">
                <div class="search-input">
                  ${Icon.search(16)}
                  <input
                    type="text"
                    placeholder="Search everything you've dictated…"
                    value=${query}
                    onInput=${(e) => handleQuery(e.target.value)}
                  />
                </div>
              </div>
              ${transcripts === null
                ? html`<p class="empty-note">Loading…</p>`
                : transcripts.length === 0
                  ? html`<p class="empty-note">
                      ${query
                        ? "Nothing matches that search."
                        : html`No transcripts yet. Press
                            <span class="kbd">${shortcutHint}</span> anywhere and start talking.`}
                    </p>`
                  : html`
                      <div class="list-group">
                        ${transcripts.map(
                          (transcript) => html`
                            <${TranscriptRow}
                              key=${transcript.id}
                              transcript=${transcript}
                              onDelete=${handleDelete}
                            />
                          `
                        )}
                      </div>
                    `}
            </section>
          `
        : html`
            <section class="extension-group">
              <${DictationStep} />
            </section>
          `}
    </div>
  `;
}
