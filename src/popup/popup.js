import { filePathsToPastePayload } from "../shared/dragDropPaste.js";

const appEl = document.getElementById("app");
const termInnerEl = document.getElementById("term-inner");
const openInWrapEl = document.getElementById("open-in-wrap");
const openInBtn = document.getElementById("open-in-btn");
const openInDropdownEl = document.getElementById("open-in-dropdown");
const openInSearchEl = document.getElementById("open-in-search");
const openInListEl = document.getElementById("open-in-list");
const openInBrowseBtn = document.getElementById("open-in-browse-btn");
const openInRecentDirsEl = document.getElementById("open-in-recent-dirs");
const closeBtn = document.getElementById("close-btn");
const hideBtn = document.getElementById("hide-btn");
const openInAppBtn = document.getElementById("open-in-app-btn");
const toolbarLabelEl = document.getElementById("toolbar-label");
const toolbarTitleEl = document.getElementById("toolbar-title");
const hintBarFolderEl = document.getElementById("hint-bar-folder");
const hintBarToggleEl = document.getElementById("hint-bar-toggle");

// A session that exits this soon after attaching never really started.
const EARLY_EXIT_MS = 8000;

let openInSessions = [];
let term = null;
let fitAddon = null;
let activeTerminalId = null;
let activeArgs = [];
let offTerminalData = null;
let offTerminalExit = null;

// The window itself is now user-resizable (drag its edges/corners) rather
// than sized to fit its content, so #app just fills whatever size the
// window is — this only needs to keep the terminal's row/col count synced
// to that.
const resizeObserver = new ResizeObserver(() => {
  if (fitAddon && activeTerminalId) {
    fitAddon.fit();
    window.clance.resizeTerminal(activeTerminalId, term.cols, term.rows);
  }
});
resizeObserver.observe(appEl);

