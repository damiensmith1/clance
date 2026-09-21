import { execFile } from "child_process";
import { promisify } from "util";
import { type Outcome, ok, fail } from "./types";

const run = promisify(execFile);

// Opening a website.
//
// "Open YouTube" is not a launch — YouTube is not an application — and the
// assistant used to try all seventy-nine installed apps, find nothing, and
// hand the whole thing to Claude. It is its own kind of command.
//
// Code owns every URL here and the decider only ever picks a *name*. That
// is the same select-don't-generate rule the rest of the assistant follows:
// a model that cannot type a URL cannot mistype one, and cannot be talked
// into a different one.

export const SITES: Record<string, string> = {
  youtube: "https://www.youtube.com/",
  github: "https://github.com/",
  gmail: "https://mail.google.com/",
  google: "https://www.google.com/",
  "google drive": "https://drive.google.com/",
  "google calendar": "https://calendar.google.com/",
  wikipedia: "https://en.wikipedia.org/",
  reddit: "https://www.reddit.com/",
  x: "https://x.com/",
  twitter: "https://x.com/",
  linkedin: "https://www.linkedin.com/",
  amazon: "https://www.amazon.com/",
  netflix: "https://www.netflix.com/",
  spotify: "https://open.spotify.com/",
  "hacker news": "https://news.ycombinator.com/",
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  stackoverflow: "https://stackoverflow.com/",
  maps: "https://maps.google.com/",
  whatsapp: "https://web.whatsapp.com/",
};

/**
 * A spoken domain, as a URL — or null when it isn't one.
 *
 * People say "github dot com", and whisper writes exactly that. Nothing
 * here invents a domain: it only rewrites what was actually said, and
 * anything that doesn't end in a plausible suffix is refused rather than
 * guessed at.
 */
const TLDS =
  "com|org|net|io|ai|dev|co|edu|gov|app|xyz|info|me|tv|uk|us|de|fr|nl|es|it|ca|au|jp|ch|at";

export function spokenUrl(phrase: string): string | null {
  const spoken = phrase
    .trim()
    .toLowerCase()
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+slash\s+/g, "/")
    .replace(/\s+/g, "");
  // A known suffix, not merely "some letters after a dot". Without this,
  // "search dot something" parses as a domain and the assistant navigates
  // to a word the user was using as a word.
  if (!new RegExp(`^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(${TLDS})(/[\\w\\-./]*)?$`).test(spoken)) return null;
  return `https://${spoken}`;
}

/**
 * Open a URL, in the browser the user is already looking at where that is
 * one, and in their default browser otherwise.
 *
 * `open` rather than driving the page: it needs no AppleScript permission,
 * works whether or not a browser is running, and opens a new tab rather
 * than navigating away from whatever the user had.
 */
export async function openSite(url: string, label: string, browserName?: string): Promise<Outcome> {
  try {
    await run("/usr/bin/open", browserName ? ["-a", browserName, url] : [url]);
    return ok(`Opened ${label}.`);
  } catch (error) {
    return fail(`Couldn't open ${label}: ${(error as Error).message}`);
  }
}
