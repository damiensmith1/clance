import { renderMarkdown, attachCopyHandler } from "../shared/markdown.js";

const appEl = document.getElementById("app");
const goalInput = document.getElementById("goal");
const transcriptEl = document.getElementById("transcript");

attachCopyHandler(transcriptEl);

const PERSON_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>';
const ROBOT_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="10" rx="2.5"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/><circle cx="9" cy="13" r="1.3"/><circle cx="15" cy="13" r="1.3"/><path d="M9 16.5h6"/></svg>';

let currentReplyEl = null;
let currentRawText = "";

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

// Every open is a fresh conversation: clear the transcript, reset layout
// back to input-only, and start a new SDK session.
window.clance.onShown(() => {
  transcriptEl.replaceChildren();
  appEl.classList.remove("has-messages");
  currentReplyEl = null;
  currentRawText = "";
  goalInput.value = "";
  goalInput.disabled = false;
  window.clance.newConversation();
  goalInput.focus();
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
    goalInput.disabled = true;
    currentReplyEl = appendTurn(goal);
    currentRawText = "";
    window.clance.submitGoal(goal);
  }
});
