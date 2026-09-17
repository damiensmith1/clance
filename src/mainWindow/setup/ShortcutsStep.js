import { h, html, useState, useEffect, useRef } from "../../shared/vendor/preact-htm-standalone.module.js";

// ---- accelerator <-> keyboard event ----

const MODIFIER_GLYPHS = {
  Control: "⌃",
  Ctrl: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Command: "⌘",
  Cmd: "⌘",
  CommandOrControl: "⌘",
  CmdOrCtrl: "⌘",
  Super: "⌘",
  Meta: "⌘",
};

// macOS convention, and the order every native app displays them in.
const GLYPH_ORDER = ["⌃", "⌥", "⇧", "⌘"];

const KEY_GLYPHS = {
  Space: "Space",
  Return: "↩",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

// event.code, not event.key: on macOS, Option+G reports event.key as "©",
// and Shift+2 as "@", so key would record the wrong thing. code is the
// physical key and is layout-independent.
const PUNCTUATION_CODES = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const NAMED_CODES = {
  Space: "Space",
  Enter: "Return",
  NumpadEnter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

const MODIFIER_CODES = new Set([
  "MetaLeft", "MetaRight", "AltLeft", "AltRight",
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "CapsLock", "Fn", "FnLock",
]);

/** The Electron key name for a physical key, or null if unusable. */
function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_CODES[code]) return NAMED_CODES[code];
  if (PUNCTUATION_CODES[code]) return PUNCTUATION_CODES[code];
  return null;
}

function splitAccelerator(accelerator) {
  const parts = (accelerator || "").split("+").filter(Boolean);
  const glyphs = [];
  let key = "";
  for (const part of parts) {
    const glyph = MODIFIER_GLYPHS[part];
    if (glyph) {
      if (!glyphs.includes(glyph)) glyphs.push(glyph);
    } else {
      key = part;
    }
  }
  glyphs.sort((a, b) => GLYPH_ORDER.indexOf(a) - GLYPH_ORDER.indexOf(b));
  return { glyphs, key };
}

function keyLabel(key) {
  return KEY_GLYPHS[key] ?? key;
}

// ---- validation ----
//
// A global hotkey is registered with the OS, so it fires no matter which
// app is focused. That makes the rules stricter than an in-app shortcut:
//
//  - At least one of ⌘/⌥/⌃ is required. Without a modifier the hotkey
//    fires on every keystroke system-wide — binding "G" would mean
//    pressing g in any app triggers Clance instead of typing a letter.
//    Shift doesn't count: ⇧G is still just a letter.
//  - ⌘ on its own isn't enough either. Plain ⌘+key is the universal
//    shortcut space every Mac app uses (⌘C, ⌘V, ⌘S, ⌘Q), and taking one
//    globally steals it from every app at once. It needs ⌥, ⌃ or ⇧ too.
//  - Function keys are the one exception to the modifier rule: they don't
//    produce text, so a bare F5 is safe and is a normal thing to bind.
//  - A short list of OS-reserved combinations is rejected outright.

const RESERVED = [
  { test: (m, k) => k === "Tab" && m.cmd, message: "⌘Tab is the macOS app switcher." },
  { test: (m, k) => k === "Space" && m.cmd && !m.alt && !m.ctrl, message: "⌘Space is Spotlight." },
  { test: (m, k) => k === "Q" && m.cmd && m.ctrl, message: "⌃⌘Q locks the screen." },
  { test: (m, k) => k === "Escape" && m.cmd && m.alt, message: "⌘⌥⎋ is Force Quit." },
  { test: (m, k) => k === "Escape" && !m.cmd && !m.alt && !m.ctrl, message: "Escape cancels recording." },
];

function validate(mods, key) {
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);

  for (const rule of RESERVED) {
    if (rule.test(mods, key)) return rule.message;
  }

  const hasRealModifier = mods.cmd || mods.alt || mods.ctrl;
  if (!hasRealModifier && !isFunctionKey) {
    return "Add ⌘, ⌥ or ⌃ — a global shortcut without one would fire every time you type this key.";
  }
  if (mods.cmd && !mods.alt && !mods.ctrl && !mods.shift && !isFunctionKey) {
    return "⌘ alone clashes with every app's own shortcuts. Add ⌥, ⌃ or ⇧.";
  }
  return null;
}

