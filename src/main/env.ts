import { app } from "electron";
import { readFileSync } from "fs";
import { join } from "path";

// A `.env` next to the app, read once at startup.
//
// The only thing that goes in it today is the assistant's decision-service
// key, which the TypeSafe SDK reads from the environment itself
// (TYPESAFE_API_KEY). Keeping it out of Clance's own config.json is
// deliberate: config.json is the file a user would copy between machines or
// paste into a bug report, and a key doesn't belong in either.
//
// A GUI app launched from the Finder inherits almost nothing from a login
// shell, so the variable being set in .zshrc is no help — hence a file.
export function loadEnvFile(): void {
  // In development the repo root is the app path; packaged, the file sits
  // beside the executable so a user can add a key without a rebuild.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, ".env"), join(app.getPath("userData"), ".env")]
    : [join(app.getAppPath(), ".env")];

  for (const path of candidates) {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;  // Not there is the ordinary case.
    }
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      // Quotes are stripped but nothing else is interpreted — no expansion,
      // no multi-line values. A key is a key.
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      // A real environment variable always wins, so a launch from a shell
      // that has one set isn't overridden by a stale file.
      if (value && process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}
