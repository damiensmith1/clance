import { desktopCapturer, shell, systemPreferences } from "electron";

export type PermissionsStatus = {
  screenRecording: boolean;
  accessibility: boolean;
  // Dictation only. Deliberately *not* part of setupStatus.ts's
  // `isComplete`: dictation is optional, so a user who never dictates must
  // not be held in the setup wizard over a microphone grant they don't
  // need. Surfaced in the dictation UI instead.
  microphone: boolean;
};

export function checkPermissions(): PermissionsStatus {
  return {
    screenRecording:
      systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    microphone: systemPreferences.getMediaAccessStatus("microphone") === "granted",
  };
}

// Unlike Screen Recording (see requestScreenRecordingAccess below), the
// microphone has a real request API that shows the system prompt directly,
// so there's no "provoke macOS into listing the app" trick needed here.
// Resolves false when already denied — macOS only ever prompts once, and
// after that the user has to go to Settings, which is what the caller
// offers on a false return.
export async function requestMicrophoneAccess(): Promise<boolean> {
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
}

export function openMicrophoneSettings(): Promise<void> {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
  );
}

// Unlike camera/mic, Electron has no "request access" API for screen
// recording — macOS only registers the app in the Screen Recording
// settings list the first time it actually attempts a capture (merely
// checking status via getMediaAccessStatus never does). This makes that
// first attempt happen on demand, from an explicit user button press,
// rather than waiting for the popup's own first real capture — the result
// is discarded either way since it's denied by default until the user
// grants it in the Settings pane this opens right after.
export async function requestScreenRecordingAccess(): Promise<void> {
  try {
    await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
  } catch {
    // Expected when access isn't granted yet — the attempt itself is what
    // registers the app with macOS.
  }
  await openScreenRecordingSettings();
}

export function openScreenRecordingSettings(): Promise<void> {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  );
}

export function openAccessibilitySettings(): Promise<void> {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
}
