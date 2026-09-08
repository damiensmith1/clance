// Lightweight Redux-shaped store for the main window's pane/tab layout —
// a single tree (`root`), a plain-object reducer, and subscriber-based
// updates. Not the real Redux: this app has no bundler and vendors its own
// dependencies (see docs/design.md), so a ~200-line hand-rolled store beats
// adding a dependency to vendor for what's a small, local piece of state.
//
// Tree shape:
//   leaf:  { id, type: "leaf", tabs: [tab...], activeTabId }
//   split: { id, type: "split", direction: "row"|"column", sizes: [n...], children: [node...] }
// `sizes` are flex-grow weights for `children`, same length/order, summing to 100.
//
// Panes are capped at 4 leaves total (product decision — keeps the layout
// legible and the persisted tree small) — see MAX_PANES.

import { nextTerminalId } from "../sections/TerminalSection.js";

export const MAX_PANES = 4;

let idCounter = 0;
function genId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

export const HOME_TAB = { id: "chats", type: "chats", label: "Sessions", icon: "chat" };

function makeLeaf(tabs, activeTabId) {
  return { id: genId("pane"), type: "leaf", tabs, activeTabId };
}

function initialState() {
  const leaf = makeLeaf([HOME_TAB], HOME_TAB.id);
  return { root: leaf, activePaneId: leaf.id };
}

// ---- tree helpers (all pure, return new nodes) ----

export function findPane(node, id) {
  if (node.id === id) return node;
  if (node.type !== "split") return null;
  for (const child of node.children) {
    const found = findPane(child, id);
    if (found) return found;
  }
  return null;
}

function paneExists(node, id) {
  return findPane(node, id) !== null;
}

function findFirstLeaf(node) {
  if (node.type === "leaf") return node;
  return findFirstLeaf(node.children[0]);
}

