import { html, useEffect, useLayoutEffect, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import {
  EditorView,
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  openSearchPanel,
  closeSearchPanel,
} from "../../shared/vendor/codemirror.mjs";
import { Icon } from "../../shared/icons.js";
import { SearchToggle } from "../components/FolderSearch.js";
import { onContent } from "./buffers.js";

// Find and replace in a file tab: a small bar floating over the top right of
// the editor, rather than CodeMirror's own panel, which takes a strip of the
// editor and pushes the code down. CodeMirror still does the work — the bar
// sets the search query and runs its find and replace commands — so ⌘G and
// ⇧⌘G keep working from the editor. CodeMirror draws match highlights only
// while its search panel is open, so the bar opens a hidden stand-in for one
// (setup.js) while it's up.
//
// The editor's keys (editor/setup.js) ask for the bar with `requestFind`; the
// file tab showing that editor opens it. Which editors have it open is kept
// here so Esc in the editor can close it.

const FIND_EVENT = "clance:editor-find";
const MAX_COUNT = 9999;

const openViews = new WeakSet();

/** ⌘F / ⌥⌘F in an editor: asks its tab to open the find bar. */
export function requestFind(view, replace = false) {
  window.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: { view, replace } }));
  return true;
}

/** Esc in an editor closes its find bar, if it has one open. */
export function closeFindFor(view) {
  if (!openViews.has(view)) return false;
  window.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: { view, close: true } }));
  return true;
}

/** Listens for find requests aimed at `view`. */
export function onFindRequest(view, callback) {
  const listener = (event) => {
    if (event.detail.view === view) callback(event.detail);
  };
  window.addEventListener(FIND_EVENT, listener);
  return () => window.removeEventListener(FIND_EVENT, listener);
}

export const DEFAULT_FIND = { query: "", replace: "", caseSensitive: false, wholeWord: false, regex: false, showReplace: false };

function queryOf(find) {
  return new SearchQuery({
    search: find.query,
    replace: find.replace,
    caseSensitive: find.caseSensitive,
    wholeWord: find.wholeWord,
    regexp: find.regex,
  });
}

/** How many matches, and which one the selection is on (1-based, 0 if none). */
function countMatches(view, query) {
  if (!query.search || !query.valid) return { total: 0, current: 0, capped: false };
  const { from, to } = view.state.selection.main;
  const cursor = query.getCursor(view.state);
  let total = 0;
  let current = 0;
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total += 1;
    if (step.value.from === from && step.value.to === to) current = total;
    if (total >= MAX_COUNT) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

/** Moves the selection to the first match at or after the cursor, wrapping. */
function selectNearest(view, query) {
  if (!query.search || !query.valid) return;
  const start = view.state.selection.main.from;
  let step = query.getCursor(view.state, start).next();
  if (step.done) step = query.getCursor(view.state, 0).next();
  if (step.done) return;
  const { from, to } = step.value;
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: "center" }),
    userEvent: "select.search",
  });
}

export function FindBar({ buffer, find, setFind, focusSignal, editable, onClose }) {
  const view = buffer.view;
  const inputRef = useRef(null);
  const [count, setCount] = useState({ total: 0, current: 0, capped: false });
  const query = queryOf(find);
  const refresh = () => setCount(countMatches(view, queryOf(find)));

  useEffect(() => {
    openViews.add(view);
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(queryOf(find)) });
    return () => {
      openViews.delete(view);
      // Closing takes the highlights with it.
      closeSearchPanel(view);
    };
  }, [view]);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  // Typing, or any toggle, sets the query and jumps to the nearest match, as
  // you type.
  useEffect(() => {
    view.dispatch({ effects: setSearchQuery.of(query) });
    selectNearest(view, query);
    refresh();
  }, [view, find.query, find.caseSensitive, find.wholeWord, find.regex]);

  useEffect(() => {
    view.dispatch({ effects: setSearchQuery.of(query) });
  }, [find.replace]);

  // The count follows edits made while the bar is open.
  useEffect(() => onContent(buffer, refresh), [buffer, find]);

  function set(patch) {
    setFind((current) => ({ ...current, ...patch }));
  }

  function run(command) {
    if (!query.search || !query.valid) return;
    command(view);
    refresh();
  }

  function onFindKey(event) {
    if (event.key === "Enter" || (event.key.toLowerCase() === "g" && event.metaKey)) {
      event.preventDefault();
      run(event.shiftKey ? findPrevious : findNext);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function onReplaceKey(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      run(event.metaKey ? replaceAll : replaceNext);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  const status = !find.query
    ? ""
    : !query.valid
      ? "invalid"
      : count.total === 0
        ? "no results"
        : count.current
          ? `${count.current} of ${count.total}${count.capped ? "+" : ""}`
          : `${count.total}${count.capped ? "+" : ""} result${count.total === 1 ? "" : "s"}`;

  return html`
    <div class="find-bar" role="search" onMouseDown=${(e) => e.stopPropagation()}>
      ${editable &&
      html`<button
        class="find-bar-twist ${find.showReplace ? "is-open" : ""}"
        title=${find.showReplace ? "Hide replace" : "Replace (⌥⌘F)"}
        onClick=${() => set({ showReplace: !find.showReplace })}
      >
        ${Icon.chevronRight(11)}
      </button>`}
      <div class="find-bar-rows">
        <div class="find-bar-row">
          <div class="search-field find-bar-field">
            <input
              ref=${inputRef}
              class="search-input"
              placeholder="Find"
              aria-label="Find"
              value=${find.query}
              onInput=${(e) => set({ query: e.target.value })}
              onKeyDown=${onFindKey}
            />
            <${SearchToggle} on=${find.caseSensitive} title="Match case" onToggle=${() => set({ caseSensitive: !find.caseSensitive })}>Aa</${SearchToggle}>
            <${SearchToggle} on=${find.wholeWord} title="Whole word" onToggle=${() => set({ wholeWord: !find.wholeWord })}>ab</${SearchToggle}>
            <${SearchToggle} on=${find.regex} title="Regular expression" onToggle=${() => set({ regex: !find.regex })}>.*</${SearchToggle}>
          </div>
          <span class="find-bar-count ${find.query && count.total === 0 ? "is-empty" : ""}">${status}</span>
          <button class="find-bar-button" title="Previous match (⇧↩)" disabled=${count.total === 0} onClick=${() => run(findPrevious)}>↑</button>
          <button class="find-bar-button" title="Next match (↩)" disabled=${count.total === 0} onClick=${() => run(findNext)}>↓</button>
          <button class="find-bar-button" title="Close (Esc)" onClick=${onClose}>${Icon.close(11)}</button>
        </div>
        ${editable &&
        find.showReplace &&
        html`
          <div class="find-bar-row">
            <div class="search-field find-bar-field">
              <input
                class="search-input"
                placeholder="Replace"
                aria-label="Replace"
                value=${find.replace}
                onInput=${(e) => set({ replace: e.target.value })}
                onKeyDown=${onReplaceKey}
              />
            </div>
            <button class="find-bar-button find-bar-text" title="Replace (↩)" disabled=${count.total === 0} onClick=${() => run(replaceNext)}>
              Replace
            </button>
            <button class="find-bar-button find-bar-text" title="Replace all (⌘↩)" disabled=${count.total === 0} onClick=${() => run(replaceAll)}>
              All
            </button>
          </div>
        `}
      </div>
    </div>
  `;
}
