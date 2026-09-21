import { execFile } from "child_process";
import { readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import * as ax from "../ax";
import { type Outcome, ok, fail } from "./types";

const run = promisify(execFile);

// Where macOS keeps apps. Read rather than configured, so an app installed
// after Clance is launchable without Clance being told about it — the same
// reason the menu resolver reads menus instead of listing them.
const APP_DIRECTORIES = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  join(homedir(), "Applications"),
];

export type InstalledApp = { name: string; path: string };

let installed: InstalledApp[] | null = null;

// Cached for the process. A newly installed app not showing up until Clance
// restarts is a much smaller problem than re-reading five directories on
// every spoken command.
export function installedApps(): InstalledApp[] {
  if (installed) return installed;
  const found = new Map<string, InstalledApp>();
  for (const directory of APP_DIRECTORIES) {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;  // Not every directory exists on every Mac.
    }
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const name = entry.slice(0, -4);
      // First directory wins, so a user's own copy doesn't shadow the
      // system one it was listed after.
      if (!found.has(name.toLowerCase())) {
        found.set(name.toLowerCase(), { name, path: join(directory, entry) });
      }
    }
  }
  installed = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return installed;
}

export function forgetInstalledApps(): void {
  installed = null;
}

export async function launchApp(name: string): Promise<Outcome> {
  const needle = name.trim().toLowerCase();
  const apps = installedApps();
  const exact = apps.find((app) => app.name.toLowerCase() === needle);
  const partial = apps.filter((app) => app.name.toLowerCase().includes(needle));
  const match = exact ?? (partial.length === 1 ? partial[0] : undefined);

  if (!match) {
    if (partial.length > 1) {
      const options = partial.slice(0, 8).map((app) => `"${app.name}"`).join(", ");
      return fail(`"${name}" matches more than one app: ${options}. Be more specific.`);
    }
    return fail(`No app called "${name}" is installed.`);
  }

  try {
    // `open` rather than a spawn of the binary: it's what the Finder does,
    // it brings an already-running app forward instead of starting a second
    // copy, and it needs nothing to be frontmost first.
    await run("/usr/bin/open", ["-a", match.path]);
    return ok(`Opened ${match.name}.`);
  } catch (error) {
    return fail(`Couldn't open ${match.name}: ${(error as Error).message}`);
  }
}

export async function quitApp(name: string): Promise<Outcome> {
  const matches = await ax.appByName(name);
  const running = matches[0];
  if (!running) return fail(`${name} isn't running.`);
  const label = running.name ?? name;
  try {
    // Asks the app to quit, the same way ⌘Q does, so unsaved work still
    // gets its "do you want to save?" sheet rather than being lost. That
    // sheet is also why this is `confirm`-risk in the assistant: the quit
    // may finish as a dialog the user has to answer.
    // By bundle id where there is one — an app's AppleScript name and its
    // displayed name aren't always the same word.
    const specifier = running.bundleId ? `id "${running.bundleId}"` : `"${label.replace(/"/g, "")}"`;
    await run("/usr/bin/osascript", ["-e", `tell application ${specifier} to quit`]);
    return ok(`Asked ${label} to quit.`);
  } catch (error) {
    return fail(`${label} didn't quit: ${(error as Error).message}`);
  }
}
