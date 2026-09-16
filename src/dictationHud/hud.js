// Recording HUD renderer. Owns the microphone: audio capture has to happen
// in a renderer because the main process has no getUserMedia, and this
// window is already on screen drawing a level meter, so it doubles as the
// recorder rather than adding a second hidden window.

const hudEl = document.getElementById("hud");
const labelEl = document.getElementById("label");
const meterEl = document.getElementById("meter");
const elapsedEl = document.getElementById("elapsed");

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

// One text slot. While recording it's hidden entirely and the meter does
// the talking; every other state gets a short phrase.
function setState(state, label) {
  hudEl.className = `state-${state}`;
  if (label !== undefined) labelEl.textContent = label;
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
    bars[i].classList.toggle("hot", scaled > 0.75 && active);
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
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    window.clanceDictation.micError(error && error.message ? error.message : String(error));
    setState("error", "No microphone access");
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
    setState("transcribing", "Transcribing…");
  }
});

window.clanceDictation.onDone((payload) => {
  setState("done", payload && payload.inserted ? "Inserted" : "Copied to clipboard");
});

window.clanceDictation.onEmpty(() => {
  setState("error", "Didn't catch that");
});

window.clanceDictation.onError((payload) => {
  setState("error", "Dictation failed");
});

// The only state that genuinely needs the full sentence, since it's
// telling the user how to fix something.
window.clanceDictation.onUnavailable((payload) => {
  setState("unavailable", (payload && payload.message) || "Dictation isn't set up");
});
