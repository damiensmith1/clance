import { html, useEffect, useMemo, useRef } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { fileIconUrl } from "../../shared/fileIcons.js";
import { useTabState, useTabScroll } from "../state/tabState.js";

// Search in the Files tab (⇧⌘F, or Find in Folder… on a folder): every file
// under the Files folder, or under one folder inside it, searched with
// ripgrep in the main process (src/main/search.ts). Results stream in grouped
// by file; a new query cancels the one before it. Picking a result opens the
// file at that line.
//
// The search itself (query, toggles, globs) is the tab's persisted state; the
// results and what's collapsed are its live state (state/tabState.js), so
// moving the tab, switching away, or going back to the tree and returning
// keeps them all, and doesn't run the same search again.

const DEBOUNCE_MS = 250;

let nextId = 1;

const DEFAULT_OPTIONS = { query: "", caseSensitive: false, wholeWord: false, regex: false, include: "", exclude: "", includeIgnored: false };

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

export function SearchToggle({ on, title, onToggle, children }) {
  return html`<button
    class="search-toggle ${on ? "is-on" : ""}"
    title=${title}
    aria-pressed=${on}
    onMouseDown=${(e) => e.preventDefault()}
    onClick=${onToggle}
  >
    ${children}
  </button>`;
}

/**
 * `scope` is a folder relative to `root` (null: all of it). `focusSignal`
 * changing puts the cursor in the field with the query selected.
 */
export function FolderSearch({ root, scope, focusSignal, onClearScope, onOpenResult, onClose }) {
  const [options, setOptions] = useTabState("search.options", DEFAULT_OPTIONS, { persist: true });
  const [showFilters, setShowFilters] = useTabState("search.showFilters", false, { persist: true });
  const [results, setResults] = useTabState("search.results", []);
  const [status, setStatus] = useTabState("search.status", null);
  const [collapsed, setCollapsed] = useTabState("search.collapsed", () => new Set());
  // What `results` are the answer to, so a remount knows not to search again.
  const [searched, setSearched] = useTabState("search.searched", null);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  const currentId = useRef(0);
  // Results of a new search replace the old ones when its first batch
  // arrives, not when it starts, so re-running one doesn't flash empty.
  const fresh = useRef(false);
  const signature = JSON.stringify([root, scope, options]);
  useTabScroll(resultsRef, "search.results", { version: searched });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  useEffect(() => {
    const stopResults = window.clanceApp.onSearchResults(({ id, matches }) => {
      if (id !== currentId.current) return;
      if (fresh.current) {
        fresh.current = false;
        setResults(matches);
      } else {
        setResults((current) => [...current, ...matches]);
      }
    });
    const stopDone = window.clanceApp.onSearchDone((done) => {
      if (done.id !== currentId.current) return;
      if (fresh.current) {
        fresh.current = false;
        setResults([]);
      }
      setStatus(done);
    });
    return () => {
      stopResults();
      stopDone();
      window.clanceApp.searchCancel(currentId.current);
    };
  }, []);

  function run(force) {
    if (!force && signature === searched && !status?.running) return;
    if (signature !== searched) setCollapsed(new Set());
    setSearched(signature);
    window.clanceApp.searchCancel(currentId.current);
    const id = nextId++;
    currentId.current = id;
    if (!options.query) {
      fresh.current = false;
      setResults([]);
      setStatus(null);
      return;
    }
    fresh.current = true;
    setStatus({ running: true });
    window.clanceApp.searchStart(id, root, options, scope);
  }

  // A pause in typing (or any toggle) starts a new search. Coming back to one
  // already answered doesn't — unless the tab went away mid-search.
  useEffect(() => {
    if (!root) return;
    const timer = setTimeout(() => run(false), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  // Sessions edit files while you look: the search runs again whenever the
  // window comes back to the front, the same moment the tree re-reads.
  useEffect(() => {
    const onFocus = () => {
      if (root && options.query) run(true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

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

  const summary = status?.running
    ? "Searching…"
    : status?.error
      ? status.error
      : status
        ? `${status.count} result${status.count === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"}${
            status.capped ? " — stopped at 5,000; narrow the search" : ""
          }`
        : null;

  return html`
    <div class="search-pane">
      <div class="search-form">
        <div class="search-field">
          <span class="search-field-icon">${Icon.search(13)}</span>
          <input
            ref=${inputRef}
            class="search-input"
            placeholder=${scope ? `Search in ${scope}` : "Search in folder"}
            value=${options.query}
            onInput=${(e) => set({ query: e.target.value })}
            onKeyDown=${(e) => {
              if (e.key === "Enter" && results[0]) onOpenResult(root, results[0].path, results[0].line);
              else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <${SearchToggle} on=${options.caseSensitive} title="Match case" onToggle=${() => set({ caseSensitive: !options.caseSensitive })}>Aa</${SearchToggle}>
          <${SearchToggle} on=${options.wholeWord} title="Whole word" onToggle=${() => set({ wholeWord: !options.wholeWord })}>ab</${SearchToggle}>
          <${SearchToggle} on=${options.regex} title="Regular expression" onToggle=${() => set({ regex: !options.regex })}>.*</${SearchToggle}>
          <${SearchToggle} on=${showFilters} title="Files to include or exclude" onToggle=${() => setShowFilters(!showFilters)}>…</${SearchToggle}>
        </div>
        ${scope &&
        html`<div class="search-scope">
          <span class="search-scope-label">in</span>
          <span class="search-scope-path" title=${scope}>${scope}</span>
          <button class="search-scope-clear" title="Search the whole folder" onClick=${onClearScope}>${Icon.close(10)}</button>
        </div>`}
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
        ${summary && html`<div class="search-summary ${status?.error ? "search-summary-error" : ""}">${summary}</div>`}
      </div>
      <div class="search-results" ref=${resultsRef}>
        ${groups.map(
          ([path, matches]) => html`
            <div class="search-group" key=${path}>
              <button class="search-file" onClick=${() => toggleGroup(path)} title=${path}>
                <span class="files-chevron ${collapsed.has(path) ? "" : "is-open"}">${Icon.chevronRight(11)}</span>
                <span class="files-row-icon"><img src=${fileIconUrl(path.split("/").pop())} alt="" /></span>
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