function relativeTime(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function teardownTerminal() {
  if (!activeTerminalId) return;
  offTerminalData?.();
  offTerminalExit?.();
  offTerminalExit = null;
  window.clance.killTerminal(activeTerminalId);
  term?.dispose();
  term = null;
  fitAddon = null;
  activeTerminalId = null;
  activeArgs = [];
  offTerminalData = null;
  termInnerEl.replaceChildren();
}

// Like teardownTerminal, but leaves the underlying pty running — used by
// "Open in App", which hands this same session off to the main window
// rather than ending it.
function detachTerminal() {
  if (!activeTerminalId) return;
  offTerminalData?.();
  offTerminalExit?.();
  offTerminalExit = null;
  term?.dispose();
  term = null;
  fitAddon = null;
  activeTerminalId = null;
  activeArgs = [];
  offTerminalData = null;
  termInnerEl.replaceChildren();
}

// Opens a fresh Claude CLI terminal in the popup.
// above for how both are delivered.
function openTerminal(args) {
  teardownTerminal();
  // teardownTerminal() only clears term-inner as a side effect of tearing
  // down a *previous* terminal (it early-returns with none active) — but
  // the loading placeholder (see showLoading()) leaves term-inner non-empty
  // without ever setting activeTerminalId, so it needs its own explicit
  // clear here too, or it lingers alongside the real terminal once this
  // opens.
  termInnerEl.replaceChildren();
  appEl.classList.add("has-messages");
  activeArgs = args;

  term = new window.Terminal({
    fontFamily: "Geist Mono, monospace",
    fontSize: 12,
    lineHeight: 1.15,
    minimumContrastRatio: 4.5,
    theme: {
      background: "#FAFAF7",
      foreground: "#171614",
      cursor: "#E2632F",
      cursorAccent: "#FAFAF7",
      selectionBackground: "rgba(23, 22, 20, 0.12)",
      scrollbarSliderBackground: "rgba(23, 22, 20, 0.14)",
      scrollbarSliderHoverBackground: "rgba(23, 22, 20, 0.28)",
      scrollbarSliderActiveBackground: "rgba(23, 22, 20, 0.36)",
      black: "#171614",
      red: "#B3362B",
      green: "#2F7D4F",
      yellow: "#9A5C00",
      blue: "#2E5A88",
      magenta: "#7B4FAF",
      cyan: "#2C7A8C",
      white: "#FAFAF7",
      brightBlack: "#75726B",
      brightRed: "#D14A3C",
      brightGreen: "#3A8F5C",
      brightYellow: "#E2632F",
      brightBlue: "#3E699E",
      brightMagenta: "#9466C8",
      brightCyan: "#3A95A8",
      brightWhite: "#FFFFFF",
    },
  });
  fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(termInnerEl);
  fitAddon.fit();
  term.focus();

  const terminalId = (activeTerminalId = `popup-${Date.now()}`);
  window.clance
    .createTerminal(activeTerminalId, "claude", args, term.cols, term.rows)
    .then(() => {
      if (activeTerminalId) window.clance.resizeTerminal(activeTerminalId, term.cols, term.rows);
    });

  // The terminal opens (and does its first fit) before the Geist Mono
  // web font is necessarily loaded, so that first fit can measure the
  // fallback font's cell metrics and overestimate how many rows fit. Once
  // the real font is ready, re-fit and re-sync the pty so the CLI's TUI
  // isn't left rendering to a taller viewport than what's actually visible.
  document.fonts.ready.then(() => {
    if (terminalId !== activeTerminalId) return;
    fitAddon.fit();
    window.clance.resizeTerminal(terminalId, term.cols, term.rows);
  });

  offTerminalData = window.clance.onTerminalData(({ terminalId, data }) => {
    if (terminalId === activeTerminalId) term.write(data);
  });

  const openedAt = Date.now();
  offTerminalExit = window.clance.onTerminalExit(({ terminalId: id, exitCode }) => {
    if (id !== activeTerminalId || exitCode === 0 || Date.now() - openedAt > EARLY_EXIT_MS) return;
    const retryArgs = activeArgs;
    showError(
      "Claude Code exited before the session was ready. This usually means it needs to sign in again.",
      () => openTerminal(retryArgs),
      `exit code ${exitCode}`
    );
  });
  showSessionInfo(args);

  term.onData((data) => {
    window.clance.writeTerminal(activeTerminalId, data);
  });
}

function renderOpenInList(sessions) {
  openInListEl.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "note";
    empty.textContent = "No matching sessions.";
    openInListEl.appendChild(empty);
    return;
  }
  for (const session of sessions.slice(0, 30)) {
    const row = document.createElement("button");
    row.className = "open-in-row";

    const title = document.createElement("span");
    title.className = "open-in-row-title";
    title.textContent = session.title;

    const meta = document.createElement("span");
    meta.className = "open-in-row-meta";
    meta.textContent = `${session.projectLabel} · ${relativeTime(session.lastModified)}`;

    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener("click", async () => {
      closeOpenInDropdown();
      const args = await window.clance.resolveOpenArgs(session.id, session.title);
      // No visible context typed in here anymore — the session's own MCP
      // tool descriptions are enough (see popupWindow.ts's
      // localToolsSystemPrompt), and re-typing a generic nudge on every
      // tab-switch into an already-running, already-in-progress
      // conversation would just be repeated clutter with no new signal.
      openTerminal(args);
    });
    openInListEl.appendChild(row);
  }
}

// No Node `path` module in the renderer (contextIsolation) — a directory
// picked via the native folder dialog is always a plain forward-slash
// absolute path on macOS, so a simple split covers it.
function dirBasename(dir) {
  const segments = dir.split("/").filter(Boolean);
  return segments[segments.length - 1] || dir;
}

