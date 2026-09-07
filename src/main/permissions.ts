import { shell, systemPreferences } from "electron";

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
