import { html, useEffect, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { useJevStatus } from "../settings/JevKeySettings.js";
import {
  ASK_EVENT,
  CHANGE_EVENT,
  CLOSE_EVENT,
  COMMAND_HELP,
  DEFAULT_KEYS,
  DIRTY_EVENT,
  MessageConnection,
  OPEN_EVENT,
  SELECT_EVENT,
  createView,
  lodeApi,
  serviceStorage,
} from "../../shared/vendor/lode-views.mjs";
import { highlightLine } from "../../shared/syntax.js";
import { useTabId, useTabState } from "../state/tabState.js";
import { renderMarkdown } from "../../shared/markdown.js";

// A Flow tab: a project's code read as cards on a canvas (lode, see
// docs/design.md's "Flow tabs"; the `lode-graph` package). lode runs per project folder in the main
// process's side (src/main/lode.ts); here is its canvas, <lode-flow>, with
// Clance as its host: a card's title opens the real file tab, code is
// coloured by Clance's highlighter, the canvas is saved with the project
// (lode's cache), and the toolbar, search and "Ask Claude" are Clance's.
//
// Like terminals, the canvas outlives the component: Shell renders only the
// active tab, so switching away unmounts FlowSection. The element and its
// project's connection live in the registries below, and only closing the
// tab (destroyFlow) ends them.

// root → { connection, api, tabs: Set(tabId), stop }: one connection per
// project, shared by its Flow tabs (lode's replies are matched by request
// id, so two connections on one channel would answer each other's calls).
const projects = new Map();
// tabId → { el, root, stateKey }
const flows = new Map();
// Shell's openers, kept current by every render (the host's hooks call them).
let current = null;
// tabId → what a new Flow tab starts with ({ id, ids, ask, diff }): used
// once, when its canvas is made, never saved (a relaunch restores the
// canvas instead of asking again).
const starts = new Map();

/** What a Flow tab about to open should show first. */
export function setFlowStart(tabId, request) {
  starts.set(tabId, request);
}

/** The innermost symbol at a line of a file (relative to `root`), to open
 *  a file tab's cursor in a flow. */
export async function symbolAt(root, file, line) {
  return projectFor(root).api.symbolAt(file, line).catch(() => null);
}

function projectFor(root) {
  let project = projects.get(root);
  if (project) return project;
  const connection = new MessageConnection({
    send: (message) => window.clanceApp.lodeSend(root, message),
    listen: (handler) => window.clanceApp.onLodeMessage((payload) => payload.root === root && handler(payload.message)),
  });
  project = { connection, api: lodeApi(connection), tabs: new Set(), status: null, listeners: new Set() };
  // A worker that failed: say so on every tab of the project.
  project.stopStatus = window.clanceApp.onLodeStatus((payload) => {
    if (payload.root !== root) return;
    project.status = payload.error || "lode stopped";
    for (const listener of project.listeners) listener();
  });
  projects.set(root, project);
  return project;
}

// lode wants HTML per line; Clance's highlighter goes a line at a time,
// carrying an open block comment from one line to the next.
function syntax(text, file) {
  const language = file.split(".").pop() ?? "txt";
  let state = { block: false };
  return text.split("\n").map((line) => {
    const out = highlightLine(line, language, state);
    state = out.state;
    return out.html;
  });
}
const SYNTAX_CSS = `
.tok-keyword { color: var(--lode-syntax-keyword); }
.tok-string { color: var(--lode-syntax-string); }
.tok-number { color: var(--lode-syntax-number); }
.tok-call { color: var(--lode-syntax-title); }
.tok-comment { color: var(--lode-syntax-comment); font-style: italic; }
`;

function flowFor(tab) {
  const existing = flows.get(tab.id);
  if (existing) return existing;
  const project = projectFor(tab.root);
  project.tabs.add(tab.id);
  const host = {
    openView: (request) => current?.openFlowTab(tab.root, { ...request, newTab: true }),
    // A card's title: the real file tab, even with this flow showing.
    openSource: (file, line) => current?.openFileTab(tab.root, file, line ?? null, { flow: false }),
    syntax,
    syntaxCss: SYNTAX_CSS,
    storage: serviceStorage(project.connection),
    empty: "Open a file or symbol: search above, “Open in lode” in Files, or “lode” on a file tab.",
    // Note cards' text (a model's system design, an explanation): Markdown,
    // sanitized (shared/markdown.js).
    renderNote: (text) => renderMarkdown(text),
    // Not on the whole window: Clance has other panes. The tab forwards keys
    // only while focus is in it (onFlowKey).
    keys: false,
  };
  const start = starts.get(tab.id) ?? {};
  starts.delete(tab.id);
  const el = createView({ kind: "flow", state: tab.stateKey, ...start }, project.connection, host);
  el.classList.add("flow-canvas");
  const entry = { el, root: tab.root, stateKey: tab.stateKey };
  flows.set(tab.id, entry);
  return entry;
}

/** The canvas of an open Flow tab, if it has been shown. */
export function flowOf(tabId) {
  return flows.get(tabId)?.el ?? null;
}

/** Closing a Flow tab: its canvas and, if it was the project's last, the
 *  project's lode. Its saved canvas stays (lode's cache), so ⇧⌘T brings
 *  the tab back as it was. */
export function destroyFlow(tabId) {
  const entry = flows.get(tabId);
  if (!entry) return;
  flows.delete(tabId);
  entry.el.remove();
  const project = projects.get(entry.root);
  if (!project) return;
  project.tabs.delete(tabId);
  if (project.tabs.size) return;
  projects.delete(entry.root);
  project.connection.close();
  project.stopStatus();
  window.clanceApp.lodeRelease(entry.root);
}

export function FlowSection({ tab, launcher }) {
  current = launcher;
  const tabId = useTabId();
  const hostRef = useRef(null);
  const entry = flowFor(tab);
  const flow = entry.el;
  const project = projectFor(tab.root);
  const [, redraw] = useState(0);
  const [ready, setReady] = useState(project.ready ?? false);
  const [help, setHelp] = useState(false);
  const toggleHelp = (open = !help) => setHelp(open);

  useEffect(() => {
    hostRef.current.appendChild(flow);
    const bump = () => redraw((n) => n + 1);
    const events = [CHANGE_EVENT, SELECT_EVENT, DIRTY_EVENT, ASK_EVENT, OPEN_EVENT, CLOSE_EVENT];
    for (const name of events) flow.addEventListener(name, bump);
    project.listeners.add(bump);
    // Keys go to the tab while focus is in it. lode keeps a click on the
    // canvas (panning, dragging a card) from moving focus, so the tab takes
    // it on pointerdown; and leaving a card's code (Esc) gives it back. The
    // menu hears whether the canvas has focus, for ⌘Z (appMenu.ts).
    const host = hostRef.current;
    const takeFocus = (event) => {
      if (!inCode(event)) host.focus({ preventScroll: true });
    };
    const report = () => {
      const on = host.matches(":focus-within") && !host.querySelector("lode-flow")?.shadowRoot?.activeElement?.isContentEditable;
      window.clanceApp.setFlowFocused?.(on);
    };
    const leftCode = (event) => {
      report();
      if (event.composedPath()[0]?.isContentEditable && !event.relatedTarget) setTimeout(() => !document.activeElement || document.activeElement === document.body ? host.focus({ preventScroll: true }) : null, 0);
    };
    host.addEventListener("pointerdown", takeFocus, true);
    host.addEventListener("focusin", report);
    host.addEventListener("focusout", leftCode);
    // The one pre-warmed session for Ask Claude follows the folder of the
    // lode tab being shown (lodePool.ts): warmed when this one shows, once
    // its project has been read.
    const warm = () => void window.clanceApp.lodeWarmSession?.(tab.root).catch(() => {});
    if (project.ready) warm();
    // Ready once lode has read the project (the first answer).
    if (!project.ready)
      void project.api
        .info()
        .then((info) => {
          project.ready = info;
          setReady(info);
          warm();
        })
        .catch(() => {});
    return () => {
      host.removeEventListener("pointerdown", takeFocus, true);
      host.removeEventListener("focusin", report);
      host.removeEventListener("focusout", leftCode);
      window.clanceApp.setFlowFocused?.(false);
      for (const name of events) flow.removeEventListener(name, bump);
      project.listeners.delete(bump);
      // Detach only: the canvas lives on until the tab closes.
      if (flows.get(tabId)?.el === flow) flow.remove();
    };
  }, [tab.id]);

  // The tab's label follows what it shows: its question, else its first card.
  useEffect(() => {
    // An empty canvas (cleared, or nothing opened yet) goes back to the
    // default, the project folder's name, unless a question is being asked.
    const cards = flow.cards();
    const folder = tab.root.split("/").filter(Boolean).pop();
    const full = !cards.length && flow.asked?.status !== "asking" ? folder : flow.asked ? `/ ${flow.asked.question}` : cards[0]?.node.name;
    const label = full && full.length > 40 ? `${full.slice(0, 39)}…` : full;
    if (label && label !== tab.label) launcher.renameTab(tab.id, label);
  });

  const failed = project.status;
  return html`
    <div class="flow-section">
      <${FlowBar} flow=${flow} project=${project} root=${tab.root} launcher=${launcher} ready=${ready} onKeys=${() => toggleHelp()} tabId=${tab.id} />
      ${flow.asked &&
      html`<div class="flow-asked">
        / ${flow.asked.question}
        <span class="flow-asked-how">· ${flow.asked.status === "asking" ? "asking…" : (flow.asked.detail ?? flow.asked.status)}</span>
      </div>`}
      <div
        class="flow-host"
        ref=${hostRef}
        tabindex="0"
        onKeyDown=${(event) =>
          onFlowKey(event, flow, {
            focusSearch: () => hostRef.current?.closest(".flow-section")?.querySelector(".flow-search input")?.focus(),
            toggleHelp,
            helpOpen: help,
          })}
      >
        ${help && html`<${KeysHelp} onClose=${() => setHelp(false)} />`}
        ${!ready && !failed && html`<div class="flow-overlay">Reading ${tab.root.replace(/^\/Users\/[^/]+/, "~")}…</div>`}
        ${failed && html`<div class="flow-overlay flow-error">Couldn't read this project: ${failed}</div>`}
      </div>
    </div>
  `;
}

// lode's keys (DEFAULT_KEYS), while focus is in this tab and not in a
// field or a card's code. "/" goes to the toolbar's search; "?" isn't used.
function keyMatches(key, event) {
  const parts = key.split("+");
  const want = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const name = parts[parts.length - 1];
  if ((event.metaKey || event.ctrlKey) !== want.has("mod")) return false;
  if (event.altKey !== want.has("alt")) return false;
  const punctuation = name.length === 1 && !/[a-z0-9]/i.test(name);
  if (!punctuation && name.length === 1 && event.shiftKey !== want.has("shift")) return false;
  return name === "Space" ? event.key === " " : event.key.toLowerCase() === name.toLowerCase();
}

const inCode = (event) => event.composedPath().some((t) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)));

// ⌘Z on the canvas is the menu's Undo (see appMenu.ts), which hands it to
// the flow (flow-undo). In a card's code, ⌘Z and ⌘S are lode's own.
function onFlowKey(event, flow, { focusSearch, toggleHelp, helpOpen }) {
  if (inCode(event)) return;
  if (event.key === "Escape" && helpOpen) {
    event.preventDefault();
    return toggleHelp(false);
  }
  const command = Object.keys(DEFAULT_KEYS).find((c) => DEFAULT_KEYS[c].some((k) => keyMatches(k, event)));
  if (!command) return;
  if (command === "help") {
    event.preventDefault();
    return toggleHelp();
  }
  if (command === "search") {
    event.preventDefault();
    return focusSearch();
  }
  if (!flow.canRun(command)) return;
  event.preventDefault();
  flow.run(command);
}

// Clance's toolbar for a flow: search (a symbol, or "/" and a question),
// what's on the canvas, and the commands, from lode's flow API.
// "?": lode's keys, as its COMMAND_HELP describes them.
const KEY_LABEL = (key) =>
  key.replace("Mod+", "⌘").replace("Shift+", "⇧").replace("ArrowDown", "↓").replace("ArrowUp", "↑").replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("Backspace", "⌫").replace("Delete", "⌦");

function KeysHelp({ onClose }) {
  const rows = Object.keys(COMMAND_HELP).filter((c) => DEFAULT_KEYS[c]?.length);
  return html`
    <div class="flow-keys" role="dialog" aria-label="Keys" onClick=${onClose}>
      <div class="flow-keys-title">Keys <span class="flow-keys-note">Esc or ? closes</span></div>
      ${rows.map(
        (c) => html`<div class="flow-keys-row">
          <span class="flow-keys-keys">${DEFAULT_KEYS[c].map((k) => html`<kbd>${KEY_LABEL(k)}</kbd>`)}</span>
          <span>${COMMAND_HELP[c]}</span>
        </div>`
      )}
      <div class="flow-keys-note">In a card's code, keys type, ⌘S saves and ⌘Z undoes the typing; Esc comes back to the canvas.</div>
    </div>
  `;
}

function FlowBar({ flow, project, root, launcher, ready, onKeys, tabId }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [note, setNote] = useState("");
  // How "/" questions find their flow: lode's quick pass, or its Jev crawl
  // (slower, reads more of the project). Kept with the tab.
  const [mode, setMode] = useTabState("ask.mode", "pass", { persist: true });
  // "/" needs a Jev key (Settings, or the environment): off without one.
  const canAsk = !!useJevStatus()?.source;
  const timer = useRef(0);

  function onInput(event) {
    const value = event.target.value;
    setQuery(value);
    clearTimeout(timer.current);
    if (!value.trim() || value.startsWith("/")) return setResults([]);
    timer.current = setTimeout(async () => setResults((await project.api.search(value).catch(() => [])).slice(0, 12)), 120);
  }

  function pick(node) {
    void flow.show(node.id);
    setQuery("");
    setResults([]);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      setResults([]);
      event.target.blur();
    }
    if (event.key !== "Enter") return;
    if (query.startsWith("/")) {
      if (!canAsk) return launcher.openSection("settings");
      const question = query.slice(1).trim();
      if (question) void flow.ask(question, { mode });
      setQuery("");
      return;
    }
    if (results[0]) pick(results[0]);
  }

  // A pointer, not a copy: the session sees the canvas itself, and can draw
  // on it, through the lode tools (src/main/lodeTools.ts).
  function askClaude() {
    const selected = flow.selection().length;
    const what = selected > 1 ? `the ${selected} selected cards on my lode canvas` : "my lode canvas";
    launcher.askClaudeBeside(`About ${what} (lode_canvas, canvas ${tabId}): `, root, tabId);
  }

  async function copyContext() {
    const context = await flow.context().catch(() => null);
    if (!context) return;
    await navigator.clipboard.writeText(context.markdown);
    setNote(`copied · ${context.tokens.toLocaleString()} tokens`);
    setTimeout(() => setNote(""), 2500);
  }

  const cards = flow.cards().length;
  const unsaved = flow.unsaved().length;
  const run = (command) => () => flow.run(command);
  return html`
    <header class="flow-bar">
      <select
        class="flow-mode"
        value=${mode}
        disabled=${!canAsk}
        onChange=${(event) => setMode(event.target.value)}
        title="How a / question finds its flow: a quick pass (word matches, one Jev pass) or a Jev crawl (reads more of the project; slower)"
      >
        <option value="pass">Quick</option>
        <option value="crawl">Crawl</option>
      </select>
      <div class="flow-search">
        <input
          type="search"
          placeholder=${!ready ? "Reading the project…" : canAsk ? "Find a symbol, or / and a question…" : "Find a symbol"}
          disabled=${!ready}
          value=${query}
          onInput=${onInput}
          onKeyDown=${onKeyDown}
          title="A symbol's name, or / and a question: / how do sessions start?"
        />
        ${query.startsWith("/") &&
        !canAsk &&
        html`<div class="menu flow-results">
          <button class="menu-item" onClick=${() => launcher.openSection("settings")}>
            <span class="menu-item-title">Questions need a Jev key</span>
            <span class="menu-item-detail">Add one in Settings · ↩</span>
          </button>
        </div>`}
        ${results.length > 0 &&
        html`<div class="menu flow-results" role="listbox">
          ${results.map(
            (node) => html`<button class="menu-item" role="option" onClick=${() => pick(node)}>
              <span class="menu-item-title">${node.name}</span>
              <span class="menu-item-detail">${node.kind} · ${node.file ?? ""}${node.line ? `:${node.line}` : ""}</span>
            </button>`
          )}
        </div>`}
      </div>
      <span class="flow-count">${note || [cards ? `${cards} card${cards === 1 ? "" : "s"}` : "", unsaved ? `${unsaved} unsaved` : ""].filter(Boolean).join(" · ")}</span>
      <span class="flow-bar-spacer"></span>
      <button class="btn-quiet btn-small" disabled=${!flow.canRun("undo")} onClick=${run("undo")} title="Undo (⌘Z)">Undo</button>
      <button class="btn-quiet btn-small" disabled=${!flow.canRun("zoomReset")} onClick=${run("zoomReset")} title="Back to 100%">${Math.round(flow.zoom * 100)}%</button>
      <button class="btn-quiet btn-small" disabled=${!flow.canRun("fit")} onClick=${run("fit")} title="Show every card (f)">Fit</button>
      <button class="btn-quiet btn-small ${flow.diff !== null ? "flow-on" : ""}" onClick=${() => void flow.setDiff(flow.diff === null ? "HEAD" : null)} title="Show what changed since the last commit">Changes</button>
      <button class="btn-quiet btn-small" disabled=${!cards} onClick=${copyContext} title="Copy these cards (or the selected ones) as context for an LLM">Copy context</button>
      <button class="btn-secondary btn-small" disabled=${!ready} onClick=${askClaude} title="Open a Claude session beside this lode that can see and draw on it (lode tools); once it's open, go to it">Ask Claude</button>
      <button class="btn-quiet btn-small" disabled=${!flow.canRun("clear")} onClick=${run("clear")} title="Clear the canvas">Clear</button>
      <button class="btn-quiet btn-small" onClick=${onKeys} title="The keys (?)">?</button>
    </header>
  `;
}
