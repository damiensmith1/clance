import { desktopCapturer, shell, systemPreferences } from "electron";

export type PermissionsStatus = {
  screenRecording: boolean;
  accessibility: boolean;
};

export function checkPermissions(): PermissionsStatus {
  return {
    screenRecording:
      systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
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
