import { html, useEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { useTabState, useTabScroll } from "../state/tabState.js";

// Find in Files (⇧⌘F): a sidecar that searches every file under the Files
// folder with ripgrep (src/main/search.ts). Results stream in grouped by
// file; a new query cancels the one before it. Picking a result opens the file
// at that line.

const DEBOUNCE_MS = 250;

let nextId = 1;

const DEFAULT_OPTIONS = { query: "", caseSensitive: false, wholeWord: false, regex: false, include: "", exclude: "", includeIgnored: false };

/** Focuses the search box, from ⇧⌘F. */
export function focusSearchInput() {
  window.dispatchEvent(new CustomEvent("clance:focus-search"));
}

function Highlighted({ text, ranges }) {
  // Long lines are cut down around the first match, so it's always visible.
  const first = ranges[0]?.[0] ?? 0;
  const offset = first > 60 ? first - 40 : 0;
  const parts = [];
  let at = offset;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(html`<mark>${text.slice(Math.max(start, at), end)}</mark>`);
    at = end;
  }
  parts.push(text.slice(at));
  return html`<span class="search-line-text">${offset > 0 ? "…" : ""}${parts}</span>`;
}

function Toggle({ on, title, onToggle, children }) {
  return html`<button class="search-toggle ${on ? "is-on" : ""}" title=${title} aria-pressed=${on} onClick=${onToggle}>${children}</button>`;
}

export function SearchSection({ onOpenResult }) {
  // The search itself (query, toggles, globs) is the tab's persisted state,
  // saved with the layout; the results and what's collapsed are its live
  // state (state/tabState.js). Moving the tab or switching away keeps them all,
  // and doesn't run the same search again.
  const [options, setOptions] = useTabState("search.options", DEFAULT_OPTIONS, { persist: true });
  const [showFilters, setShowFilters] = useTabState("search.showFilters", false, { persist: true });
  const [root, setRoot] = useTabState("search.root", null);
  const [results, setResults] = useTabState("search.results", []);
  const [status, setStatus] = useTabState("search.status", null);
  const [collapsed, setCollapsed] = useTabState("search.collapsed", () => new Set());
  // What `results` are the answer to, so a remount knows not to search again.
  const [searched, setSearched] = useTabState("search.searched", null);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  const currentId = useRef(0);
  useTabScroll(resultsRef, "search.results", { version: searched });

  // The folder the Files sidecar is pointed at, or else the Changes
  // repository: search covers the project being looked at.
  useEffect(() => {
    (async () => {
      const folder = (await window.clanceApp.filesGetLastFolder()) ?? (await window.clanceApp.gitGetLastRepo());
      setRoot(folder ?? null);
    })();
    inputRef.current?.focus();
    const onFocusRequest = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("clance:focus-search", onFocusRequest);
    return () => window.removeEventListener("clance:focus-search", onFocusRequest);
  }, []);

  useEffect(() => {
    const stopResults = window.clanceApp.onSearchResults(({ id, matches }) => {
      if (id !== currentId.current) return;
      setResults((current) => [...current, ...matches]);
    });
    const stopDone = window.clanceApp.onSearchDone((done) => {
      if (done.id !== currentId.current) return;
      setStatus(done);
    });
    return () => {
      stopResults();
      stopDone();
      window.clanceApp.searchCancel();
    };
  }, []);

  // A pause in typing (or any toggle) starts a new search, which cancels the
  // one before it in the main process.
  useEffect(() => {
    if (!root) return;
    // Already the answer on screen (coming back to the tab) — unless it was
    // cut off mid-search by the tab going away.
    const signature = JSON.stringify([root, options]);
    if (signature === searched && !status?.running) return;
    const timer = setTimeout(() => {
      setSearched(signature);
      const id = nextId++;
      currentId.current = id;
      setResults([]);
      setCollapsed(new Set());
      if (!options.query) {
        setStatus(null);
        window.clanceApp.searchCancel();
        return;
      }
      setStatus({ running: true });
      window.clanceApp.searchStart(id, root, options);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [root, options]);

  const groups = useMemo(() => {
    const byPath = new Map();
    for (const match of results) {
      if (!byPath.has(match.path)) byPath.set(match.path, []);
      byPath.get(match.path).push(match);
    }
    return [...byPath.entries()];
  }, [results]);

  function set(patch) {
    setOptions((current) => ({ ...current, ...patch }));
  }

  function toggleGroup(path) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const rootName = root ? root.split("/").filter(Boolean).pop() : "";
  const summary = status?.running
    ? "Searching…"
    : status?.error
      ? status.error
      : status
        ? `${status.count} result${status.count === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"}${
            status.capped ? " — stopped at 5,000; narrow the search" : ""
          }`
        : root
          ? `Searches ${rootName}`
          : "Choose a folder in Files first";

  return html`
    <div class="search-pane">
      <div class="search-form">
        <div class="search-field">
          <span class="search-field-icon">${Icon.search(13)}</span>
          <input
            ref=${inputRef}
            class="search-input"
            placeholder="Find in files"
            value=${options.query}
            onInput=${(e) => set({ query: e.target.value })}
            onKeyDown=${(e) => {
              if (e.key === "Enter" && results[0]) onOpenResult(root, results[0].path, results[0].line);
            }}
          />
          <${Toggle} on=${options.caseSensitive} title="Match case" onToggle=${() => set({ caseSensitive: !options.caseSensitive })}>Aa</${Toggle}>
          <${Toggle} on=${options.wholeWord} title="Whole word" onToggle=${() => set({ wholeWord: !options.wholeWord })}>ab</${Toggle}>
          <${Toggle} on=${options.regex} title="Regular expression" onToggle=${() => set({ regex: !options.regex })}>.*</${Toggle}>
          <${Toggle} on=${showFilters} title="Files to include or exclude" onToggle=${() => setShowFilters(!showFilters)}>…</${Toggle}>
        </div>
        ${showFilters &&
        html`
          <input
            class="search-input search-glob"
            placeholder="files to include, e.g. src/**, *.ts"
            value=${options.include}
            onInput=${(e) => set({ include: e.target.value })}
          />
          <input
            class="search-input search-glob"
            placeholder="files to exclude, e.g. *.test.ts, dist"
            value=${options.exclude}
            onInput=${(e) => set({ exclude: e.target.value })}
          />
          <label class="search-check">
            <input type="checkbox" checked=${options.includeIgnored} onChange=${(e) => set({ includeIgnored: e.target.checked })} />
            Include files git ignores
          </label>
        `}
        <div class="search-summary ${status?.error ? "search-summary-error" : ""}">${summary}</div>
      </div>
      <div class="search-results" ref=${resultsRef}>
        ${groups.map(
          ([path, matches]) => html`
            <div class="search-group" key=${path}>
              <button class="search-file" onClick=${() => toggleGroup(path)} title=${path}>
                <span class="files-chevron ${collapsed.has(path) ? "" : "is-open"}">${Icon.chevronRight(11)}</span>
                <span class="search-file-name">${path.split("/").pop()}</span>
                <span class="search-file-dir">${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}</span>
                <span class="search-file-count">${matches.length}</span>
              </button>
              ${!collapsed.has(path) &&
              matches.map(
                (match) => html`
                  <button class="search-line" key=${`${path}:${match.line}`} onClick=${() => onOpenResult(root, path, match.line)}>
                    <span class="search-line-no">${match.line}</span>
                    <${Highlighted} text=${match.text} ranges=${match.ranges} />
                  </button>
                `
              )}
            </div>
          `
        )}
      </div>
    </div>
  `;
}
