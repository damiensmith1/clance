import { filePathsToPastePayload } from "../shared/dragDropPaste.js";

const appEl = document.getElementById("app");
const termInnerEl = document.getElementById("term-inner");
const pickerSearchEl = document.getElementById("picker-search");
const pickerListEl = document.getElementById("picker-list");
const closeBtn = document.getElementById("close-btn");
const openInAppBtn = document.getElementById("open-in-app-btn");
const contextLinkEl = document.getElementById("context-link");
const contextDialogEl = document.getElementById("context-dialog");
const contextDialogTitleEl = document.getElementById("context-dialog-title");
const contextDialogImageLabelEl = document.getElementById("context-dialog-image-label");
const contextDialogImageEl = document.getElementById("context-dialog-image");
const contextDialogSelectionLabelEl = document.getElementById("context-dialog-selection-label");
const contextDialogSelectionEl = document.getElementById("context-dialog-selection");
const contextDialogSystemPromptLabelEl = document.getElementById("context-dialog-system-prompt-label");
const contextDialogSystemPromptEl = document.getElementById("context-dialog-system-prompt");
const contextDialogEmptyEl = document.getElementById("context-dialog-empty");

let allSessions = [];
let pickerContextText = "";
let term = null;
let fitAddon = null;
let activeTerminalId = null;
let activeArgs = [];
let offTerminalData = null;

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
  term?.dispose();
  term = null;
  fitAddon = null;
  activeTerminalId = null;
  activeArgs = [];
  offTerminalData = null;
  termInnerEl.replaceChildren();
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
  activeArgs = args;

  term = new window.Terminal({
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
    lineHeight: 1.15,
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

  // The terminal opens (and does its first fit) before the JetBrains Mono
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
      const args = await window.clance.resolveOpenArgs(session.id, session.title);
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

// Populates the "See context" hover card with what was actually captured
// at invocation — the same pieces buildContextText() (popupWindow.ts) wove
// into prose for the CLI, shown here as-is instead of re-parsed back out of
// that prose. `openPopupWithArgs` (pop-out-to-widget) never captures fresh
// context at all, so `preview` is undefined there — the empty state covers it.
function renderContextPreview(preview) {
  // preview is undefined for flows that never capture fresh context at all
  // (openPopupWithArgs's pop-out-to-widget) — genuinely nothing to show,
  // unlike a captured-but-empty field below. systemPrompt itself is never
  // empty when preview exists (buildContextText always returns at least
  // its boilerplate first line), so it's shown whenever preview is.
  if (!preview) {
    contextDialogTitleEl.hidden = true;
    contextDialogImageLabelEl.hidden = true;
    contextDialogImageEl.hidden = true;
    contextDialogImageEl.removeAttribute("src");
    contextDialogSelectionLabelEl.hidden = true;
    contextDialogSelectionEl.hidden = true;
    contextDialogSystemPromptLabelEl.hidden = true;
    contextDialogSystemPromptEl.hidden = true;
    contextDialogEmptyEl.hidden = false;
    return;
  }

  const { windowTitle, screenshotPath, selectedText, systemPrompt } = preview;
  contextDialogEmptyEl.hidden = true;

  contextDialogTitleEl.hidden = !windowTitle;
  contextDialogTitleEl.textContent = windowTitle ? `From: ${windowTitle}` : "";

  if (screenshotPath) {
    // encodeURI (not encodeURIComponent, which would also escape "/")
    // guards against a home directory path containing spaces or other
    // characters that aren't valid unescaped in a URL.
    contextDialogImageEl.src = `file://${encodeURI(screenshotPath)}`;
    contextDialogImageEl.hidden = false;
    contextDialogImageLabelEl.hidden = false;
  } else {
    contextDialogImageEl.hidden = true;
    contextDialogImageEl.removeAttribute("src");
    contextDialogImageLabelEl.hidden = true;
  }

  contextDialogSelectionEl.hidden = !selectedText;
  contextDialogSelectionEl.textContent = selectedText ?? "";
  contextDialogSelectionLabelEl.hidden = !selectedText;

  contextDialogSystemPromptEl.hidden = !systemPrompt;
  contextDialogSystemPromptEl.textContent = systemPrompt ?? "";
  contextDialogSystemPromptLabelEl.hidden = !systemPrompt;
}

// #context-dialog's CSS max-height (560px) is just an upper cap — it
// doesn't know how much room is actually left below the toolbar in the
// current (user-resizable) window. Left alone, a dialog taller than that
// remaining space gets clipped by #app's own overflow: hidden (needed for
// the widget's rounded corners), and since #app's edge *is* the window's
// edge, that clip is absolute — no amount of scrolling the dialog's own
// content can bring the clipped-off tail into view, because it's a fixed
// geometry problem (that content always lands in the same dead zone at the
// bottom of the dialog's box), not a scroll-position one. Recomputing the
// real ceiling on every hover and writing it as an inline style (which
// wins over the CSS rule) keeps the dialog's own scrolling honest — it
// never renders taller than what's actually visible, so scrolling all the
// way down always works.
const CONTEXT_DIALOG_MAX_HEIGHT = 560;
const CONTEXT_DIALOG_BOTTOM_MARGIN = 10;
contextLinkEl.addEventListener("mouseenter", () => {
  const available =
    window.innerHeight - contextLinkEl.getBoundingClientRect().bottom - CONTEXT_DIALOG_BOTTOM_MARGIN;
  contextDialogEl.style.maxHeight = `${Math.min(Math.max(available, 120), CONTEXT_DIALOG_MAX_HEIGHT)}px`;
});

closeBtn.addEventListener("click", () => window.clance.closeWidget());

openInAppBtn.addEventListener("click", () => {
  if (!activeTerminalId) return;
  const terminalId = activeTerminalId;
  const args = activeArgs;
  detachTerminal();
  window.clance.openInApp(terminalId, args);
});

// Shown the instant the widget appears, before the real terminal args (or
// picker context) are ready — see toggleClancePopup/togglePopupPicker in
// popupWindow.ts, which send this first so the window is never just a blank
// frame while that work is still in flight.
function showLoading() {
  teardownTerminal();
  appEl.classList.add("has-messages");
  const placeholder = document.createElement("div");
  placeholder.className = "note";
  placeholder.textContent = "Starting…";
  termInnerEl.replaceChildren(placeholder);
}

window.clance.onShown((payload) => {
  // togglePopupPicker sends an empty-context "picker" payload immediately,
  // then a second one once the real context text/preview lands — that
  // second arrival shouldn't reset the search box or refetch the list out
  // from under someone who's already typing/browsing.
  const alreadyBrowsingPicker = payload.mode === "picker" && appEl.classList.contains("picker-active");

  appEl.classList.remove("has-messages", "picker-active");
  renderContextPreview(payload.contextPreview);

  if (payload.mode === "loading") {
    showLoading();
  } else if (payload.mode === "picker") {
    pickerContextText = payload.contextText;
    if (!alreadyBrowsingPicker) {
      teardownTerminal();
      showPicker();
    } else {
      appEl.classList.add("picker-active");
    }
  } else {
    openTerminal(payload.args);
  }
});
