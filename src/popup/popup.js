const appEl = document.getElementById("app");
const termMountEl = document.getElementById("term-mount");
const pickerSearchEl = document.getElementById("picker-search");
const pickerListEl = document.getElementById("picker-list");

let allSessions = [];
let pickerContextText = "";
let term = null;
let fitAddon = null;
let activeTerminalId = null;
let offTerminalData = null;

// Window height tracks #app's natural content height (CSS caps it at the
// same max the window used to be fixed at). Reports directly (no
// requestAnimationFrame batching) since rAF is throttled while the window
// is hidden/unfocused.
const resizeObserver = new ResizeObserver(() => {
  window.clance.reportHeight(Math.ceil(appEl.offsetHeight));
  if (fitAddon && activeTerminalId) {
    fitAddon.fit();
    window.clance.resizeTerminal(activeTerminalId, term.cols, term.rows);
  }
});
resizeObserver.observe(appEl);

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

function teardownTerminal() {
  if (!activeTerminalId) return;
  offTerminalData?.();
  window.clance.killTerminal(activeTerminalId);
  term?.dispose();
  term = null;
  fitAddon = null;
  activeTerminalId = null;
  offTerminalData = null;
  termMountEl.replaceChildren();
}

// Opens a fresh Claude CLI terminal in the popup. `visibleContext`, if
// given, is typed into the input once the session is ready — used for
// resumed sessions, which can't reliably take context injected invisibly
// via a system-prompt flag (see popupWindow.ts). It's wrapped as a
// bracketed paste so the CLI's multi-line input treats it as one pasted
// block (embedded newlines included) instead of submitting partway
// through, and left unsubmitted so the user can add to it before hitting
// Enter themselves.
function openTerminal(args, visibleContext) {
  teardownTerminal();
  appEl.classList.remove("picker-active");
  appEl.classList.add("has-messages");

  term = new window.Terminal({
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
    lineHeight: 1.15,
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
  fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(termMountEl);
  fitAddon.fit();
  term.focus();

  activeTerminalId = `popup-${Date.now()}`;
  window.clance.createTerminal(activeTerminalId, "claude", args).then(() => {
    if (activeTerminalId) window.clance.resizeTerminal(activeTerminalId, term.cols, term.rows);
  });

  offTerminalData = window.clance.onTerminalData(({ terminalId, data }) => {
    if (terminalId === activeTerminalId) term.write(data);
  });

  term.onData((data) => {
    window.clance.writeTerminal(activeTerminalId, data);
  });

  if (visibleContext) {
    const terminalId = activeTerminalId;
    // Resuming replays the session's prior history first, so this needs
    // longer to land than a fresh session's near-instant prompt.
    setTimeout(() => {
      if (activeTerminalId !== terminalId) return;
      // Defense in depth: the main process already strips control chars
      // (including ESC) from window-title-derived text before it gets
      // here, but sanitize again so this path is safe even if
      // `visibleContext` ever carries untrusted text some other way — in
      // particular, stripping ESC means it can't contain a fake `\x1b[201~`
      // that would let content escape the paste block early. Trailing
      // newlines stay inside the paste brackets (bracketed paste treats
      // embedded \n as literal text, not Enter) so the input stays
      // unsubmitted for the user to add to.
      // eslint-disable-next-line no-control-regex
      const sanitized = visibleContext.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
      window.clance.writeTerminal(terminalId, `\x1b[200~${sanitized}\n\n\x1b[201~`);
    }, 1200);
  }
}

function renderPickerList(sessions) {
  pickerListEl.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "note";
    empty.textContent = "No matching conversations.";
    pickerListEl.appendChild(empty);
    return;
  }
  for (const session of sessions.slice(0, 30)) {
    const row = document.createElement("button");
    row.className = "picker-row";

    const title = document.createElement("span");
    title.className = "picker-row-title";
    title.textContent = session.title;

    const meta = document.createElement("span");
    meta.className = "picker-row-meta";
    meta.textContent = `${session.projectLabel} · ${relativeTime(session.lastModified)}`;

    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener("click", async () => {
      const args = await window.clance.resolveOpenArgs(session.id);
      openTerminal(args, pickerContextText);
    });
    pickerListEl.appendChild(row);
  }
}

function showPicker() {
  appEl.classList.add("picker-active");
  appEl.classList.remove("has-messages");
  pickerSearchEl.value = "";
  window.clance.listChatSessions().then((sessions) => {
    allSessions = sessions;
    renderPickerList(sessions);
  });
  pickerSearchEl.focus();
}

pickerSearchEl.addEventListener("input", () => {
  const query = pickerSearchEl.value.trim().toLowerCase();
  const filtered = !query
    ? allSessions
    : allSessions.filter(
        (s) =>
          s.title.toLowerCase().includes(query) ||
          s.projectLabel.toLowerCase().includes(query)
      );
  renderPickerList(filtered);
});

window.clance.onShown((payload) => {
  appEl.classList.remove("has-messages", "picker-active");

  if (payload.mode === "picker") {
    pickerContextText = payload.contextText;
    teardownTerminal();
    showPicker();
  } else {
    openTerminal(payload.args);
  }
});
