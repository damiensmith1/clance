import { h, html, useEffect, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";

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

// Short and mono, like the Sessions table: now, 6m, 2h, 3d, then a date.
function relativeTime(ms) {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

// An accelerator string ("Alt+D") as keycap labels (["⌥", "D"]).
function shortcutKeys(accelerator) {
  const glyphs = { Alt: "⌥", Option: "⌥", Command: "⌘", Cmd: "⌘", CommandOrControl: "⌘", Control: "⌃", Ctrl: "⌃", Shift: "⇧" };
  return (accelerator || "Alt+D").split("+").filter(Boolean).map((part) => glyphs[part] ?? part);
}

function TranscriptRow({ transcript, onDelete }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(transcript.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  const meta = [
    relativeTime(transcript.createdAt),
    formatDuration(transcript.durationMs),
    transcript.inserted ? transcript.targetApp : "clipboard only",
  ]
    .filter(Boolean)
    .join(" · ");

  return html`
    <div class="transcript-row">
      <div class="transcript-body">
        <span class="transcript-text">${transcript.text}</span>
        <span class="transcript-meta">${meta}</span>
      </div>
      <div class="transcript-actions">
        <button class="btn-quiet btn-small" onClick=${handleCopy}>${copied ? "Copied" : "Copy"}</button>
        <button class="btn-quiet btn-small" onClick=${() => onDelete(transcript.id)}>Delete</button>
      </div>
    </div>
  `;
}

// Setup — microphone, models, prompt, preferences — deliberately isn't
// here: it's rendered by SettingsSection from the same DictationStep
// component, and having it in two places meant two routes to the same
// controls. This tab is history only.
export function DictationSection({ onOpenSettings }) {
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

  function handleDeleteOne(id) {
    window.clanceApp.deleteTranscripts({ id }).then(() => load());
  }

  const isFiltered = Boolean(query.trim()) || rangeId !== "all";

  const confirmCount = stats ? stats.count : 0;

  const keycaps = shortcutKeys(shortcut).map((key) => html`<span class="kbd">${key}</span>`);
  // One JS string, not several template interpolations: htm collapses the
  // whitespace between adjacent expressions inside a flex container.
  const confirmTitle =
    `Delete ${isFiltered ? "" : "all "}${confirmCount} ${isFiltered ? "matching " : ""}` +
    `transcript${confirmCount === 1 ? "" : "s"}?`;

  return html`
    <div class="section-page">
      <header class="page-header">
        <h1 class="page-title">Dictation</h1>
        ${stats &&
        html`<span class="page-meta"
          >${`${stats.count} transcript${stats.count === 1 ? "" : "s"}${isFiltered ? " matching" : ""}` +
          (stats.count > 0 ? ` · ${formatDuration(stats.totalDurationMs)} spoken` : "")}</span
        >`}
        <span class="page-header-aside">Press ${keycaps} anywhere</span>
      </header>

      ${availability && !availability.ready
        ? html`
            <div class="notice notice-attention">
              <span class="status-dot session-dot-attention"></span>
              <span class="notice-body">
                <span class="notice-title">Dictation isn't set up yet</span>
                <span class="notice-text">${availability.message}</span>
              </span>
              ${onOpenSettings &&
              html`<button class="btn-secondary btn-small" onClick=${onOpenSettings}>Open Settings</button>`}
            </div>
          `
        : null}

      <div class="search-row">
        <label class="search-input">
          ${Icon.search(15)}
          <input
            type="text"
            placeholder="Search what you've said"
            aria-label="Search transcripts"
            value=${query}
            onInput=${(e) => handleQuery(e.target.value)}
          />
        </label>
        <div class="segmented" role="tablist" aria-label="Date range">
          ${DATE_RANGES.map(
            (r) => html`
              <button
                role="tab"
                aria-selected=${rangeId === r.id}
                class="segmented-item ${rangeId === r.id ? "segmented-item-active" : ""}"
                onClick=${() => handleRange(r.id)}
              >
                ${r.label}
              </button>
            `
          )}
        </div>
        ${stats && stats.count > 0
          ? html`<div class="dictation-bulk">
              <button class="btn-quiet" onClick=${() => setConfirmingDeleteAll(!confirmingDeleteAll)}>
                ${isFiltered ? "Delete matching…" : "Delete all…"}
              </button>
              ${confirmingDeleteAll &&
              html`
                <div class="confirm dictation-confirm" role="alertdialog" aria-label=${confirmTitle}>
                  <span class="confirm-title">${confirmTitle}</span>
                  <span class="confirm-body">They're removed from this Mac. This can't be undone.</span>
                  <div class="confirm-actions">
                    <button class="btn-quiet" onClick=${() => setConfirmingDeleteAll(false)}>Cancel</button>
                    <button class="btn-danger-filled" disabled=${deleting} onClick=${handleDeleteAll}>
                      ${deleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              `}
            </div>`
          : null}
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
              <span class="dictation-range-sep">to</span>
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

      ${transcripts === null
        ? html`<p class="empty-note">Loading transcripts…</p>`
        : transcripts.length === 0
          ? html`<p class="empty-note">
              ${query || rangeId !== "all"
                ? "Nothing matches that search."
                : html`No transcripts yet. Press ${keycaps} anywhere and start talking.`}
            </p>`
          : html`
              <div class="transcript-list">
                ${transcripts.map(
                  (transcript) => html`
                    <${TranscriptRow} key=${transcript.id} transcript=${transcript} onDelete=${handleDeleteOne} />
                  `
                )}
              </div>
            `}
    </div>
  `;
}
