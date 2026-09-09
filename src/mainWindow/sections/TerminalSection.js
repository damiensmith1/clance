import { html, useEffect, useRef } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { filePathsToPastePayload } from "../../shared/dragDropPaste.js";

let terminalCounter = 0;

export function TerminalSection({ terminalId, args = [], isAttached = false, onPopOut }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
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
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    window.clanceApp.createTerminal(terminalId, "claude", args, term.cols, term.rows);

    // The terminal opens (and does its first fit) before the JetBrains Mono
    // web font is necessarily loaded, so that first fit can measure the
    // fallback font's cell metrics and overestimate how many rows fit. Once
    // the real font is ready, re-fit and re-sync the pty so the CLI's TUI
    // isn't left rendering to a taller viewport than what's actually visible.
    // Skipped for an attached session — see the resizeObserver comment below.
    document.fonts.ready.then(() => {
      if (termRef.current !== term) return;
      fitAddon.fit();
      if (!isAttached) window.clanceApp.resizeTerminal(terminalId, term.cols, term.rows);
    });

    const offData = window.clanceApp.onTerminalData(({ terminalId: id, data }) => {
      if (id === terminalId) term.write(data);
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

    // An "attach"ed session's pty is shared with every other client
    // currently attached to that same background agent (the CLI's own
    // `claude attach <id>`, not a Clance concept — it's the same mechanism
    // as attaching a second `tmux` client to one session) — the agent has
    // exactly one shared terminal size, dictated by whichever attached
    // client's resize the CLI honored most recently. So forwarding every
    // local resize here wouldn't just resize this pane's own view, it
    // reflows every *other* pane also attached to that session out from
    // under itself. `fitAddon.fit()` still keeps this pane's own xterm.js
    // viewport looking right locally; only the pty-resize forward (which
    // is what actually broadcasts to the shared agent) is skipped, sized
    // once at creation (via `createTerminal`'s initial cols/rows) and left
    // alone after that.
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (!isAttached) window.clanceApp.resizeTerminal(terminalId, term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

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
      term.focus();
    };
    containerRef.current.addEventListener("dragover", onDragOver);
    containerRef.current.addEventListener("drop", onDrop);

    return () => {
      containerRef.current?.removeEventListener("dragover", onDragOver);
      containerRef.current?.removeEventListener("drop", onDrop);
      offData();
      resizeObserver.disconnect();
      window.clanceApp.killTerminal(terminalId);
      term.dispose();
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
