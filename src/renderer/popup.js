const goalInput = document.getElementById("goal");
const responseEl = document.getElementById("response");

window.clance.onShown(() => {
  goalInput.value = "";
  responseEl.textContent = "";
  goalInput.focus();
});

window.clance.onChunk((text) => {
  responseEl.textContent += text;
});

window.clance.onDone(() => {
  // Response finished streaming; nothing else to do yet (no injection mode).
});

goalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && goalInput.value.trim()) {
    responseEl.textContent = "";
    window.clance.submitGoal(goalInput.value.trim());
  }
});
