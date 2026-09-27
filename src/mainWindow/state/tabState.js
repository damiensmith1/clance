import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
} from "../../shared/vendor/preact-htm-standalone.module.js";
import { getState, listTabs, setTabStateValue } from "./layoutStore.js";

// State that belongs to a tab rather than to the component drawing it.
//
// Moving a tab to another pane, splitting, or switching away and back
// unmounts whatever it shows. Anything in plain useState starts over — a
// search emptied, a peek closed, a list back at the top behind "Loading…".
// `useTabState(key, initial)` is useState scoped to the tab it's rendered in
// (the pane provides the tab's id through `TabContext`), whose value outlives
// the component:
//
// - **Live** values sit in memory for as long as the tab is open, and are
//   dropped when it closes (`dropTabState`). Data a section last showed goes
//   here, so a remount draws it at once while the section re-reads underneath.
// - **Persisted** values (`{ persist: true }`) are also written onto the tab
//   in the layout store (`tab.state`), so they're saved with the window
//   layout: they survive a relaunch, and ⇧⌘T brings them back with the tab.
//   Keep these small — a search, a filter, a scroll offset, where a file was
//   left — never data.
//
// Outside a tab (the setup wizard reuses Settings' panels) there's no tab id,
// and the hook is plain useState.

export const TabContext = createContext(null);

// tabId → Map(key → value)
const live = new Map();
// tabId → Set(key): live values that are still only the default, never set.
// A saved value wins over one of these — the window renders a default layout
// for a moment before the saved one is read, and a section mounted in that
// moment mustn't pin its defaults over what was saved.
const defaults = new Map();

function isDefault(tabId, key) {
  return defaults.get(tabId)?.has(key) ?? false;
}

function markDefault(tabId, key, on) {
  let keys = defaults.get(tabId);
  if (!keys) {
    if (!on) return;
    keys = new Set();
    defaults.set(tabId, keys);
  }
  if (on) keys.add(key);
  else keys.delete(key);
}
// `${tabId}\0${key}` → pending persist timer
const persistTimers = new Map();
const PERSIST_DEBOUNCE_MS = 300;

function tabById(tabId) {
  return listTabs(getState().root).find((entry) => entry.tab.id === tabId)?.tab ?? null;
}

function liveFor(tabId) {
  let values = live.get(tabId);
  if (!values) {
    values = new Map();
    live.set(tabId, values);
  }
  return values;
}

/** A tab's value: live first, then what the layout saved, then `fallback`. */
export function readTabState(tabId, key, fallback = undefined) {
  const values = live.get(tabId);
  if (values?.has(key)) return values.get(key);
  const saved = tabById(tabId)?.state?.[key];
  return saved !== undefined ? saved : fallback;
}

export function writeTabState(tabId, key, value, { persist = false } = {}) {
  // A closed tab's components report one last time as they unmount — after
  // the tab has gone from the layout and its state was already kept for
  // ⇧⌘T. Writing then would overwrite that with a half-torn-down view and
  // bring back memory for a tab that no longer exists.
  if (!tabId || !tabById(tabId)) return;
  liveFor(tabId).set(key, value);
  markDefault(tabId, key, false);
  if (!persist) return;
  // Written to the layout a beat later: scroll offsets change constantly.
  const timerKey = `${tabId}\0${key}`;
  clearTimeout(persistTimers.get(timerKey));
  persistTimers.set(
    timerKey,
    setTimeout(() => {
      persistTimers.delete(timerKey);
      setTabStateValue(tabId, key, value);
    }, PERSIST_DEBOUNCE_MS)
  );
}

/** Writes every pending persisted value now — before a reload or a close. */
export function flushTabState(tabId = null) {
  for (const [timerKey, timer] of persistTimers) {
    const [id, key] = timerKey.split("\0");
    if (tabId && id !== tabId) continue;
    clearTimeout(timer);
    persistTimers.delete(timerKey);
    setTabStateValue(id, key, live.get(id)?.get(key));
  }
}

/** A tab closed: its live state goes (its persisted state stays on the tab object ⇧⌘T keeps). */
export function dropTabState(tabId) {
  flushTabState(tabId);
  live.delete(tabId);
  defaults.delete(tabId);
}

/** A tab's id changed (a file renamed or moved): its state goes with it. */
export function rekeyTabState(fromId, toId) {
  flushTabState(fromId);
  const values = live.get(fromId);
  if (!values) return;
  live.delete(fromId);
  live.set(toId, values);
  if (defaults.has(fromId)) {
    defaults.set(toId, defaults.get(fromId));
    defaults.delete(fromId);
  }
}

export function useTabId() {
  return useContext(TabContext);
}

export function useTabState(key, initial, { persist = false } = {}) {
  const tabId = useContext(TabContext);
  const [value, setValue] = useState(() => {
    if (!tabId) return typeof initial === "function" ? initial() : initial;
    const values = liveFor(tabId);
    const saved = persist ? tabById(tabId)?.state?.[key] : undefined;
    if (values.has(key) && !(saved !== undefined && isDefault(tabId, key))) return values.get(key);
    if (saved !== undefined) {
      values.set(key, saved);
      markDefault(tabId, key, false);
      return saved;
    }
    // Kept from the first render, not only once set: a section that fills a
    // Map in place (the Changes pane's per-repository memory) needs the same
    // Map back on its next mount.
    const value = typeof initial === "function" ? initial() : initial;
    values.set(key, value);
    markDefault(tabId, key, true);
    return value;
  });
  const set = useCallback(
    (next) =>
      setValue((current) => {
        const value = typeof next === "function" ? next(current) : next;
        writeTabState(tabId, key, value, { persist });
        return value;
      }),
    [tabId, key, persist]
  );
  return [value, set];
}

/**
 * Keeps a scrolling element's offset as the tab's `scroll.<key>` (persisted)
 * and puts it back when the element mounts again. The offset is reapplied as
 * content settles — lists and images arrive after the first paint — and a
 * scroll that lands exactly where the restore put it is the restore's;
 * anything else is the person's.
 *
 * `version` names what's being scrolled (a peek's session): a saved offset
 * for a different version is ignored, and `onFirst` runs instead, as it does
 * when nothing is saved yet. `tabId` is for callers outside the tab's own
 * tree (the pane's page area).
 */
export function useTabScroll(ref, key, { tabId: explicitTabId = null, version = null, onFirst = null } = {}) {
  const contextTabId = useContext(TabContext);
  const tabId = explicitTabId ?? contextTabId;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !key || !tabId) return;
    const stateKey = `scroll.${key}`;
    const stored = readTabState(tabId, stateKey);
    const saved = stored && stored.version === version ? stored.top : undefined;
    let touched = false;
    let applied = null;
    const apply = () => {
      if (touched) return;
      if (saved === undefined) onFirst?.(element);
      else element.scrollTop = saved;
      applied = element.scrollTop;
    };
    apply();
    const settle = new ResizeObserver(apply);
    settle.observe(element);
    for (const child of element.children) settle.observe(child);
    const stopSettling = setTimeout(() => settle.disconnect(), 2000);
    const onScroll = () => {
      if (!touched && element.scrollTop === applied) return;
      touched = true;
      writeTabState(tabId, stateKey, { version, top: Math.round(element.scrollTop) }, { persist: true });
    };
    element.addEventListener("scroll", onScroll);
    return () => {
      settle.disconnect();
      clearTimeout(stopSettling);
      element.removeEventListener("scroll", onScroll);
    };
  }, [tabId, key, version]);
}

/** Keeps at most `limit` entries in a Map used as a cache, oldest first out. */
export function boundCache(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value);
  return map;
}
