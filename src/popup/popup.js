import { renderMarkdown, attachCopyHandler } from "../shared/markdown.js";

const appEl = document.getElementById("app");
const goalInput = document.getElementById("goal");
const transcriptEl = document.getElementById("transcript");
const pickerSearchEl = document.getElementById("picker-search");
const pickerListEl = document.getElementById("picker-list");

attachCopyHandler(transcriptEl);

const PERSON_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>';
const ROBOT_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="10" rx="2.5"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/><circle cx="9" cy="13" r="1.3"/><circle cx="15" cy="13" r="1.3"/><path d="M9 16.5h6"/></svg>';

let currentReplyEl = null;
let currentRawText = "";
let allSessions = [];

// Window height tracks #app's natural content height (CSS caps it at the
// same max the window used to be fixed at) so the popup starts as small as
// the input box and grows only as far as it needs to. Reports directly
// (no requestAnimationFrame batching) since rAF is throttled while the
// window is hidden/unfocused — e.g. a response arriving while auto-hidden
// on blur — and this must still keep the size correct for the next show.
const resizeObserver = new ResizeObserver(() => {
  window.clance.reportHeight(Math.ceil(appEl.offsetHeight));
});
resizeObserver.observe(appEl);

function createTypingIndicator() {
  const wrap = document.createElement("span");
  wrap.className = "typing";
  for (let i = 0; i < 3; i++) {
    wrap.appendChild(document.createElement("span"));
  }
  return wrap;
}

function scrollToBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function createAvatar(kind) {
  const avatar = document.createElement("span");
  avatar.className = `avatar avatar-${kind}`;
  avatar.innerHTML = kind === "user" ? PERSON_ICON : ROBOT_ICON;
  return avatar;
}

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

function submitGoal(goal) {
  goalInput.disabled = true;
  currentReplyEl = appendTurn(goal);
  currentRawText = "";
  window.clance.submitGoal(goal);
}

function appendTurn(goal) {
  appEl.classList.add("has-messages");

  const userTurn = document.createElement("div");
  userTurn.className = "turn";
  const promptBody = document.createElement("div");
  promptBody.className = "turn-body";
  const promptEl = document.createElement("div");
  promptEl.className = "turn-prompt";
  promptEl.textContent = goal;
  promptBody.appendChild(promptEl);
  userTurn.appendChild(createAvatar("user"));
  userTurn.appendChild(promptBody);

  const replyTurn = document.createElement("div");
  replyTurn.className = "turn";
  const replyBody = document.createElement("div");
  replyBody.className = "turn-body";
  const replyEl = document.createElement("div");
  replyEl.className = "turn-reply";
  replyEl.dataset.pending = "true";
  replyEl.appendChild(createTypingIndicator());
  replyBody.appendChild(replyEl);
  replyTurn.appendChild(createAvatar("assistant"));
  replyTurn.appendChild(replyBody);

  transcriptEl.appendChild(userTurn);
  transcriptEl.appendChild(replyTurn);
  scrollToBottom();

  return replyEl;
}

function appendNote(message) {
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = message;
  transcriptEl.appendChild(note);
  scrollToBottom();
}

// Renders an already-complete turn from chat history (resume mode) —
// no typing indicator, no streaming; tool/thinking blocks collapse to a
// single muted line each rather than the main window's expandable groups,
// since the popup has much less room and this is just prior context.
function renderHistoricalTurn(turn) {
  const row = document.createElement("div");
  row.className = "turn";
  row.appendChild(createAvatar(turn.role === "user" ? "user" : "assistant"));

  const body = document.createElement("div");
  body.className = "turn-body";

  for (const block of turn.blocks) {
    if (block.type === "text") {
      const el = document.createElement("div");
      if (turn.role === "user") {
        el.className = "turn-prompt";
        el.textContent = block.text;
      } else {
        el.className = "turn-reply";
        el.innerHTML = renderMarkdown(block.text);
      }
      body.appendChild(el);
    } else {
      const el = document.createElement("div");
      el.className = "note";
      el.textContent = block.type === "thinking" ? "💭 Thinking…" : block.label;
      body.appendChild(el);
    }
  }

  row.appendChild(body);
  transcriptEl.appendChild(row);
}

