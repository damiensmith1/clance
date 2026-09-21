// Recording HUD renderer. Owns the microphone: audio capture has to happen
// in a renderer because the main process has no getUserMedia, and this
// window is already on screen drawing a level meter, so it doubles as the
// recorder rather than adding a second hidden window.

const hudEl = document.getElementById("hud");
const labelEl = document.getElementById("label");
const meterEl = document.getElementById("meter");
const elapsedEl = document.getElementById("elapsed");
const actionEl = document.getElementById("action");

const METER_BARS = 11;
for (let i = 0; i < METER_BARS; i += 1) {
  meterEl.appendChild(document.createElement("span"));
}
const bars = Array.from(meterEl.children);

// Captured audio, as the 128-sample Float32 frames the worklet posts. Kept
// as a list and concatenated once at the end rather than repeatedly growing
// one buffer, which would be O(n^2) over a multi-minute recording.
let chunks = [];
let totalSamples = 0;

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let silentNode = null;

let settings = { sampleRate: 16000, autoStopSilenceMs: 1500, maxDurationMs: 300000 };
let startedAt = 0;
let sawSpeech = false;
let quietSince = 0;
let elapsedTimer = null;
let stopping = false;

// RMS below this counts as silence. Set from the observed noise floor of a
// quiet room with a built-in mic; the auto-stop only arms *after* speech has
// been detected, so a user who takes a moment to start talking is never cut
// off by it.
const SILENCE_RMS = 0.006;
const SPEECH_RMS = 0.02;

// The pill's side padding plus its dot and gaps, beyond the label itself.
const HUD_CHROME_PX = 52;
// While recording the pill holds the meter and timer, so its width is fixed.
const RECORDING_WIDTH_PX = 210;

let actionHandler = null;
actionEl.addEventListener("click", () => actionHandler?.());

// The assistant (⌥A) borrows this window. While it's up, the dictation
// chrome's labels are wrong — the user isn't dictating, they're giving a
// command — so the assistant's own view drives the pill instead. Capture
// itself is unchanged: it's the same microphone recorded the same way.
let assistantMode = false;

// One text slot. While recording it's hidden entirely and the meter does
// the talking; every other state gets a short phrase, and the states that
// need the user to fix something get an action. After each change main is
// told how wide the pill needs to be, so a sentence widens it instead of
// being cut off.
function setState(state, label, action) {
  hudEl.className = `state-${state}`;
  if (label !== undefined) labelEl.textContent = label;
  actionHandler = action?.onClick ?? null;
  actionEl.hidden = !action;
  actionEl.textContent = action?.label ?? "";
  requestAnimationFrame(() => {
    const needed =
      state === "recording"
        ? RECORDING_WIDTH_PX
        : HUD_CHROME_PX + labelEl.scrollWidth + (action ? actionEl.getBoundingClientRect().width + 10 : 0);
    window.clanceDictation.resize(needed);
  });
}

// Bar heights are capped at METER_HEIGHT_PX to match the CSS box — they
// used to be computed for a taller HUD and would overflow the compact one.
const METER_HEIGHT_PX = 14;

function renderMeter(level) {
  // Perceptual-ish curve: raw RMS from speech sits low in the 0-1 range and
  // a linear meter looks dead even when capture is fine.
  const scaled = Math.min(1, Math.sqrt(level) * 2.6);
  for (let i = 0; i < bars.length; i += 1) {
    const threshold = (i + 1) / bars.length;
    const active = scaled >= threshold * 0.55;
    // Centre bars run taller than the edges, so the meter reads as a
    // waveform rather than a flat block.
    const centreBias = 0.55 + 0.45 * (1 - Math.abs(i - (bars.length - 1) / 2) / (bars.length / 2));
    const height = active ? 3 + scaled * (METER_HEIGHT_PX - 3) * centreBias : 2.5;
    bars[i].style.height = `${Math.round(height * 10) / 10}px`;
    bars[i].classList.toggle("on", active);
  }
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// The worklet is defined as a Blob rather than its own file: this project
// has no bundler and copies renderer directories verbatim (see the build
// script), so an inline module keeps the worklet from becoming a second
// path that has to be kept in sync with the copy step.
const WORKLET_SOURCE = `
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // Copy: the render quantum's buffer is reused by the audio thread
      // after this returns, so posting it without copying would hand over
      // memory that is about to be overwritten.
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor("clance-recorder", RecorderProcessor);
`;

async function startCapture() {
  chunks = [];
  totalSamples = 0;
  sawSpeech = false;
  quietSince = 0;
  stopping = false;
  startedAt = Date.now();

  try {
    const device = await chosenInputDeviceId();
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(device) });
    } catch (error) {
      // A chosen mic that can't be opened (unplugged mid-enumeration, busy)
      // shouldn't stop dictation; the system default still might work.
      if (!device) throw error;
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(null) });
    }
  } catch (error) {
    window.clanceDictation.micError(error && error.message ? error.message : String(error));
    setState("error", "Allow microphone access", {
      label: "open settings",
      onClick: () => window.clanceDictation.action("open-microphone-settings"),
    });
    return;
  }

  // Asking the AudioContext for 16kHz makes the browser resample the mic
  // input for us, which is exactly what whisper wants — no manual
  // downsampling, and no risk of getting it subtly wrong.
  audioContext = new AudioContext({ sampleRate: settings.sampleRate });
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  try {
    await audioContext.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "clance-recorder");
  workletNode.port.onmessage = (event) => handleFrame(event.data);
  // The worklet needs a path to a destination or some Chromium versions
  // won't pull from it at all — but routing it straight to the speakers
  // marks the page as playing audio, which is what puts a speaker glyph
  // next to Clance in the OS. A zero-gain node in between keeps the graph
  // running while guaranteeing the output is silent, so nothing is ever
  // played and nothing is ever flagged as audible.
  silentNode = audioContext.createGain();
  silentNode.gain.value = 0;
  source.connect(workletNode);
  workletNode.connect(silentNode);
  silentNode.connect(audioContext.destination);

  setState("recording", "Listening…");
  elapsedTimer = setInterval(() => {
    elapsedEl.textContent = formatElapsed(Date.now() - startedAt);
  }, 250);
}

