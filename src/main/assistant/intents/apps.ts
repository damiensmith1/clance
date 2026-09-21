import * as ax from "../../ax";
import { activateApp, installedApps, launchApp, quitApp } from "../../capabilities";
import type { Candidate, Context, Resolution, Resolver } from "../types";

// Launching, switching and quitting. Three resolvers rather than one,
// because they differ in exactly the way the architecture cares about:
// launch and switch are reversible in practice, quit is not, and risk is a
// property of the intent.

async function runningApps(): Promise<Candidate[]> {
  const apps = await ax.windows();
  return apps
    // The app already in front is not something to switch to or quit by
    // name — "quit this" is a different phrase and a different intent.
    .filter((app) => !app.frontmost && app.name)
    .map((app) => ({
      id: String(app.pid),
      label: app.name as string,
      detail: app.windows.length > 1 ? `${app.windows.length} windows` : app.windows[0],
    }));
}

export const launchResolver: Resolver = {
  id: "launch",
  risk: "safe",
  async candidates() {
    return installedApps().map((app) => ({ id: app.path, label: app.name }));
  },
  async resolve(candidate) {
    return {
      intent: "launch",
      label: `Open ${candidate.label}`,
      risk: "safe",
      perform: () => launchApp(candidate.label),
    };
  },
};

export const switchResolver: Resolver = {
  id: "switch",
  risk: "safe",
  candidates: runningApps,
  async resolve(candidate, ctx) {
    // Switching back is a real inverse, so this is one of the few actions
    // with a first-tier undo rather than a "can't".
    const previous = ctx.app.name;
    return {
      intent: "switch",
      label: `Switch to ${candidate.label}`,
      risk: "safe",
      perform: () => activateApp(candidate.label),
      undo: () => activateApp(previous),
    };
  },
};

export const quitResolver: Resolver = {
  id: "quit",
  // Always confirmed. An app with unsaved work answers a quit with a
  // sheet, and an app without one is simply gone — neither is something
  // to do on a single mishearing.
  risk: "confirm",
  candidates: runningApps,
  async resolve(candidate): Promise<Resolution> {
    return {
      intent: "quit",
      label: `Quit ${candidate.label}`,
      risk: "confirm",
      perform: () => quitApp(candidate.label),
    };
  },
};
