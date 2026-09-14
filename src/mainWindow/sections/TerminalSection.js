import { html, useEffect, useRef } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { filePathsToPastePayload } from "../../shared/dragDropPaste.js";

let terminalCounter = 0;

// Keyed by terminalId, outside Preact's tree entirely — Shell.js only ever
// renders the active tab (see Shell.js's `activeTab`), so switching tabs
// unmounts TerminalSection. Without this registry that unmount used to kill
// the pty and dispose xterm, losing the shell (a plain `$SHELL -il` tab has
// no backing process the way a `claude attach <id>` tab does — see
// docs/background-agent-architecture.md — so killing its one-and-only pty
// really did end the session). Now the xterm.Terminal instance, its DOM
// node, and the pty stay alive here for as long as the tab exists; mounting
// just moves the existing DOM node into view instead of recreating
// everything. Real teardown only happens via destroyTerminal(), called
// explicitly when a tab is actually closed (Shell.js), never on a plain
// tab-switch unmount.
const registry = new Map();

let offscreenHost;
function getOffscreenHost() {
  if (!offscreenHost) {
    offscreenHost = document.createElement("div");
    // Kept in the DOM (not display:none) so xterm's own layout/measurement
    // keeps working while detached — just moved far off-screen so it's
    // never visible or in anyone's tab order.
    offscreenHost.style.position = "fixed";
    offscreenHost.style.top = "-10000px";
    offscreenHost.style.left = "-10000px";
    offscreenHost.style.width = "1px";
    offscreenHost.style.height = "1px";
    offscreenHost.style.overflow = "hidden";
    document.body.appendChild(offscreenHost);
  }
  return offscreenHost;
}

function getOrCreateEntry(terminalId, { shell, args }) {
  const existing = registry.get(terminalId);
  if (existing) return existing;

  const term = new window.Terminal({
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 13,
    minimumContrastRatio: 4.5,
    theme: {
      background: "#F7F3EB",
      foreground: "#2D2924",
      cursor: "#D97757",
      cursorAccent: "#F7F3EB",
      selectionBackground: "rgba(217, 119, 87, 0.14)",
      black: "#2D2924",
      red: "#B23B3B",
      green: "#3C6B40",
      yellow: "#C9773F",
      blue: "#2E5A88",
      magenta: "#8B5FBF",
      cyan: "#3B8FA3",
      white: "#FDFBF6",
      brightBlack: "#7A7267",
      brightRed: "#D9534F",
      brightGreen: "#4A7A4E",
      brightYellow: "#D97757",
      brightBlue: "#3E699E",
      brightMagenta: "#A57CD9",
      brightCyan: "#4FA8BD",
      brightWhite: "#FDFBF6",
    },
  });
  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const termHost = document.createElement("div");
  termHost.style.width = "100%";
  termHost.style.height = "100%";
  getOffscreenHost().appendChild(termHost);
  term.open(termHost);
  fitAddon.fit();

  if (shell) {
    window.clanceApp.createShellTerminal(terminalId, term.cols, term.rows);
  } else {
    window.clanceApp.createTerminal(terminalId, "claude", args, term.cols, term.rows);
  }

  const entry = { term, fitAddon, termHost };
  registry.set(terminalId, entry);

  // The terminal opens (and does its first fit) before the JetBrains Mono
  // web font is necessarily loaded, so that first fit can measure the
  // fallback font's cell metrics and overestimate how many rows fit. Once
  // the real font is ready, re-fit and re-sync the pty so the CLI's TUI
  // isn't left rendering to a taller viewport than what's actually visible.
  document.fonts.ready.then(() => {
    if (registry.get(terminalId) !== entry) return;
    fitAddon.fit();
    window.clanceApp.resizeTerminal(terminalId, term.cols, term.rows);
  });

  // A brand-new xterm instance has no scrollback of its own — most often
  // because this really is a new terminal, but also whenever this is the
  // *first* mount in this renderer for a terminalId whose pty is actually
  // still alive from before a refresh (see layoutStore.js's rehydrateNode
  // and ptyManager.ts's getPtyBuffer). Replay whatever's buffered there
  // before showing anything live, so the two can't land out of order:
  // the data listener starts queuing immediately (nothing's dropped), but
  // queued chunks only get flushed, in order, after the historical replay
  // is written first.
  let bufferReady = false;
  let pendingChunks = [];
  entry.offData = window.clanceApp.onTerminalData(({ terminalId: id, data }) => {
    if (id !== terminalId) return;
    if (bufferReady) term.write(data);
    else pendingChunks.push(data);
  });
  window.clanceApp.getTerminalBuffer(terminalId).then((buffer) => {
    if (registry.get(terminalId) !== entry) return;
    if (buffer) term.write(buffer);
    pendingChunks.forEach((data) => term.write(data));
    pendingChunks = [];
    bufferReady = true;
  });

  term.onData((data) => {
    window.clanceApp.writeTerminal(terminalId, data);
  });

  // xterm.js sends the same carriage return for Enter and Shift+Enter,
  // since a raw pty has no way to tell them apart on its own. Claude
  // Code's chat input already treats a bare linefeed (0x0A, the same
  // byte ctrl+j sends) as "insert newline" rather than "submit", so
  // intercept Shift+Enter here and send that byte instead of letting
  // xterm forward its default carriage return. Returning false only
  // stops xterm's own key handling — it doesn't stop the browser's
  // default action, so without preventDefault() the Enter keypress
  // still lands in xterm's hidden input textarea. That stray input
  // silently accumulates there until xterm eventually flushes it,
  // which is what caused shift+enter (and Enter generally) to behave
  // correctly a few times and then break down.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      window.clanceApp.writeTerminal(terminalId, "\n");
      return false;
    }
    return true;
  });

  return entry;
}

