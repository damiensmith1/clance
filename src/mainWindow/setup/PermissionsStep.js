import { h, html, useState, useEffect } from "../../shared/vendor/preact-htm-standalone.module.js";
import { StatusCard } from "../components/StatusCard.js";

const RECHECK_MS = 2000;

export function PermissionsStep({ onComplete, onBack } = {}) {
  const [status, setStatus] = useState(null);
  // The restart hint only appears once the user has actually been sent to
  // System Settings — before that it would just be noise.
  const [openedScreenSettings, setOpenedScreenSettings] = useState(false);
  const [openedAccessibilitySettings, setOpenedAccessibilitySettings] = useState(false);

  function refresh() {
    return window.clanceApp.recheckPermissions().then((s) => {
      setStatus(s);
      return s;
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  // Permissions are granted in System Settings, outside Clance, so check
  // again whenever the window comes back to the front, and poll while one is
  // still missing. The check reads local state and is cheap.
  const allGranted = Boolean(status?.accessibility && status?.screenRecording);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const timer = allGranted ? null : setInterval(refresh, RECHECK_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) clearInterval(timer);
    };
  }, [allGranted]);

  if (status === null) {
    // Settings keeps the rows' shape while checking, so nothing jumps.
    return onComplete
      ? html`<p class="empty-note">Checking…</p>`
      : html`
          <${StatusCard} title="Accessibility" description="Type and click in other apps when you ask." status="checking…" />
          <${StatusCard} title="Screen Recording" description="Hand Clance a screenshot with ⌘⇧R." status="checking…" />
          <${StatusCard} title="Microphone" description="Needed for dictation." status="checking…" />
        `;
  }

  // Accessibility is the only hard requirement — it's what lets Clance type
  // and click for you. Screen Recording is optional (see setupStatus.ts).
  const canContinue = status.accessibility;

  if (!onComplete) {
    return html`
      <${StatusCard}
        title="Accessibility"
        description="Type and click in other apps when you ask."
        status=${status.accessibility ? "granted" : "not granted"}
        tone=${status.accessibility ? "ok" : "attention"}
        actionLabel=${status.accessibility ? null : "Grant"}
        onAction=${() => window.clanceApp.openAccessibilitySettings()}
      />
      <${StatusCard}
        title="Screen Recording"
        description="Hand Clance a screenshot with ⌘⇧R."
        status=${status.screenRecording ? "granted" : "off · optional"}
        tone=${status.screenRecording ? "ok" : "plain"}
        actionLabel=${status.screenRecording ? null : "Grant"}
        onAction=${() => window.clanceApp.requestScreenRecordingAccess()}
      />
      <${StatusCard}
        title="Microphone"
        description="Needed for dictation."
        status=${status.microphone ? "granted" : "not granted"}
        tone=${status.microphone ? "ok" : "attention"}
        actionLabel=${status.microphone ? null : "Grant"}
        onAction=${() =>
          window.clanceApp.requestMicrophone().then((granted) => {
            if (!granted) window.clanceApp.openMicrophoneSettings();
            refresh();
          })}
      />
    `;
  }

  return html`
    <div class="setup-step">
      <h2>Allow Clance to act for you</h2>
      <p>
        Accessibility is required; Screen Recording is optional. You stay in control: either can be
        turned off in System Settings.
      </p>
      <${StatusCard}
        title="Accessibility"
        description="Type and click in other apps when you ask."
        status=${status.accessibility ? "granted" : "required · not granted"}
        tone=${status.accessibility ? "ok" : "attention"}
        actionLabel=${status.accessibility ? null : "Grant"}
        onAction=${() => {
          setOpenedAccessibilitySettings(true);
          window.clanceApp.openAccessibilitySettings();
        }}
      />
      ${!status.accessibility && openedAccessibilitySettings
        ? html`
            <p class="setup-hint">
              Already switched on but still showing here? After Clance is reinstalled, macOS can keep
              an old entry that no longer applies. Select Clance in that list, remove it with the −
              button, then click Grant again.
            </p>
          `
        : null}
      <${StatusCard}
        title="Screen Recording"
        description="Hand Clance a screenshot with ⌘⇧R."
        status=${status.screenRecording ? "granted" : "optional · off"}
        tone=${status.screenRecording ? "ok" : "plain"}
        actionLabel=${status.screenRecording ? null : "Grant"}
        onAction=${() => {
          setOpenedScreenSettings(true);
          window.clanceApp.requestScreenRecordingAccess();
        }}
      />
      ${!status.screenRecording && openedScreenSettings
        ? html`
            <p class="setup-hint">
              Clance not in the list? Click + below it and choose Clance from Applications. Already
              switched it on? macOS only applies Screen Recording after Clance restarts.
              <button class="btn-link" onClick=${() => window.clanceApp.relaunchApp()}>Restart Clance</button>
            </p>
          `
        : null}
      <div class="setup-step-actions">
        <span class="setup-step-actions-status status ${canContinue ? "status-ok" : "status-attention"}">
          ${canContinue ? "ready" : "waiting for Accessibility…"}
        </span>
        ${onBack && html`<button class="btn-quiet" onClick=${onBack}>Back</button>`}
        <button class="btn-primary" disabled=${!canContinue} onClick=${onComplete}>
          ${status.screenRecording || !canContinue ? "Continue" : "Continue without screenshots"}
          <span class="key-hint">↩</span>
        </button>
      </div>
    </div>
  `;
}
