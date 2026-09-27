import { useCallback, useLayoutEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";

// State that outlives the component holding it. Moving a tab to another
// pane, splitting, or switching away and back unmounts a section; anything in
// plain useState starts over — a search emptied, a peek closed, a list back at
// the top and "Loading…" again. `useRemembered` is useState whose value lives
// here instead, under a key, so a remount picks up where it was. It lasts as
// long as the app runs; the layout file is what survives a relaunch.
//
// Keys are global: prefix them with the section (`sessions.query`). Keep to
// what the person was doing and what saves a reload — not transient things
// like an open menu or a toast.

const memory = new Map();

export function useRemembered(key, initial) {
  const [value, setValue] = useState(() =>
    memory.has(key) ? memory.get(key) : typeof initial === "function" ? initial() : initial
  );
  const set = useCallback(
    (next) =>
      setValue((current) => {
        const value = typeof next === "function" ? next(current) : next;
        memory.set(key, value);
        return value;
      }),
    [key]
  );
  return [value, set];
}

/** A remembered value read outside a component, or `fallback`. */
export function recall(key, fallback = undefined) {
  return memory.has(key) ? memory.get(key) : fallback;
}

export function remember(key, value) {
  memory.set(key, value);
}

/**
 * Keeps a scrolling element's position under `key` and puts it back when the
 * element mounts again. The offset is reapplied as content settles (lists
 * arrive after the first paint); a scroll that lands exactly where the
 * restore put it is the restore's, anything else is the person's. `onFirst`
 * runs instead when nothing is remembered yet (a peek opening at its end).
 */
export function useRememberedScroll(ref, key, { onFirst = null } = {}) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !key) return;
    const saved = memory.get(`scroll:${key}`);
    let touched = false;
    let applied = null;
    const apply = () => {
      if (touched) return;
      if (saved === undefined) {
        onFirst?.(element);
      } else {
        element.scrollTop = saved;
      }
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
      memory.set(`scroll:${key}`, element.scrollTop);
    };
    element.addEventListener("scroll", onScroll);
    return () => {
      settle.disconnect();
      clearTimeout(stopSettling);
      element.removeEventListener("scroll", onScroll);
    };
  }, [key]);
}