function audioConstraints(deviceId) {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

// The microphone chosen in Settings, if it's connected: matched by id, then
// by name (an id can change when a Bluetooth device is re-paired). Null means
// record from macOS's default input.
async function chosenInputDeviceId() {
  const chosen = settings.inputDevice;
  if (!chosen) return null;
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    const match = inputs.find((d) => d.deviceId === chosen.id) ?? inputs.find((d) => d.label === chosen.label);
    return match ? match.deviceId : null;
  } catch {
    return null;
  }
}

function handleFrame(frame) {
  if (stopping) return;
  chunks.push(frame);
  totalSamples += frame.length;

  let sumSquares = 0;
  for (let i = 0; i < frame.length; i += 1) sumSquares += frame[i] * frame[i];
  const rms = Math.sqrt(sumSquares / frame.length);
  renderMeter(rms);

  const now = Date.now();
  if (rms > SPEECH_RMS) {
    sawSpeech = true;
    quietSince = 0;
  } else if (sawSpeech && rms < SILENCE_RMS) {
    // Auto-stop arms only after real speech, so a slow start is never cut
    // off — and it routes through the main process so manual and automatic
    // stops share one code path.
    if (quietSince === 0) quietSince = now;
    else if (now - quietSince > settings.autoStopSilenceMs) requestStop();
  } else if (rms >= SILENCE_RMS) {
    quietSince = 0;
  }

  if (now - startedAt > settings.maxDurationMs) requestStop();
}

function requestStop() {
  if (stopping) return;
  stopping = true;
  window.clanceDictation.requestStop();
}

function teardownCapture() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (silentNode) {
    silentNode.disconnect();
    silentNode = null;
  }
  // Stopping every track is what actually releases the microphone and
  // clears the macOS recording indicator — closing the context alone
  // leaves the device held open.
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function flushAudio() {
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  chunks = [];
  totalSamples = 0;
  // Hand over the underlying buffer; the main process writes it to a WAV.
  window.clanceDictation.sendAudio(merged.buffer);
}

window.clanceDictation.onStart((payload) => {
  settings = { ...settings, ...payload };
  elapsedEl.textContent = "0:00";
  renderMeter(0);
  setState("recording", "Listening…");
  startCapture();
});

window.clanceDictation.onStop(() => {
  stopping = true;
  teardownCapture();
  flushAudio();
});

window.clanceDictation.onCancel(() => {
  stopping = true;
  teardownCapture();
  chunks = [];
  totalSamples = 0;
});

window.clanceDictation.onState((payload) => {
  if (payload && payload.state === "transcribing") {
    setState("transcribing", assistantMode ? "Working out what you meant…" : "Transcribing…");
  }
});

window.clanceDictation.onAssistantOpen(() => {
  assistantMode = true;
});

window.clanceDictation.onAssistantClose(() => {
  assistantMode = false;
});

// One line, always: the indicator has to be legible without looking away
// from the work, so a long transcript is never shown — what was understood
// is (docs/assistant.md, "What the user sees and hears").
window.clanceDictation.onAssistantView((view) => {
  if (!view) return;
  assistantMode = true;
  switch (view.state) {
    case "listening":
      // Nothing heard yet keeps the recording pill and its meter; once
      // there are words, they replace it so the user can see what landed.
      if (view.heard) setState("transcribing", view.heard);
      else setState("recording", "Listening…");
      return;
    case "thinking":
      setState("transcribing", view.heard);
      return;
    case "asking":
      setState("unavailable", `${view.question}  ${view.options.join(" · ")}`);
      return;
    case "acting":
      setState("transcribing", view.label);
      return;
    case "said":
      setState(view.ok ? "done" : "failed", view.message);
      return;
  }
});

// The target's title arrives with the result: it's still being read when
// recording starts.
window.clanceDictation.onDone((payload) => {
  const typed = payload && payload.targetApp ? `Typed into ${payload.targetApp}` : "Typed";
  setState("done", payload && payload.inserted ? typed : "Copied · paste with ⌘V");
});

window.clanceDictation.onEmpty(() => {
  setState("empty", "Didn't catch that");
});

window.clanceDictation.onError((payload) => {
  setState("failed", "Dictation failed");
});

// The only state that genuinely needs the full sentence, since it's
// telling the user how to fix something.
// Short labels by reason; main's full sentence is the fallback. Each points
// at the one place that fixes it.
window.clanceDictation.onUnavailable((payload) => {
  const reason = payload && payload.reason;
  if (reason === "no-microphone") {
    setState("unavailable", "Allow microphone access", {
      label: "open settings",
      onClick: () => window.clanceDictation.action("open-microphone-settings"),
    });
    return;
  }
  const label =
    reason === "no-model"
      ? "Install a speech model first"
      : reason === "no-binary"
        ? "Install the speech engine first"
        : (payload && payload.message) || "Dictation isn't set up";
  setState("unavailable", label, {
    label: "open settings",
    onClick: () => window.clanceDictation.action("open-settings"),
  });
});