// The real teardown — kills the pty and disposes xterm. Call this only when
// a tab is genuinely being closed (Shell.js's ✕ button), never from
// TerminalSection's own unmount, which now just detaches the view.
export function destroyTerminal(terminalId) {
  const entry = registry.get(terminalId);
  if (!entry) return;
  registry.delete(terminalId);
  entry.offData();
  entry.termHost.remove();
  entry.term.dispose();
  window.clanceApp.killTerminal(terminalId);
}

export function TerminalSection({ terminalId, args = [], shell = false, onPopOut }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const entry = getOrCreateEntry(terminalId, { shell, args });
    const container = containerRef.current;
    container.appendChild(entry.termHost);
    entry.fitAddon.fit();
    window.clanceApp.resizeTerminal(terminalId, entry.term.cols, entry.term.rows);

    // Every terminal is an `attach <id>` client onto a background agent now
    // (see docs/background-agent-architecture.md), so resize is always
    // forwarded — there's no longer a "this one isn't really attached"
    // case to special-case. This does mean two clients simultaneously
    // attached to the *same* agent (two panes, or Clance + Remote Control)
    // still fight over that agent's one shared terminal size, same as two
    // `tmux` clients on one session — an accepted, rare tradeoff, not
    // something Clance can fix on its own.
    const resizeObserver = new ResizeObserver(() => {
      entry.fitAddon.fit();
      window.clanceApp.resizeTerminal(terminalId, entry.term.cols, entry.term.rows);
    });
    resizeObserver.observe(container);

    // Dropping a file (a screenshot, most commonly) onto the terminal
    // pastes its filesystem path into the CLI's input as unsubmitted text,
    // so the user can add a prompt around it before hitting Enter — the
    // CLI reads the path itself via its own Read tool, same as any file
    // path typed by hand.
    const onDragOver = (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = async (event) => {
      event.preventDefault();
      const sourcePaths = Array.from(event.dataTransfer.files)
        .map((file) => window.clanceApp.getPathForFile(file))
        .filter(Boolean);
      if (sourcePaths.length === 0) return;
      // Copy immediately rather than handing the CLI the original path —
      // a file dragged from macOS system UI (e.g. a screenshot thumbnail)
      // is often a transient "file promise" staging copy that can vanish
      // moments after the drop, before the CLI ever gets to read it.
      const copied = await Promise.all(
        sourcePaths.map((path) => window.clanceApp.copyDroppedFile(path))
      );
      const paths = copied.filter(Boolean);
      if (paths.length === 0) return;
      window.clanceApp.writeTerminal(terminalId, filePathsToPastePayload(paths));
      entry.term.focus();
    };
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);

    return () => {
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      resizeObserver.disconnect();
      // Detach only, on every unmount (including a plain tab switch) — the
      // pty and xterm buffer live on in the registry above. Skip this if
      // the entry's already gone (destroyTerminal ran first, e.g. the tab
      // was actually closed rather than just switched away from).
      if (registry.get(terminalId) === entry) {
        getOffscreenHost().appendChild(entry.termHost);
      }
    };
  }, [terminalId]);

  // FitAddon sizes rows/cols off the mount element's *direct parent*
  // clientHeight/Width without ever subtracting that parent's own padding
  // (a known xterm.js limitation) — so the padding has to live on an outer
  // wrapper, never on the element term.open() mounts into, or the computed
  // row count overshoots the actually-visible area.
  return html`<div
    style=${{
      position: "relative",
      width: "100%",
      height: "100%",
      padding: "20px",
      boxSizing: "border-box",
      background: "#F7F3EB",
    }}
  >
    ${onPopOut &&
    html`
      <button class="terminal-pop-out" title="Open in Widget" onClick=${onPopOut}>${Icon.popOut(15)}</button>
    `}
    <div ref=${containerRef} style=${{ width: "100%", height: "100%" }}></div>
  </div>`;
}

export function nextTerminalId() {
  terminalCounter += 1;
  return `term-${Date.now()}-${terminalCounter}`;
}