function buildAccelerator(mods, key) {
  const parts = [];
  if (mods.ctrl) parts.push("Control");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  if (mods.cmd) parts.push("Command");
  parts.push(key);
  return parts.join("+");
}

function modsFromEvent(event) {
  return { cmd: event.metaKey, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey };
}

function glyphsFromMods(mods) {
  const glyphs = [];
  if (mods.ctrl) glyphs.push("⌃");
  if (mods.alt) glyphs.push("⌥");
  if (mods.shift) glyphs.push("⇧");
  if (mods.cmd) glyphs.push("⌘");
  return glyphs;
}

// ---- component ----

export function ShortcutsStep({ onComplete, onBack } = {}) {
  const [actions, setActions] = useState(null);
  const [values, setValues] = useState({});
  const [recordingId, setRecordingId] = useState(null);
  const [liveGlyphs, setLiveGlyphs] = useState([]);
  const [error, setError] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const recordingRef = useRef(null);

  useEffect(() => {
    // Reads the *saved* accelerators, falling back to each action's default
    // only for one that's never been set. The previous version seeded from
    // defaults unconditionally, so the UI showed defaults after a rebind —
    // and saving from there would have overwritten the real binding.
    Promise.all([
      window.clanceApp.getShortcutActions(),
      window.clanceApp.getPreferences(),
    ]).then(([list, prefs]) => {
      const saved = (prefs && prefs.shortcuts) || {};
      const initial = {};
      for (const action of list) {
        initial[action.id] = saved[action.id] || action.defaultAccelerator;
      }
      setActions(list);
      setValues(initial);
    });
  }, []);

  function stopRecording() {
    recordingRef.current = null;
    setRecordingId(null);
    setLiveGlyphs([]);
    // Hands the global hotkeys back to the main process.
    window.clanceApp.setShortcutCapture(false);
  }

  function commit(actionId, accelerator) {
    const next = { ...values, [actionId]: accelerator };
    setValues(next);
    setError(null);
    window.clanceApp
      .saveShortcuts({ [actionId]: accelerator })
      .then(() => {
        setSavedId(actionId);
        setTimeout(() => setSavedId(null), 1600);
        stopRecording();
      })
      .catch((err) => {
        // The main process is the final authority: it probes the
        // accelerator by actually registering it, and rejects collisions
        // between actions.
        setError(err && err.message ? err.message : "Couldn't save that shortcut.");
        setValues(values);
        stopRecording();
      });
  }

  useEffect(() => {
    if (!recordingId) return;

    function onKeyDown(event) {
      event.preventDefault();
      event.stopPropagation();

      const mods = modsFromEvent(event);

      // Modifier held on its own: show it live so the field responds while
      // the user is still assembling the combination.
      if (MODIFIER_CODES.has(event.code)) {
        setLiveGlyphs(glyphsFromMods(mods));
        return;
      }

      if (event.code === "Escape" && !mods.cmd && !mods.alt && !mods.ctrl) {
        setError(null);
        stopRecording();
        return;
      }

      // Backspace with no modifiers clears back to the action's default,
      // which is the convention in native shortcut fields.
      if ((event.code === "Backspace" || event.code === "Delete") && !mods.cmd && !mods.alt && !mods.ctrl) {
        const action = actions.find((a) => a.id === recordingId);
        if (action) commit(recordingId, action.defaultAccelerator);
        return;
      }

      const key = keyFromCode(event.code);
      if (!key) {
        setError("That key can't be used in a shortcut.");
        return;
      }

      const problem = validate(mods, key);
      if (problem) {
        setLiveGlyphs(glyphsFromMods(mods));
        setError(problem);
        return;
      }

      const accelerator = buildAccelerator(mods, key);
      const clash = Object.entries(values).find(
        ([id, value]) => id !== recordingId && value === accelerator
      );
      if (clash) {
        const other = actions.find((a) => a.id === clash[0]);
        setError(`Already used by ${other ? other.label : clash[0]}.`);
        return;
      }

      commit(recordingId, accelerator);
    }

    function onKeyUp(event) {
      if (MODIFIER_CODES.has(event.code)) setLiveGlyphs(glyphsFromMods(modsFromEvent(event)));
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recordingId, values, actions]);

  function beginRecording(actionId) {
    setError(null);
    setSavedId(null);
    setLiveGlyphs([]);
    recordingRef.current = actionId;
    setRecordingId(actionId);
    // Clance's own global hotkeys are registered with the OS, so without
    // this, pressing the very shortcut you're trying to rebind would fire
    // the feature instead of being recorded.
    window.clanceApp.setShortcutCapture(true);
  }

  // The wizard's Continue has to *save*, even when nothing was changed:
  // `shortcutsConfigured` is only set by setup:save-shortcuts, and
  // setupStatus.isComplete depends on it. Calling onComplete() directly
  // meant a user who accepted the defaults never set that flag, so setup
  // never completed and the wizard reappeared on every launch.
  function confirmAndContinue() {
    setConfirming(true);
    setError(null);
    window.clanceApp
      .saveShortcuts(values)
      .then(() => {
        setConfirming(false);
        onComplete();
      })
      .catch((err) => {
        setConfirming(false);
        setError(err && err.message ? err.message : "Couldn't save those shortcuts.");
      });
  }

  if (actions === null) {
    return html`<p class="empty-note">Loading…</p>`;
  }

  const rows = actions.map((action) => {
    const isRecording = recordingId === action.id;
    const { glyphs, key } = splitAccelerator(values[action.id]);
    return html`
      <div class="preference-row" key=${action.id}>
        <div>
          <div class="preference-title">${action.label}</div>
          ${onComplete && html`<div class="preference-description">${action.description}</div>`}
        </div>
        <div class="shortcut-field-wrap">
          ${isRecording
            ? html`
                <button class="shortcut-field shortcut-field-recording" onClick=${stopRecording}>
                  ${liveGlyphs.length > 0
                    ? liveGlyphs.map((g) => html`<span class="shortcut-key">${g}</span>`)
                    : html`<span class="shortcut-prompt">press keys…</span>`}
                </button>
                <span class="shortcut-hint">esc cancel · ⌫ default</span>
              `
            : html`
                <button
                  class="shortcut-field"
                  title="Click, then press the keys you want"
                  onClick=${() => beginRecording(action.id)}
                >
                  ${glyphs.map((g) => html`<span class="shortcut-key">${g}</span>`)}
                  ${key && html`<span class="shortcut-key">${keyLabel(key)}</span>`}
                </button>
                ${savedId === action.id
                  ? html`<span class="shortcut-hint shortcut-hint-ok">saved</span>`
                  : null}
              `}
        </div>
      </div>
      ${isRecording && error ? html`<p class="setup-error shortcut-error">${error}</p>` : null}
    `;
  });

  if (!onComplete) {
    return html`
      ${rows}
      ${!recordingId && error && html`<p class="setup-error">${error}</p>`}
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Choose your shortcuts</h2>
      <p>Click one and press new keys. Each needs ⌘, ⌥ or ⌃ so it can't fire while you type.</p>
      ${rows}
      ${!recordingId && error && html`<p class="setup-error">${error}</p>`}
      <div class="setup-step-actions">
        <span class="setup-step-actions-status mono-label">changes save instantly</span>
        ${onBack && html`<button class="btn-quiet" onClick=${onBack}>Back</button>`}
        <button class="btn-primary" disabled=${confirming} onClick=${confirmAndContinue}>
          ${confirming ? "Saving…" : html`Continue <span class="key-hint">↩</span>`}
        </button>
      </div>
    </div>
  `;
}
