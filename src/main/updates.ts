import { app, net, shell } from "electron";

// Clance ships as a Homebrew cask built from GitHub Releases, so the newest
// published release is the newest version a user can install. Checking only
// tells the user; installing stays with Homebrew (`brew upgrade`), because
// an app that replaces itself leaves Homebrew's install record out of sync
// and the next `brew install`/`upgrade` then fails.
const REPO = "damiensmith1/clance";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE_PREFIX = `https://github.com/${REPO}/releases/`;
const CHECK_TIMEOUT_MS = 10_000;

export const UPGRADE_COMMAND = "brew upgrade --cask clance";

export type UpdateCheck =
  | { status: "up-to-date"; current: string }
  | { status: "available"; current: string; latest: string; releaseUrl: string; command: string }
  | { status: "error"; current: string; message: string };

// "v0.1.10" -> [0, 1, 10]. Anything after a "-" (pre-release) is ignored;
// /releases/latest never returns drafts or pre-releases anyway.
function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  const current = app.getVersion();
  try {
    const response = await net.fetch(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 403/429 is GitHub's unauthenticated rate limit (60 requests an hour).
      const message =
        response.status === 403 || response.status === 429
          ? "GitHub is rate-limiting update checks. Try again in a little while."
          : "Couldn't reach GitHub to check for updates.";
      return { status: "error", current, message };
    }
    const release = (await response.json()) as { tag_name?: string; html_url?: string };
    const latest = release.tag_name?.replace(/^v/, "");
    if (!latest) {
      return { status: "error", current, message: "Couldn't read the latest release." };
    }
    if (!isNewer(latest, current)) return { status: "up-to-date", current };
    const releaseUrl =
      release.html_url && release.html_url.startsWith(RELEASES_PAGE_PREFIX)
        ? release.html_url
        : `${RELEASES_PAGE_PREFIX}tag/v${latest}`;
    return { status: "available", current, latest, releaseUrl, command: UPGRADE_COMMAND };
  } catch {
    return { status: "error", current, message: "Couldn't reach GitHub to check for updates." };
  }
}

// Only ever opens this repo's releases pages, whatever the renderer passes.
export function openReleasePage(url: string): Promise<void> {
  const target = url.startsWith(RELEASES_PAGE_PREFIX) ? url : RELEASES_PAGE_PREFIX;
  return shell.openExternal(target);
}
