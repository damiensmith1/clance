import { app } from "electron";

// Not stored in our own config.json — macOS/Electron already persists this
// at the OS level, so it's read live rather than duplicated and risking
// drift (same reasoning as auth/permission status never being cached).
export function getLaunchOnLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setLaunchOnLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}