function loadResumeSession(filePath) {
  appEl.classList.remove("picker-active");
  appEl.classList.add("has-messages");
  transcriptEl.replaceChildren();
  window.clance.getChatSession(filePath).then((detail) => {
    if (detail) {
      for (const turn of detail.turns) renderHistoricalTurn(turn);
      scrollToBottom();
    }
    goalInput.disabled = false;
    goalInput.focus();
  });
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
    row.addEventListener("click", () => {
      window.clance.resumeConversation(session.id);
      loadResumeSession(session.filePath);
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

// A proposeText tool call renders as its own attributed row (not nested
// inside the flowing text reply) so an Accept/Reject decision is always
// visually distinct from prose, and so it isn't clobbered by any further
// streamed text in the same turn re-rendering that reply's innerHTML.
function appendProposal(proposal) {
  // A turn that opened with a proposal (no prose first) leaves its reply
  // row's typing indicator with nothing to ever fill it — drop that
  // empty row rather than leave a dangling "..." beside the proposal.
  if (currentReplyEl && currentReplyEl.dataset.pending) {
    currentReplyEl.closest(".turn")?.remove();
    currentReplyEl = null;
  }

  const row = document.createElement("div");
  row.className = "turn";
  row.appendChild(createAvatar("assistant"));

  const body = document.createElement("div");
  body.className = "turn-body";

  const card = document.createElement("div");
  card.className = "proposal-card";

  const textEl = document.createElement("div");
  textEl.className = "proposal-text";
  textEl.textContent = proposal.text;

  const actions = document.createElement("div");
  actions.className = "proposal-actions";
  const acceptBtn = document.createElement("button");
  acceptBtn.className = "proposal-accept";
  acceptBtn.textContent = "Accept & Insert";
  const rejectBtn = document.createElement("button");
  rejectBtn.className = "proposal-reject";
  rejectBtn.textContent = "Reject";
  actions.appendChild(acceptBtn);
  actions.appendChild(rejectBtn);

  const feedbackRow = document.createElement("div");
  feedbackRow.className = "proposal-feedback";
  feedbackRow.style.display = "none";
  const feedbackInput = document.createElement("input");
  feedbackInput.type = "text";
  feedbackInput.placeholder = "What should change?";
  const feedbackSend = document.createElement("button");
  feedbackSend.textContent = "Send";
  feedbackRow.appendChild(feedbackInput);
  feedbackRow.appendChild(feedbackSend);

  card.appendChild(textEl);
  card.appendChild(actions);
  card.appendChild(feedbackRow);
  body.appendChild(card);
  row.appendChild(body);
  transcriptEl.appendChild(row);
  scrollToBottom();

  acceptBtn.addEventListener("click", () => {
    window.clance.acceptProposal(proposal.text);
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    acceptBtn.textContent = "Inserted";
  });

  rejectBtn.addEventListener("click", () => {
    feedbackRow.style.display = "flex";
    feedbackInput.focus();
  });

  function sendFeedback() {
    const note = feedbackInput.value.trim();
    if (!note) return;
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    feedbackRow.style.display = "none";
    submitGoal(note);
  }
  feedbackSend.addEventListener("click", sendFeedback);
  feedbackInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendFeedback();
  });
}

window.clance.onShown((payload) => {
  transcriptEl.replaceChildren();
  appEl.classList.remove("has-messages", "picker-active");
  currentReplyEl = null;
  currentRawText = "";
  goalInput.value = "";
  goalInput.disabled = false;

  if (payload.mode === "picker") {
    showPicker();
  } else if (payload.mode === "resume") {
    window.clance.resumeConversation(payload.sessionId);
    loadResumeSession(payload.filePath);
  } else {
    window.clance.newConversation();
    goalInput.focus();
  }
});

window.clance.onChunk((text) => {
  if (!currentReplyEl) return;
  if (currentReplyEl.dataset.pending) {
    delete currentReplyEl.dataset.pending;
    currentRawText = "";
  }
  currentRawText += text;
  currentReplyEl.innerHTML = renderMarkdown(currentRawText);
  scrollToBottom();
});

window.clance.onProposal((proposal) => {
  appendProposal(proposal);
});

window.clance.onDone(() => {
  currentReplyEl = null;
  goalInput.disabled = false;
  goalInput.focus();
});

window.clance.onError((message) => {
  if (currentReplyEl) {
    currentReplyEl.textContent = `Error: ${message}`;
    delete currentReplyEl.dataset.pending;
  }
  currentReplyEl = null;
  goalInput.disabled = false;
  goalInput.focus();
});

window.clance.onNote((message) => {
  appendNote(message);
});

goalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && goalInput.value.trim()) {
    const goal = goalInput.value.trim();
    goalInput.value = "";
    submitGoal(goal);
  }
});
