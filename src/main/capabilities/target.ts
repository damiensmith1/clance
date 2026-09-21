import * as ax from "../ax";
import { capturedAppInfo } from "../frontApp";

// Which app a call is about. Almost always "the one the user was in when
// they asked", which is *not* the frontmost app: Clance is frontmost while
// they type to Claude, and frontmost while the ⌥A HUD is up. So an explicit
// hint wins, then the app recorded when the widget took focus, then
// whatever is in front.
export type ReadTarget = { pid?: number; label: string };

export async function resolveReadTarget(appHint?: string): Promise<ReadTarget | { error: string }> {
  if (!ax.isAvailable()) {
    return {
      error:
        "Clance's accessibility reader isn't available in this build, so the screen can't be read as text. " +
        "look_at_screen still works.",
    };
  }
  if (!ax.isTrusted()) {
    return {
      error:
        "Accessibility isn't enabled for Clance, so other apps' text can't be read. " +
        "The user can turn it on in System Settings → Privacy & Security → Accessibility.",
    };
  }
  if (appHint) {
    const matches = await ax.appByName(appHint);
    if (matches.length === 0) return { error: `No running app matches "${appHint}".` };
    const match = matches[0];
    return { pid: match.pid, label: match.name ?? appHint };
  }
  const front = await ax.frontmostApp();
  if (front && !front.ours) return { pid: front.pid, label: front.name ?? "the frontmost app" };
  const captured = capturedAppInfo();
  if (captured) return { pid: captured.pid, label: captured.name ?? "the app you came from" };
  return {
    error:
      "Clance is the frontmost app and there's no record of which app the user came from, " +
      "so there's nothing to read. Pass `app` to name one.",
  };
}

// Said whenever an app offered its window frame and nothing inside it.
// Chromium apps — Chrome, and equally Electron ones like Slack, VS Code
// or Obsidian — build no accessibility tree for their content until they
// decide something is listening, and until then a read of them is empty
// through no fault of the window's. Clance asks them to (see
// EnableWebAccessibility in native/ax/ax.mm) but can't make them, so the
// honest answer names the cause and points at the tool that does work,
// rather than reporting an empty window as fact.
export function unpublishedMessage(name: string): string {
  return (
    `${name} isn't publishing its window contents to macOS's accessibility API, so there's ` +
    "nothing to read as text — only its window frame came back. Chromium-based apps often do " +
    "this until something has been reading them for a while; trying once more sometimes works. " +
    "look_at_screen can see the window regardless."
  );
}