function renderRecentDirs(dirs) {
  openInRecentDirsEl.replaceChildren();
  for (const dir of dirs) {
    const row = document.createElement("button");
    row.className = "open-in-row";

    const title = document.createElement("span");
    title.className = "open-in-row-title";
    title.textContent = dirBasename(dir);

    const meta = document.createElement("span");
    meta.className = "open-in-row-meta";
    meta.textContent = folderLabel(dir);

    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener("click", () => {
      closeOpenInDropdown();
      window.clance.openNewInDirectory(dir);
    });
    openInRecentDirsEl.appendChild(row);
  }
}

openInBrowseBtn.addEventListener("click", async () => {
  const dir = await window.clance.pickDirectory();
  if (!dir) return;
  closeOpenInDropdown();
  window.clance.openNewInDirectory(dir);
});

function openOpenInDropdown() {
  openInDropdownEl.classList.add("open");
  openInSearchEl.value = "";
  window.clance.listChatSessions().then((all) => {
    // Program-started sessions (a plugin's commit reviews, say) aren't
    // conversations to resume; the main window lists them under Automated.
    const sessions = all.filter((s) => !s.automated);
    openInSessions = sessions;
    renderOpenInList(sessions);
  });
  window.clance.getRecentDirectories().then(renderRecentDirs);
  openInSearchEl.focus();
}

function closeOpenInDropdown() {
  openInDropdownEl.classList.remove("open");
}

// ⌘K opens this menu from anywhere in the widget, terminal included (capture
// phase, so xterm never sees the key); ⌘K again or Esc closes it and hands
// the keyboard back to the terminal.
window.addEventListener(
  "keydown",
  (e) => {
    const open = openInDropdownEl.classList.contains("open");
    const commandK = e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "k";
    if (!commandK && !(open && e.key === "Escape")) return;
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      closeOpenInDropdown();
      term?.focus();
    } else {
      openOpenInDropdown();
    }
  },
  true
);

openInBtn.addEventListener("click", () => {
  if (openInDropdownEl.classList.contains("open")) {
    closeOpenInDropdown();
  } else {
    openOpenInDropdown();
  }
});

// Collapse on any click outside the button/dropdown — capture phase so this
// runs before anything else might stop the event from bubbling.
document.addEventListener(
  "click",
  (event) => {
    if (!openInDropdownEl.classList.contains("open")) return;
    if (openInWrapEl.contains(event.target)) return;
    closeOpenInDropdown();
  },
  true
);

openInSearchEl.addEventListener("input", () => {
  const query = openInSearchEl.value.trim().toLowerCase();
  const filtered = !query
    ? openInSessions
    : openInSessions.filter(
        (s) =>
          s.title.toLowerCase().includes(query) ||
          s.projectLabel.toLowerCase().includes(query)
      );
  renderOpenInList(filtered);
});

// Dropping a file (a screenshot, most commonly) onto the terminal pastes
// its filesystem path into the CLI's input as unsubmitted text, so the
// user can add a prompt around it before hitting Enter — the CLI reads the
// path itself via its own Read tool, same as any file path typed by hand.
termInnerEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
termInnerEl.addEventListener("drop", async (event) => {
  event.preventDefault();
  if (!activeTerminalId) return;
  const sourcePaths = Array.from(event.dataTransfer.files)
    .map((file) => window.clance.getPathForFile(file))
    .filter(Boolean);
  if (sourcePaths.length === 0) return;
  // Copy immediately rather than handing the CLI the original path — a
  // file dragged from macOS system UI (e.g. a screenshot thumbnail) is
  // often a transient "file promise" staging copy that can vanish moments
  // after the drop, before the CLI ever gets to read it.
  const copied = await Promise.all(
    sourcePaths.map((path) => window.clance.copyDroppedFile(path))
  );
  const paths = copied.filter(Boolean);
  if (paths.length === 0) return;
  window.clance.writeTerminal(activeTerminalId, filePathsToPastePayload(paths));
  term?.focus();
});


closeBtn.addEventListener("click", () => window.clance.closeWidget());

// Unlike closeWidget, this doesn't detach/teardown the terminal — the
// window is only ever hidden, not reloaded, so leaving it fully wired up
// is exactly what lets ⌥Space bring back the same conversation instead of
// starting a new one (see toggleClancePopup in popupWindow.ts).
hideBtn.addEventListener("click", () => window.clance.hideWidget());

