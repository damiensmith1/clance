import { html, useEffect, useRef, useState } from "../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../shared/icons.js";
import { ChatsListSection } from "./sections/ChatsSection.js";
import { SkillsSection } from "./sections/SkillsSection.js";
import { SettingsSection } from "./sections/SettingsSection.js";
import { TerminalSection, nextTerminalId } from "./sections/TerminalSection.js";
import {
  getState,
  subscribe,
  hydrateFromDisk,
  openTab,
  activateTab,
  activatePane,
  closeTab,
  moveTab,
  splitPane,
  resizeSplit,
  findPane,
  canSplitAt,
} from "./state/layoutStore.js";

const LAUNCHER_ITEMS = [
  { id: "chats", label: "Sessions", icon: "chat" },
  { id: "skills", label: "Skills & Plugins", icon: "puzzle" },
  { id: "settings", label: "Settings", icon: "gear" },
];

const EDGES = ["top", "right", "bottom", "left"];
const MIN_PANE_PCT = 15;
const PREVIEW_FRACTION = 0.32;
const DRAG_THRESHOLD_PX = 4;
// Must match the CSS trigger-strip widths (.pane-drop-edge-outer-*,
// .pane-drop-edge-*) — those are the visual affordance, this is the actual
// hit-test, computed independently (see the comment in hitTest() for why).
const OUTER_FRACTION = 0.1;
const INNER_FRACTION = 0.18;

function withinRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// Which edge of `rect` (if any) is `(x, y)` within `fraction` of — the
// closest one, when more than one threshold is met (a corner).
function edgeWithinRect(x, y, rect, fraction) {
  const threshX = rect.width * fraction;
  const threshY = rect.height * fraction;
  const candidates = [
    { edge: "left", dist: x - rect.left, thresh: threshX },
    { edge: "right", dist: rect.right - x, thresh: threshX },
    { edge: "top", dist: y - rect.top, thresh: threshY },
    { edge: "bottom", dist: rect.bottom - y, thresh: threshY },
  ].filter((c) => c.dist >= 0 && c.dist <= c.thresh);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0].edge;
}

// Preview rect for dropping on `edge` of `containerEl` (a pane's own
// content box for an inner/per-pane split, or the whole pane-area for an
// outer/whole-layout split), in pixels relative to `paneAreaEl`.
function computePreviewRect(paneAreaEl, containerEl, edge) {
  if (!paneAreaEl || !containerEl) return null;
  const area = paneAreaEl.getBoundingClientRect();
  const box = containerEl.getBoundingClientRect();
  const w = box.width * PREVIEW_FRACTION;
  const h = box.height * PREVIEW_FRACTION;
  switch (edge) {
    case "left":
      return { left: box.left - area.left, top: box.top - area.top, width: w, height: box.height };
    case "right":
      return { left: box.right - area.left - w, top: box.top - area.top, width: w, height: box.height };
    case "top":
      return { left: box.left - area.left, top: box.top - area.top, width: box.width, height: h };
    case "bottom":
      return { left: box.left - area.left, top: box.bottom - area.top - h, width: box.width, height: h };
    default:
      return null;
  }
}

function usePaneState() {
  const [state, setState] = useState(getState());
  useEffect(() => subscribe(setState), []);
  return state;
}

function tabIcon(tab) {
  return Icon[tab.icon] ? Icon[tab.icon](15) : null;
}

function renderTabContent(tab, openChatTab, openNewChatTab, onPopOut) {
  switch (tab.type) {
    case "chats":
      return html`<${ChatsListSection} onOpenChat=${openChatTab} onNewChat=${openNewChatTab} />`;
    case "skills":
      return html`<${SkillsSection} />`;
    case "settings":
      return html`<${SettingsSection} />`;
    case "terminal":
      // "attach <id>" (as opposed to "--resume") means this session is
      // already running as a background agent and this terminal is one of
      // potentially several clients sharing that single process — see the
      // isAttached comment in TerminalSection.js for why that changes how
      // resize is handled.
      return html`<${TerminalSection}
        terminalId=${tab.terminalId}
        args=${tab.args}
        isAttached=${tab.args?.[0] === "attach"}
        onPopOut=${onPopOut}
      />`;
    default:
      return null;
  }
}