export function countLeaves(node) {
  if (node.type === "leaf") return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

// Layout is deliberately restricted to a fixed shape (product decision):
// the root may split once, and each of its two halves may independently
// split once more, perpendicular to the first split. That's exactly a 2x2
// grid, a 1-and-2 split on either side, in either direction — and nothing
// else (no 3-in-a-row, no deeper nesting). Enforced generically here
// rather than by special-casing "same direction" vs. "outer" vs. "inner"
// at each call site: every split-producing action computes its candidate
// tree first and this validates the *result*, so one rule covers all of
// them. `parentDirection` set (not null) means `node` is itself nested
// under another split — a split may not repeat that direction (that would
// just be an uneven way of faking a 3rd/4th pane in the same row/column).
function isValidShape(node, depth = 0, parentDirection = null) {
  if (node.type === "leaf") return true;
  if (depth >= 2) return false;
  if (node.children.length !== 2) return false;
  if (parentDirection && node.direction === parentDirection) return false;
  return node.children.every((c) => isValidShape(c, depth + 1, node.direction));
}

// Replace the leaf with id `paneId` via `fn(leaf) -> leaf`. No-op if not found.
function updateLeaf(node, paneId, fn) {
  if (node.type === "leaf") {
    return node.id === paneId ? fn(node) : node;
  }
  return { ...node, children: node.children.map((c) => updateLeaf(c, paneId, fn)) };
}

// Remove the pane (leaf or split) with id `paneId` from the tree, collapsing
// its parent split when only one child remains. Returns null if the whole
// tree was the removed pane (caller must fall back to a fresh default leaf).
function removePane(node, paneId) {
  if (node.id === paneId) return null;
  if (node.type === "leaf") return node;
  const idx = node.children.findIndex((c) => paneExists(c, paneId));
  if (idx === -1) return node;
  const childResult = removePane(node.children[idx], paneId);
  if (childResult === null) {
    const removedSize = node.sizes[idx];
    const remainingChildren = node.children.filter((_, i) => i !== idx);
    const remainingSizes = node.sizes.filter((_, i) => i !== idx);
    const total = remainingSizes.reduce((a, b) => a + b, 0) || 1;
    const redistributed = remainingSizes.map((s) => s + (removedSize * s) / total);
    if (remainingChildren.length === 1) return remainingChildren[0];
    return { ...node, children: remainingChildren, sizes: redistributed };
  }
  const children = [...node.children];
  children[idx] = childResult;
  return { ...node, children };
}

// Removes `tabId` from `fromPaneId`'s tabs — the shared first step of both
// MOVE_TAB and SPLIT_PANE (a split, in the end, just relocates a tab out of
// its pane same as a move does). If that was the pane's only tab, the pane
// itself is removed from the tree (`removePane`, which can collapse a
// parent split down to its one remaining child — see the `SPLIT_PANE`
// comment on retargeting for why callers need to handle that).
function removeTabFromTree(root, fromPaneId, tabId) {
  const fromPane = findPane(root, fromPaneId);
  const rootWithoutTab =
    fromPane.tabs.length === 1
      ? removePane(root, fromPaneId) ?? initialState().root
      : updateLeaf(root, fromPaneId, (leaf) => ({
          ...leaf,
          tabs: leaf.tabs.filter((t) => t.id !== tabId),
          activeTabId: leaf.activeTabId === tabId ? leaf.tabs.find((t) => t.id !== tabId)?.id : leaf.activeTabId,
        }));
  return { rootWithoutTab };
}

// Wraps `existingNode` (a leaf, or — for an outer/whole-layout split — a
// split node itself) in a new split alongside `newLeaf`. This is the only
// way `applySplit` below ever grows the tree: it's deliberately not
// direction-aware (no "already running this direction, so extend it with a
// 3rd/4th evenly-reflowed child" case) because that shape — 3-in-a-row,
// however it's produced — isn't one of the layouts this app supports; see
// `isValidShape`, which is what actually rejects it, uniformly, rather than
// this function trying to avoid producing it in the first place.
function wrapAsSplit(existingNode, edge, newLeaf) {
  const direction = edge === "left" || edge === "right" ? "row" : "column";
  const children = edge === "left" || edge === "top" ? [newLeaf, existingNode] : [existingNode, newLeaf];
  return { id: genId("pane"), type: "split", direction, sizes: [50, 50], children };
}

// Split `targetId` along `edge` by wrapping it (leaf or split, including
// the root for an outer/whole-layout split) in a new split alongside
// `newLeaf`. Callers must validate the result with `isValidShape` — this
// function doesn't enforce the shape constraint itself, just locates the
// target and wraps it.
function applySplit(node, targetId, edge, newLeaf) {
  if (node.id === targetId) return wrapAsSplit(node, edge, newLeaf);
  if (node.type === "leaf") return node;
  const idx = node.children.findIndex((c) => paneExists(c, targetId));
  if (idx === -1) return node;
  const child = node.children[idx];
  const children = [...node.children];
  children[idx] = child.id === targetId ? wrapAsSplit(child, edge, newLeaf) : applySplit(child, targetId, edge, newLeaf);
  return { ...node, children };
}

// An outer/whole-layout split targets the root. If the dragged tab was its
// pane's only tab *and* that pane was one of the root split's own two
// direct children, removing it collapses the root down to just the other
// child — `targetPaneId` (captured before the drop, naming the *old* root)
// no longer exists, even though "split the whole layout" still perfectly
// well applies to whatever the layout now consists of. Resolves to the new
// root in that case rather than treating the target as gone; returns null
// only when the target is genuinely gone (some other, unrelated pane).
function resolveEffectiveTarget(root, rootWithoutTab, targetPaneId) {
  if (paneExists(rootWithoutTab, targetPaneId)) return targetPaneId;
  return targetPaneId === root.id ? rootWithoutTab.id : null;
}

// Advisory check for the UI: would dragging `tabId` out of `fromPaneId` and
// splitting `targetPaneId` along `edge` actually be accepted? Lets the
// drop-zone overlays only offer edges that would do something, instead of
// accepting a drop that silently no-ops. Mirrors the reducer's own
// SPLIT_PANE checks exactly (including the tab-removal simulation above)
// rather than a simplified approximation, so the UI and reducer can't
// disagree — the reducer remains the authority regardless.
export function canSplitAt(root, fromPaneId, tabId, targetPaneId, edge) {
  const fromPane = findPane(root, fromPaneId);
  if (!fromPane?.tabs.some((t) => t.id === tabId)) return false;
  if (fromPaneId === targetPaneId && fromPane.tabs.length === 1) return false;
  const { rootWithoutTab } = removeTabFromTree(root, fromPaneId, tabId);
  const effectiveTargetId = resolveEffectiveTarget(root, rootWithoutTab, targetPaneId);
  if (effectiveTargetId === null) return false;
  const probe = { id: "__probe__", type: "leaf", tabs: [], activeTabId: null };
  return isValidShape(applySplit(rootWithoutTab, effectiveTargetId, edge, probe));
}

function resizeSplitNode(node, splitId, sizes) {
  if (node.id === splitId) return { ...node, sizes };
  if (node.type !== "split") return node;
  return { ...node, children: node.children.map((c) => resizeSplitNode(c, splitId, sizes)) };
}

// ---- reducer ----

function reduce(state, action) {
  switch (action.type) {
    case "HYDRATE": {
      return action.state ?? state;
    }

    case "OPEN_TAB": {
      const paneId = action.paneId ?? state.activePaneId;
      const pane = findPane(state.root, paneId);
      if (!pane) return state;
      const existing = pane.tabs.find((t) => t.id === action.tab.id);
      if (existing) {
        if (action.reuseTabs) {
          const root = updateLeaf(state.root, paneId, (leaf) => ({ ...leaf, activeTabId: existing.id }));
          return { ...state, root, activePaneId: paneId };
        }
        const uniqueTab = { ...action.tab, id: `${action.tab.id}#${Date.now()}` };
        const root = updateLeaf(state.root, paneId, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs, uniqueTab],
          activeTabId: uniqueTab.id,
        }));
        return { ...state, root, activePaneId: paneId };
      }
      const root = updateLeaf(state.root, paneId, (leaf) => ({
        ...leaf,
        tabs: [...leaf.tabs, action.tab],
        activeTabId: action.tab.id,
      }));
      return { ...state, root, activePaneId: paneId };
    }

    case "ACTIVATE_TAB": {
      const root = updateLeaf(state.root, action.paneId, (leaf) => ({ ...leaf, activeTabId: action.tabId }));
      return { ...state, root, activePaneId: action.paneId };
    }

    case "ACTIVATE_PANE": {
      if (!paneExists(state.root, action.paneId)) return state;
      return { ...state, activePaneId: action.paneId };
    }

    case "CLOSE_TAB": {
      const pane = findPane(state.root, action.paneId);
      if (!pane) return state;
      const isOnlyPane = state.root.type === "leaf";
      if (isOnlyPane && pane.tabs.length <= 1) return state;
      const nextTabs = pane.tabs.filter((t) => t.id !== action.tabId);
      let root;
      if (nextTabs.length === 0) {
        root = removePane(state.root, action.paneId) ?? initialState().root;
      } else {
        const index = pane.tabs.findIndex((t) => t.id === action.tabId);
        const nextActive =
          pane.activeTabId === action.tabId
            ? (nextTabs[Math.max(0, index - 1)] ?? nextTabs[0]).id
            : pane.activeTabId;
        root = updateLeaf(state.root, action.paneId, (leaf) => ({
          ...leaf,
          tabs: nextTabs,
          activeTabId: nextActive,
        }));
      }
      const activePaneId = paneExists(root, state.activePaneId) ? state.activePaneId : findFirstLeaf(root).id;
      return { ...state, root, activePaneId };
    }

    case "MOVE_TAB": {
      const { tabId, fromPaneId, toPaneId, toIndex } = action;
      const fromPane = findPane(state.root, fromPaneId);
      const tab = fromPane?.tabs.find((t) => t.id === tabId);
      if (!tab) return state;
      if (fromPaneId === toPaneId) {
        const withoutTab = fromPane.tabs.filter((t) => t.id !== tabId);
        const reordered = [...withoutTab];
        reordered.splice(toIndex, 0, tab);
        const root = updateLeaf(state.root, fromPaneId, (leaf) => ({ ...leaf, tabs: reordered, activeTabId: tabId }));
        return { ...state, root, activePaneId: fromPaneId };
      }
      let root = removeTabFromTree(state.root, fromPaneId, tabId).rootWithoutTab;
      if (!paneExists(root, toPaneId)) return state;
      // Moving to a different pane unmounts the tab's TerminalSection in
      // its old pane (killing that pty) and mounts a new one in the new
      // pane — reusing the same terminalId there would race the two
      // instances' create/kill IPC calls against each other and could
      // leave the new pty killed out from under the just-reopened
      // terminal. A fresh id sidesteps the collision entirely; the CLI
      // session itself still reopens via the tab's unchanged `args`.
      const relocatedTab = tab.type === "terminal" ? { ...tab, terminalId: nextTerminalId() } : tab;
      root = updateLeaf(root, toPaneId, (leaf) => {
        const tabs = [...leaf.tabs];
        tabs.splice(Math.min(toIndex, tabs.length), 0, relocatedTab);
        return { ...leaf, tabs, activeTabId: tabId };
      });
      return { ...state, root, activePaneId: toPaneId };
    }

    case "SPLIT_PANE": {
      const { tabId, fromPaneId, targetPaneId, edge } = action;
      if (countLeaves(state.root) >= MAX_PANES) return state;
      const fromPane = findPane(state.root, fromPaneId);
      const tab = fromPane?.tabs.find((t) => t.id === tabId);
      if (!tab) return state;
      // Splitting a pane using its own only tab would empty it out from
      // under the split — degenerate, no-op.
      if (fromPaneId === targetPaneId && fromPane.tabs.length === 1) return state;
      const { rootWithoutTab } = removeTabFromTree(state.root, fromPaneId, tabId);
      const effectiveTargetId = resolveEffectiveTarget(state.root, rootWithoutTab, targetPaneId);
      if (effectiveTargetId === null) return state;
      // See the matching comment in MOVE_TAB — splitting always relocates
      // the tab into a brand-new pane, so its TerminalSection remounts
      // there; reusing the old terminalId would race the old pane's
      // kill-on-unmount against the new pane's create-on-mount.
      const relocatedTab = tab.type === "terminal" ? { ...tab, terminalId: nextTerminalId() } : tab;
      const newLeaf = makeLeaf([relocatedTab], relocatedTab.id);
      const root = applySplit(rootWithoutTab, effectiveTargetId, edge, newLeaf);
      if (!isValidShape(root)) return state;
      return { ...state, root, activePaneId: newLeaf.id };
    }

    case "RESIZE_SPLIT": {
      const root = resizeSplitNode(state.root, action.splitId, action.sizes);
      return { ...state, root };
    }

    default:
      return state;
  }
}

