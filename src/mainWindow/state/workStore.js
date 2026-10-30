import { useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";

// The Work model (src/main/work.ts), shared by everything that shows it — the
// Work tab, the Changes pane, a diff tab — so the window asks the main
// process once, not once per surface, and every surface sees the same
// answer. See docs/design.md's "Work".
//
// It's live only while something is looking: the first `retain` subscribes
// to the main process's repository watchers and starts polling (sessions
// change state without touching a file), the last `release` stops both. A
// snapshot that comes back identical to the last one changes nothing, so a
// quiet poll never re-renders anything.

/** How often running sessions are re-read while the window is visible. */
const POLL_MS = 5000;
/** A burst of repository changes is one refresh. */
const CHANGE_DEBOUNCE_MS = 300;

let snapshot = null;
let snapshotJson = "";
const snapshotListeners = new Set();
const repoListeners = new Set();
let holders = 0;
let timer = null;
let debounce = null;
let offChanged = null;
let inFlight = null;

export async function refreshWork() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const next = await window.clanceApp.workSnapshot();
      if (!next) return;
      const json = JSON.stringify(next);
      if (json === snapshotJson) return;
      snapshot = next;
      snapshotJson = json;
      for (const listener of snapshotListeners) listener(snapshot);
    } catch {
      // The next poll tries again.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function tick() {
  if (!document.hidden) refreshWork();
}

function retain() {
  holders += 1;
  if (holders === 1) {
    window.clanceApp.workSubscribe();
    timer = setInterval(tick, POLL_MS);
    offChanged = window.clanceApp.onWorkChanged((root) => {
      clearTimeout(debounce);
      debounce = setTimeout(refreshWork, CHANGE_DEBOUNCE_MS);
      if (root) for (const listener of repoListeners) listener(root);
    });
    document.addEventListener("visibilitychange", tick);
  }
  refreshWork();
  return () => {
    holders -= 1;
    if (holders > 0) return;
    clearInterval(timer);
    clearTimeout(debounce);
    offChanged?.();
    document.removeEventListener("visibilitychange", tick);
    window.clanceApp.workUnsubscribe();
  };
}

/** The current snapshot, kept current while the component is mounted. Null until the first one arrives. */
export function useWorkSnapshot() {
  const [value, setValue] = useState(snapshot);
  useEffect(() => {
    snapshotListeners.add(setValue);
    const release = retain();
    if (snapshot !== value) setValue(snapshot);
    return () => {
      snapshotListeners.delete(setValue);
      release();
    };
  }, []);
  return value;
}

/** Calls `listener(root)` when a watched repository changes on disk. */
export function useRepoChanged(listener, deps) {
  useEffect(() => {
    repoListeners.add(listener);
    const release = retain();
    return () => {
      repoListeners.delete(listener);
      release();
    };
  }, deps);
}

// ---- what the Changes pane is showing ----------------------------------------
//
// The Work tab sets it when a row is picked; the Changes pane shows it and
// can change it itself (its repository and branch menus). Kept across
// relaunches, as the last thing looked at.
//
//   { kind: "checkout", root, dir }      a folder: the repo's own or a worktree
//   { kind: "branch", root, branch }     a branch checked out nowhere
//   { kind: "session", sessionId, title } a past session's edits and commits

const FOCUS_KEY = "clance.work.focus";
let focus = (() => {
  try {
    return JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "null");
  } catch {
    return null;
  }
})();
const focusListeners = new Set();

export function getFocus() {
  return focus;
}

export function setFocus(next) {
  if (JSON.stringify(next) === JSON.stringify(focus)) return;
  focus = next;
  try {
    localStorage.setItem(FOCUS_KEY, JSON.stringify(next));
  } catch {
    // Remembering it is a convenience.
  }
  for (const listener of focusListeners) listener(focus);
}

export function useFocus() {
  const [value, setValue] = useState(focus);
  useEffect(() => {
    focusListeners.add(setValue);
    if (focus !== value) setValue(focus);
    return () => focusListeners.delete(setValue);
  }, []);
  return value;
}

/** The focus that shows a Work item. */
export function focusFor(item) {
  if (item.kind === "checkout") return { kind: "checkout", root: item.root, dir: item.checkout };
  if (item.kind === "branch") return { kind: "branch", root: item.root, branch: item.branch };
  return null;
}