function startDividerDrag(event, split, index) {
  event.preventDefault();
  const container = event.currentTarget.closest(".pane-split");
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const isRow = split.direction === "row";
  const total = isRow ? rect.width : rect.height;
  const startPos = isRow ? event.clientX : event.clientY;
  const startSizes = split.sizes;

  function onMove(moveEvent) {
    const pos = isRow ? moveEvent.clientX : moveEvent.clientY;
    const deltaPct = ((pos - startPos) / total) * 100;
    const sizes = [...startSizes];
    const a = Math.max(MIN_PANE_PCT, Math.min(startSizes[index] + deltaPct, startSizes[index] + startSizes[index + 1] - MIN_PANE_PCT));
    sizes[index] = a;
    sizes[index + 1] = startSizes[index] + startSizes[index + 1] - a;
    resizeSplit(split.id, sizes);
  }
  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function clearTabBarHighlight() {
  document.querySelectorAll(".tab-drop-before").forEach((el) => el.classList.remove("tab-drop-before"));
}

// The leaf occupying the window's actual top-left corner — its tab bar is
// the only one that ever sits under the traffic lights, so it's the only
// one that needs left clearance for them (see `.tab-bar-inset`). The tree
// always splits with children in visual left-to-right/top-to-bottom order
// (see layoutStore), so this is just "keep taking the first child."
function topLeftLeafId(node) {
  return node.type === "leaf" ? node.id : topLeftLeafId(node.children[0]);
}

// Mirror of the above for the top-right corner, where the launcher cluster
// lives: for a row split that's the last child (rightmost), for a column
// split it's still the first child (topmost — a column split's last child
// is the bottom one, not the top-right one).
function topRightLeafId(node) {
  if (node.type === "leaf") return node.id;
  const child = node.direction === "row" ? node.children[node.children.length - 1] : node.children[0];
  return topRightLeafId(child);
}

function PaneTree({ node, openChatTab, openNewChatTab, dragTab, startDrag, root, topLeftPaneId, launcher }) {
  if (node.type === "leaf") {
    return html`<${PaneLeaf}
      node=${node}
      openChatTab=${openChatTab}
      openNewChatTab=${openNewChatTab}
      dragTab=${dragTab}
      startDrag=${startDrag}
      root=${root}
      topLeftPaneId=${topLeftPaneId}
      launcher=${launcher}
    />`;
  }
  const items = [];
  node.children.forEach((child, i) => {
    items.push(html`
      <div key=${child.id} class="pane-split-child" style=${{ flex: `${node.sizes[i]} ${node.sizes[i]} 0` }}>
        <${PaneTree}
          node=${child}
          openChatTab=${openChatTab}
          openNewChatTab=${openNewChatTab}
          dragTab=${dragTab}
          startDrag=${startDrag}
          root=${root}
          topLeftPaneId=${topLeftPaneId}
          launcher=${launcher}
        />
      </div>
    `);
    if (i < node.children.length - 1) {
      items.push(html`
        <div
          key=${`${node.id}-divider-${i}`}
          class="pane-divider pane-divider-${node.direction}"
          onMouseDown=${(e) => startDividerDrag(e, node, i)}
        ></div>
      `);
    }
  });
  return html`<div class="pane-split pane-split-${node.direction}">${items}</div>`;
}

function PaneLeaf({ node, openChatTab, openNewChatTab, dragTab, startDrag, root, topLeftPaneId, launcher }) {
  const activeTab = node.tabs.find((t) => t.id === node.activeTabId) ?? node.tabs[0];
  const splittableEdges = dragTab
    ? EDGES.filter((edge) => canSplitAt(root, dragTab.paneId, dragTab.tabId, node.id, edge))
    : [];
  const showLauncher = node.id === launcher.topRightPaneId;

  // Closes this tab and reopens the same session in the popup widget —
  // window.clanceApp.openInWidget resumes it there via the same args this
  // terminal was opened with (a plain "--resume"/"attach" args array, so it
  // continues the same session rather than starting a new one).
  function popOutTab(tab) {
    window.clanceApp.openInWidget(tab.args ?? []);
    closeTab(node.id, tab.id);
  }

  return html`
    <div class="pane-leaf" onMouseDown=${() => activatePane(node.id)}>
      <div class="tab-bar ${node.id === topLeftPaneId ? "tab-bar-inset" : ""}" data-pane-id=${node.id}>
        ${node.tabs.map(
          (tab, i) => html`
            <button
              key=${tab.id}
              class="tab ${tab.id === node.activeTabId ? "tab-active" : ""}"
              onPointerDown=${(e) => startDrag(e, tab, node.id)}
            >
              <span class="tab-icon">${tabIcon(tab)}</span>
              <span class="tab-label">${tab.label}</span>
              <span
                class="tab-close"
                onPointerDown=${(e) => e.stopPropagation()}
                onClick=${(e) => {
                  e.stopPropagation();
                  closeTab(node.id, tab.id);
                }}
              >
                ${Icon.close(12)}
              </span>
            </button>
          `
        )}
        ${showLauncher &&
        html`
          <div class="tab-bar-spacer"></div>
          <div class="launcher-cluster">
            <span
              class="status-dot ${launcher.claudeConnected ? "status-dot-ok" : "status-dot-off"}"
              title=${launcher.claudeConnected ? "Claude Connected" : "Claude Disconnected"}
            ></span>
            ${LAUNCHER_ITEMS.map(
              (item) => html`
                <button
                  key=${item.id}
                  class="launcher-item ${launcher.activeSectionId === item.id ? "launcher-item-active" : ""}"
                  title=${item.label}
                  onClick=${() => launcher.openSection(item.id)}
                >
                  ${Icon[item.icon](15)}
                </button>
              `
            )}
          </div>
        `}
      </div>
      <main class="content ${activeTab?.type === "terminal" ? "content-chat" : ""}">
        ${activeTab &&
        renderTabContent(
          activeTab,
          openChatTab,
          openNewChatTab,
          // A brand-new, never-yet-run chat (empty args) has no resumable
          // session id yet — popping it out would silently start an
          // unrelated session in the widget rather than continuing this
          // one, so the button only appears once there's something to
          // actually resume.
          activeTab.args?.length ? () => popOutTab(activeTab) : undefined
        )}
        ${dragTab &&
        splittableEdges.length > 0 &&
        (dragTab.paneId !== node.id || node.tabs.length > 1) &&
        html`
          <div class="pane-drop-edges">
            ${splittableEdges.map(
              (edge) => html`
                <div
                  class="pane-drop-edge pane-drop-edge-${edge}"
                  data-drop-scope="inner"
                  data-pane-id=${node.id}
                  data-edge=${edge}
                ></div>
              `
            )}
          </div>
        `}
      </main>
    </div>
  `;
}

export function Shell() {
  const state = usePaneState();
  const [reuseTabs, setReuseTabs] = useState(true);
  const [claudeConnected, setClaudeConnected] = useState(null);
  const [dragTab, setDragTab] = useState(null);
  const paneAreaRef = useRef(null);
  const previewRef = useRef(null);

  function hidePreview() {
    if (previewRef.current) previewRef.current.style.display = "none";
  }

  function showPreview(containerEl, edge) {
    const rect = computePreviewRect(paneAreaRef.current, containerEl, edge);
    const el = previewRef.current;
    if (!el || !rect) return;
    el.style.display = "block";
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }

  // Tab drag-and-drop is implemented on plain Pointer Events — no native
  // HTML5 `draggable`/dragstart/dragover/drop/dragend anywhere. Chromium's
  // native drag-and-drop enters an OS-level nested run loop (NSDraggingSession
  // on macOS) for the duration of a drag; once that starts, mutating the
  // dragged element (which a cross-pane move does — it leaves its old pane)
  // races against that native teardown and can leave the browser's internal
  // drag state stuck, silently breaking every drag after it. A hand-rolled
  // pointer-based drag never enters that native session at all, so there's
  // nothing to race. (The pane-divider resize above already worked this way
  // and was never the source of this bug — this makes tabs consistent with
  // it.) `state.root`/pane ids are captured once at drag start and stay
  // valid for the whole gesture since the tree doesn't change until the drop is
  // actually applied on pointerup.
  function startDrag(event, tab, fromPaneId) {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let ghostEl = null;
    let pending = null;

    function moveGhost(x, y) {
      if (ghostEl) ghostEl.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
    }

    function hitTest(x, y) {
      clearTabBarHighlight();
      pending = null;
      hidePreview();

      // A tab-bar hit always wins, checked by geometry rather than
      // elementFromPoint's topmost-at-this-pixel result: the outer
      // whole-layout edge zones span the entire pane area, which includes
      // the row every pane's own tab-bar occupies (and, in a stacked
      // column layout, the left/right outer zones cross every tab-bar's
      // full width too) — so without this, dropping on a tab-bar that
      // happens to fall inside that band would split the layout instead
      // of just moving the tab into that pane.
      const tabBar = [...document.querySelectorAll(".tab-bar")].find((bar) => withinRect(x, y, bar.getBoundingClientRect()));
      if (tabBar) {
        const buttons = Array.from(tabBar.querySelectorAll(".tab"));
        let index = buttons.length;
        for (let i = 0; i < buttons.length; i++) {
          const rect = buttons[i].getBoundingClientRect();
          if (x < rect.left + rect.width / 2) {
            index = i;
            break;
          }
        }
        buttons.forEach((btn, i) => btn.classList.toggle("tab-drop-before", i === index));
        pending = { type: "move", toPaneId: tabBar.dataset.paneId, toIndex: index };
        return;
      }

      // Edge detection is pure geometry against the pane-area and each
      // pane's own content box — deliberately NOT `elementFromPoint`
      // finding the `.pane-drop-edge`/`.pane-drop-edge-outer` overlay
      // divs. Those only exist in the DOM once Preact has committed the
      // re-render triggered by crossing the drag threshold (`setDragTab`
      // above) — a real render, not instant — and a fast pointermove can
      // reach the target before that paint lands, finding nothing there
      // and silently missing the drop. Hit-testing geometry that's
      // already in the DOM regardless of drag state sidesteps the race
      // entirely; those divs remain purely for the `:hover` CSS highlight.
      if (!paneAreaRef.current) return;
      const areaRect = paneAreaRef.current.getBoundingClientRect();
      if (state.root.type === "split" && withinRect(x, y, areaRect)) {
        const edge = edgeWithinRect(x, y, areaRect, OUTER_FRACTION);
        if (edge && canSplitAt(state.root, fromPaneId, tab.id, state.root.id, edge)) {
          pending = { type: "split", targetPaneId: state.root.id, edge };
          showPreview(paneAreaRef.current, edge);
          return;
        }
      }
      const hit = [...document.querySelectorAll(".pane-leaf")]
        .map((leaf) => ({ tabBar: leaf.querySelector(".tab-bar"), content: leaf.querySelector(".content") }))
        .find(({ content }) => content && withinRect(x, y, content.getBoundingClientRect()));
      if (!hit) return;
      const targetPaneId = hit.tabBar?.dataset.paneId;
      if (!targetPaneId) return;
      const contentRect = hit.content.getBoundingClientRect();
      const edge = edgeWithinRect(x, y, contentRect, INNER_FRACTION);
      if (edge && canSplitAt(state.root, fromPaneId, tab.id, targetPaneId, edge)) {
        pending = { type: "split", targetPaneId, edge };
        showPreview(hit.content, edge);
      }
    }

    function onMove(e) {
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        setDragTab({ tabId: tab.id, paneId: fromPaneId });
        ghostEl = document.createElement("div");
        ghostEl.className = "tab-drag-ghost";
        ghostEl.textContent = tab.label;
        document.body.appendChild(ghostEl);
      }
      moveGhost(e.clientX, e.clientY);
      hitTest(e.clientX, e.clientY);
    }

    function finish() {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      ghostEl?.remove();
      clearTabBarHighlight();
      hidePreview();
      if (dragging && pending) {
        if (pending.type === "move") moveTab(tab.id, fromPaneId, pending.toPaneId, pending.toIndex);
        else if (pending.type === "split") splitPane(tab.id, fromPaneId, pending.targetPaneId, pending.edge);
      } else if (!dragging) {
        // Never crossed the drag threshold — this was a plain click.
        activateTab(fromPaneId, tab.id);
      }
      setDragTab(null);
    }

    function onCancel() {
      pending = null;
      finish();
    }

    function onKeyDown(e) {
      if (e.key === "Escape") onCancel();
    }

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
  }

  useEffect(() => {
    window.clanceApp.getPreferences().then((prefs) => setReuseTabs(prefs.reuseTabs));
    window.clanceApp.getSetupStatus().then((status) => setClaudeConnected(status.claude.loggedIn));
    hydrateFromDisk();
  }, []);

  // The popup widget's "Open in App" button hands off a still-running
  // session: the pty itself is reparented to this window (so the CLI
  // process isn't restarted and nothing in flight is lost) before the tab
  // is opened to receive its output.
  useEffect(() => {
    return window.clanceApp.onOpenSessionTab(async ({ terminalId, args, title }) => {
      await window.clanceApp.reparentTerminal(terminalId);
      openTab(
        { id: terminalId, type: "terminal", label: title ?? "New Chat", icon: "terminal", terminalId, args },
        { paneId: getState().activePaneId, reuseTabs }
      );
    });
  }, [reuseTabs]);

  function openSection(id) {
    const item = LAUNCHER_ITEMS.find((i) => i.id === id);
    openTab({ id, type: id, label: item.label, icon: item.icon }, { paneId: state.activePaneId, reuseTabs });
  }

  function openNewChatTab() {
    const terminalId = nextTerminalId();
    openTab(
      { id: terminalId, type: "terminal", label: "New Chat", icon: "terminal", terminalId, args: [] },
      { paneId: state.activePaneId, reuseTabs }
    );
  }

  async function openChatTab(session) {
    const terminalId = nextTerminalId();
    // A session already running as a background agent can't be resumed —
    // it needs `attach` instead; resolved on the main process via `claude
    // agents --json` since that's the source of truth for what's running.
    const args = await window.clanceApp.resolveOpenArgs(session.id);
    openTab(
      { id: `chat:${session.filePath}`, type: "terminal", label: session.title, icon: "terminal", terminalId, args },
      { paneId: state.activePaneId, reuseTabs }
    );
  }

  const activePane = findPane(state.root, state.activePaneId);
  const activeTab = activePane?.tabs.find((t) => t.id === activePane.activeTabId);
  const splittableOuterEdges =
    dragTab && state.root.type === "split"
      ? EDGES.filter((edge) => canSplitAt(state.root, dragTab.paneId, dragTab.tabId, state.root.id, edge))
      : [];

  const topLeftPaneId = topLeftLeafId(state.root);
  const topRightPaneId = topRightLeafId(state.root);
  const launcher = {
    topRightPaneId,
    claudeConnected,
    activeSectionId: activeTab?.type,
    openSection,
  };

  return html`
    <div class="shell">
      <div class="shell-main">
        <div class="pane-area" ref=${paneAreaRef}>
          <${PaneTree}
            node=${state.root}
            openChatTab=${openChatTab}
            openNewChatTab=${openNewChatTab}
            dragTab=${dragTab}
            startDrag=${startDrag}
            root=${state.root}
            topLeftPaneId=${topLeftPaneId}
            launcher=${launcher}
          />
          ${splittableOuterEdges.length > 0 &&
          html`
            <div class="pane-drop-edges-outer">
              ${splittableOuterEdges.map(
                (edge) => html`
                  <div
                    class="pane-drop-edge-outer pane-drop-edge-outer-${edge}"
                    data-drop-scope="outer"
                    data-edge=${edge}
                  ></div>
                `
              )}
            </div>
          `}
          <div class="pane-preview" ref=${previewRef} style=${{ display: "none" }}></div>
        </div>
      </div>
    </div>
  `;
}
