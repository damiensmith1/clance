import { html, useEffect, useRef } from "../../shared/vendor/preact-htm-standalone.module.js";

let terminalCounter = 0;

export function TerminalSection({ terminalId, args = [] }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    const term = new window.Terminal({
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 13,
      theme: {
        background: "#F7F3EB",
        foreground: "#2D2924",
        cursor: "#D97757",
        cursorAccent: "#F7F3EB",
        selectionBackground: "rgba(217, 119, 87, 0.14)",
        black: "#2D2924",
        red: "#B23B3B",
        green: "#4A7A4E",
        yellow: "#C9773F",
        blue: "#3B6EA5",
        magenta: "#8B5FBF",
        cyan: "#3B8FA3",
        white: "#7A7267",
        brightBlack: "#7A7267",
        brightRed: "#D9534F",
        brightGreen: "#5C9161",
        brightYellow: "#D97757",
        brightBlue: "#4F86C6",
        brightMagenta: "#A57CD9",
        brightCyan: "#4FA8BD",
        brightWhite: "#2D2924",
      },
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    window.clanceApp.createTerminal(terminalId, "claude", args);

    const offData = window.clanceApp.onTerminalData(({ terminalId: id, data }) => {
      if (id === terminalId) term.write(data);
    });

    term.onData((data) => {
      window.clanceApp.writeTerminal(terminalId, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      window.clanceApp.resizeTerminal(terminalId, term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      offData();
      resizeObserver.disconnect();
      window.clanceApp.killTerminal(terminalId);
      term.dispose();
    };
  }, [terminalId]);

  return html`<div
    ref=${containerRef}
    style=${{ width: "100%", height: "100%", padding: "12px", background: "#F7F3EB" }}
  ></div>`;
}

export function nextTerminalId() {
  terminalCounter += 1;
  return `term-${Date.now()}-${terminalCounter}`;
}
