import { h, html, useEffect, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { DictationStep } from "../setup/DictationStep.js";

const TABS = [
  { id: "history", label: "History" },
  { id: "settings", label: "Setup & Models" },
];

// Presets rather than a date picker: dictation history is browsed by
// recency ("what did I say earlier today"), not by absolute date, and a
// custom range is available for the rare case that isn't enough.
const DATE_RANGES = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "custom", label: "Custom" },
];

// Local-date YYYY-MM-DD for a date input. Deliberately not toISOString():
// that converts to UTC first, which shifts the date for anyone west of
// Greenwich and would show "yesterday" for most of the evening.
function toDateInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Resolved at query time, not when the preset is picked, so "Today" stays
// correct across midnight without the UI having to re-derive it.
function resolveRange(rangeId, customFrom, customTo) {
  const now = new Date();
  switch (rangeId) {
    case "today": {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { from: start.getTime() };
    }
    case "7d":
      return { from: now.getTime() - 7 * 24 * 60 * 60 * 1000 };
    case "30d":
      return { from: now.getTime() - 30 * 24 * 60 * 60 * 1000 };
    case "custom": {
      const range = {};
      if (customFrom) range.from = new Date(`${customFrom}T00:00:00`).getTime();
      // Inclusive of the whole end day — a bare date parses to midnight,
      // which would otherwise exclude everything said that day.
      if (customTo) range.to = new Date(`${customTo}T23:59:59.999`).getTime();
      return range;
    }
    default:
      return {};
  }
}

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

function TranscriptRow({ transcript }) {
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
        <button
          class="icon-button dictation-copy"
          title=${copied ? "Copied" : "Copy transcript"}
          aria-label=${copied ? "Copied" : "Copy transcript"}
          onClick=${handleCopy}
        >
          ${copied ? Icon.checkCircle(15) : Icon.copy(15)}
        </button>
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
  const [rangeId, setRangeId] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const searchTimer = useRef(null);
  // The filter the *visible* list was built from. Bulk delete sends this
  // exact object, so "delete all of these" can't act on a stale filter if
  // the user edits the search box mid-confirm.
  const appliedFilter = useRef({});

  function buildFilter(searchQuery, range, from, to) {
    const filter = resolveRange(range, from, to);
    if (searchQuery.trim()) filter.query = searchQuery.trim();
    return filter;
  }

  // Single entry point for reloading the list: every filter control routes
  // through here so the list, the header count, and the bulk-delete target
  // are always derived from one filter.
  function load(searchQuery = query, range = rangeId, from = customFrom, to = customTo) {
    const filter = buildFilter(searchQuery, range, from, to);
    appliedFilter.current = filter;
    setConfirmingDeleteAll(false);
    window.clanceApp.dictationStats(filter).then(setStats);
    return window.clanceApp.queryTranscripts(filter, 200, 0).then(setTranscripts);
  }

  function refreshMeta() {
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
    // Re-runs the query rather than prepending: with a filter active, a new
    // transcript may not belong in the current view at all.
    return window.clanceApp.onNewTranscript(() => {
      load();
    });
  }, []);

  function handleQuery(value) {
    setQuery(value);
    // Debounced: every keystroke would otherwise run an FTS query over the
    // whole history.
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(value), 180);
  }

  function handleRange(id) {
    setRangeId(id);

    // Prefill the custom range the first time it's opened. Two reasons:
    // an empty date input renders Chromium's "yyyy-mm-dd" placeholder,
    // which can't be restyled and looks out of place; and landing on a
    // sensible month-long window is more useful than landing on a filter
    // that does nothing until both fields are set.
    if (id === "custom" && !customFrom && !customTo) {
      const now = new Date();
      const from = toDateInputValue(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
      const to = toDateInputValue(now);
      setCustomFrom(from);
      setCustomTo(to);
      load(query, id, from, to);
      return;
    }

    load(query, id, customFrom, customTo);
  }

  function handleCustomDate(which, value) {
    const from = which === "from" ? value : customFrom;
    const to = which === "to" ? value : customTo;
    if (which === "from") setCustomFrom(value);
    else setCustomTo(value);
    load(query, "custom", from, to);
  }

  function handleDeleteAll() {
    setDeleting(true);
    // Sends the filter the list was built from, not a freshly computed one.
    window.clanceApp.deleteTranscripts(appliedFilter.current).then(() => {
      setConfirmingDeleteAll(false);
      setDeleting(false);
      load();
    });
  }

  const isFiltered = Boolean(query.trim()) || rangeId !== "all";

  // Built as one JS string, not several template interpolations: htm
  // collapses the whitespace between adjacent expressions inside a flex
  // container, which rendered as "Delete 48matchingtranscripts?".
  const confirmCount = stats ? stats.count : 0;
  const confirmSentence =
    `Delete ${confirmCount} ${isFiltered ? "matching " : ""}` +
    `transcript${confirmCount === 1 ? "" : "s"}? This can't be undone.`;

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
                  ${stats
                    ? `${stats.count} transcript${stats.count === 1 ? "" : "s"}${
                        isFiltered ? " matching" : ""
                      }`
                    : "History"}
                </h2>
                ${stats && stats.count > 0
                  ? html`<span class="pill pill-muted">
                      ${formatDuration(stats.totalDurationMs)} dictated
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

              <div class="dictation-filters">
                <div class="segmented segmented-compact">
                  ${DATE_RANGES.map(
                    (r) => html`
                      <button
                        class="segmented-item ${rangeId === r.id ? "segmented-item-active" : ""}"
                        onClick=${() => handleRange(r.id)}
                      >
                        ${r.label}
                      </button>
                    `
                  )}
                </div>
                ${rangeId === "custom"
                  ? html`
                      <div class="dictation-custom-range">
                        <input
                          type="date"
                          class="dictation-date"
                          aria-label="From date"
                          title="Type a date, or use the arrow keys"
                          max=${customTo || undefined}
                          value=${customFrom}
                          onInput=${(e) => handleCustomDate("from", e.target.value)}
                        />
                        <span class="dictation-range-sep">–</span>
                        <input
                          type="date"
                          class="dictation-date"
                          aria-label="To date"
                          title="Type a date, or use the arrow keys"
                          min=${customFrom || undefined}
                          value=${customTo}
                          onInput=${(e) => handleCustomDate("to", e.target.value)}
                        />
                      </div>
                    `
                  : null}
                ${stats && stats.count > 0
                  ? html`
                      <div class="dictation-bulk">
                        ${confirmingDeleteAll
                          ? html`
                              <span class="preference-description">${confirmSentence}</span>
                              <button
                                class="btn-link dictation-danger"
                                disabled=${deleting}
                                onClick=${handleDeleteAll}
                              >
                                ${deleting ? "Deleting…" : "Yes, delete"}
                              </button>
                              <button
                                class="btn-link"
                                onClick=${() => setConfirmingDeleteAll(false)}
                              >
                                Cancel
                              </button>
                            `
                          : html`
                              <button
                                class="btn-link dictation-danger"
                                onClick=${() => setConfirmingDeleteAll(true)}
                              >
                                Delete all ${stats.count}
                              </button>
                            `}
                      </div>
                    `
                  : null}
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
                            <${TranscriptRow} key=${transcript.id} transcript=${transcript} />
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
