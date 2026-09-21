import * as ax from "../ax";
import { activateApp as activateFrontApp, listOpenWindows as listWindowServerTitles } from "../frontApp";
import { type Outcome, ok, fail } from "./types";

export async function listOpenWindows(): Promise<Outcome> {
  const apps = await ax.windows();
  if (apps.length > 0) {
    const lines = apps.map((entry) => {
      const heading = `${entry.name}${entry.frontmost ? " (frontmost)" : ""}`;
      return entry.windows.length > 0
        ? `${heading}\n${entry.windows.map((title) => `  ${title}`).join("\n")}`
        : `${heading}\n  (no open windows)`;
    });
    return ok(lines.join("\n"));
  }
  // Without the accessibility reader there are still window titles to be
  // had from the window server, which is enough to name an app.
  const titles = await listWindowServerTitles();
  return ok(titles.length > 0 ? titles.join("\n") : "No open windows found.");
}

export async function activateApp(app: string): Promise<Outcome> {
  const activated = await activateFrontApp(app);
  return activated ? ok(`Activated "${app}".`) : fail(`No open window matching "${app}".`);
}