openInAppBtn.addEventListener("click", () => {
  if (!activeTerminalId) return;
  const terminalId = activeTerminalId;
  const args = activeArgs;
  detachTerminal();
  window.clance.openInApp(terminalId, args);
});

// Shown the instant the widget appears, before the real terminal args are
// ready — see toggleClancePopup in popupWindow.ts, which sends this first
// so the window is never just a blank frame while that work is still in
// flight.
function showLoading() {
  teardownTerminal();
  appEl.classList.add("has-messages");
  appEl.classList.remove("has-error");
  const state = document.createElement("div");
  state.className = "popup-state";
  const label = document.createElement("div");
  label.className = "note";
  label.textContent = "starting claude…";
  state.append(label);
  termInnerEl.replaceChildren(state);
}

// Replaces the terminal with a short explanation and a way to try again.
function showError(message, onRetry, detail) {
  teardownTerminal();
  appEl.classList.add("has-messages", "has-error");
  const state = document.createElement("div");
  state.className = "popup-state";
  const title = document.createElement("div");
  title.className = "popup-state-title";
  title.textContent = "Couldn't start the session";
  const text = document.createElement("div");
  text.className = "popup-state-text";
  text.textContent = message;
  const actions = document.createElement("div");
  actions.className = "popup-state-actions";
  const retry = document.createElement("button");
  retry.className = "btn-primary";
  retry.textContent = "Try again";
  retry.addEventListener("click", onRetry);
  const settings = document.createElement("button");
  settings.className = "btn-secondary";
  settings.textContent = "Open Settings";
  settings.addEventListener("click", () => window.clance.openSettings());
  actions.append(retry, settings);
  state.append(title, text, actions);
  if (detail) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = detail;
    state.append(note);
  }
  termInnerEl.replaceChildren(state);
}

// "Alt+Space" as "⌥Space", for hints.
function acceleratorGlyphs(accelerator) {
  const glyphs = { Alt: "⌥", Option: "⌥", Command: "⌘", Cmd: "⌘", CommandOrControl: "⌘", Control: "⌃", Ctrl: "⌃", Shift: "⇧" };
  return accelerator
    .split("+")
    .map((part) => glyphs[part] ?? part)
    .join("");
}

function folderLabel(folder) {
  return folder.replace(/^\/Users\/[^/]+/, "~");
}

// The header and hint bar describe the attached session once main has
// looked it up. Stale answers (the widget moved on) are dropped.
function showSessionInfo(args) {
  toolbarLabelEl.textContent = "claude";
  toolbarTitleEl.textContent = "";
  hintBarFolderEl.textContent = "";
  window.clance.sessionInfo(args).then(({ folder, title, toggleShortcut }) => {
    if (args !== activeArgs) return;
    if (toggleShortcut) hintBarToggleEl.textContent = `${acceleratorGlyphs(toggleShortcut)} hide`;
    if (folder) {
      toolbarLabelEl.textContent = dirBasename(folder);
      hintBarFolderEl.textContent = folderLabel(folder);
    }
    if (title) toolbarTitleEl.textContent = `/ ${title}`;
  });
}

// Bringing a hidden widget back (⌥Space) restores focus to whatever last had
// it, which can be a toolbar button, drawn with a focus ring because the last
// input was a key press. Typing should go to the terminal instead.
window.addEventListener("focus", () => {
  if (term && !openInDropdownEl.classList.contains("open")) term.focus();
});

window.clance.onShown((payload) => {
  appEl.classList.remove("has-messages");
  closeOpenInDropdown();
  appEl.classList.remove("has-error");
  if (payload.mode === "loading") {
    showLoading();
  } else if (payload.mode === "error") {
    showError(payload.message, () => window.clance.retry());
  } else {
    openTerminal(payload.args);
  }
});