// ---- store ----

let state = initialState();
const listeners = new Set();

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    window.clanceApp.saveWindowLayout({ root: state.root, activePaneId: state.activePaneId });
  }, 400);
}

export function dispatch(action) {
  state = reduce(state, action);
  listeners.forEach((listener) => listener(state));
  schedulePersist();
}

// Re-key any terminal tabs with a fresh terminalId (a persisted pty id has
// no live process behind it once the app restarts) and drop anything that
// doesn't look like a well-formed node, falling back to `initialState()`.
function rehydrateNode(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "leaf") {
    if (!Array.isArray(node.tabs) || node.tabs.length === 0) return null;
    const tabs = node.tabs.map((tab) =>
      tab.type === "terminal" ? { ...tab, terminalId: nextTerminalId() } : tab
    );
    const activeTabId = tabs.some((t) => t.id === node.activeTabId) ? node.activeTabId : tabs[0].id;
    return { ...node, tabs, activeTabId };
  }
  if (node.type === "split" && Array.isArray(node.children) && node.children.length >= 2) {
    const children = node.children.map(rehydrateNode);
    if (children.some((c) => c === null)) return null;
    return { ...node, children };
  }
  return null;
}

export async function hydrateFromDisk() {
  let persisted = null;
  try {
    persisted = await window.clanceApp.getWindowLayout();
  } catch {
    persisted = null;
  }
  const root = persisted?.root ? rehydrateNode(persisted.root) : null;
  if (!root) return;
  const activePaneId = paneExists(root, persisted.activePaneId) ? persisted.activePaneId : findFirstLeaf(root).id;
  dispatch({ type: "HYDRATE", state: { root, activePaneId } });
}

// ---- action creators ----

export function openTab(tab, { paneId, reuseTabs = true } = {}) {
  dispatch({ type: "OPEN_TAB", tab, paneId, reuseTabs });
}

export function activateTab(paneId, tabId) {
  dispatch({ type: "ACTIVATE_TAB", paneId, tabId });
}

export function activatePane(paneId) {
  dispatch({ type: "ACTIVATE_PANE", paneId });
}

export function closeTab(paneId, tabId) {
  dispatch({ type: "CLOSE_TAB", paneId, tabId });
}

export function moveTab(tabId, fromPaneId, toPaneId, toIndex) {
  dispatch({ type: "MOVE_TAB", tabId, fromPaneId, toPaneId, toIndex });
}

export function splitPane(tabId, fromPaneId, targetPaneId, edge) {
  dispatch({ type: "SPLIT_PANE", tabId, fromPaneId, targetPaneId, edge });
}

export function resizeSplit(splitId, sizes) {
  dispatch({ type: "RESIZE_SPLIT", splitId, sizes });
}
