const appEl = document.getElementById("app");
const goalInput = document.getElementById("goal");
const transcriptEl = document.getElementById("transcript");

let currentReplyEl = null;

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

function appendTurn(goal) {
  const turn = document.createElement("div");
  turn.className = "turn";

  const promptEl = document.createElement("div");
  promptEl.className = "turn-prompt";
  promptEl.textContent = goal;

  const replyEl = document.createElement("div");
  replyEl.className = "turn-reply";
  replyEl.dataset.pending = "true";
  replyEl.appendChild(createTypingIndicator());

  turn.appendChild(promptEl);
  turn.appendChild(replyEl);
  transcriptEl.appendChild(turn);
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

// Reopening (including after auto-hiding on blur mid-request) should never
// wipe the transcript — only clear the input for the next turn.
window.clance.onShown(() => {
  goalInput.value = "";
  goalInput.focus();
});

window.clance.onChunk((text) => {
  if (!currentReplyEl) return;
  if (currentReplyEl.dataset.pending) {
    currentReplyEl.textContent = "";
    delete currentReplyEl.dataset.pending;
  }
  currentReplyEl.textContent += text;
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
    window.clance.submitGoal(goal);
  }
});
