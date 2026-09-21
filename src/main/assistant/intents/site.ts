import { SITES, spokenUrl, openSite, isBrowser } from "../../capabilities";
import { candidateSpans } from "../spans";
import type { Candidate, Context, Resolver } from "../types";

// "Open YouTube", "go to github dot com".
//
// Two kinds of candidate, both of which the decider only ever *picks*: a
// known site by name, or a domain the user actually spoke. Neither is a
// URL the model composed.

const KNOWN = Object.keys(SITES);

export const siteResolver: Resolver = {
  id: "site",
  // Opens a tab. Nothing is lost and the user watches it happen.
  risk: "safe",
  async candidates(ctx: Context): Promise<Candidate[]> {
    const candidates: Candidate[] = KNOWN.map((name) => ({
      id: `site:${name}`,
      label: name,
      detail: SITES[name],
    }));

    // A domain has to have been said out loud to be offered. Spans that
    // don't look like one are simply absent, so there is nothing for the
    // decider to pick that would navigate somewhere nobody named.
    for (const span of candidateSpans(ctx.utterance)) {
      const url = spokenUrl(span);
      if (url && !KNOWN.includes(span.toLowerCase())) {
        candidates.push({ id: `url:${url}`, label: span, detail: url });
      }
    }
    return candidates;
  },
  async resolve(candidate, ctx) {
    const browser = isBrowser(ctx.app.bundleId) ? ctx.app.name : undefined;
    if (candidate.id.startsWith("site:")) {
      const name = candidate.id.slice("site:".length);
      const url = SITES[name];
      if (!url) return null;
      return {
        intent: "site",
        label: `Open ${name}`,
        risk: "safe",
        perform: () => openSite(url, name, browser),
      };
    }
    const url = candidate.id.slice("url:".length);
    if (!url) return null;
    return {
      intent: "site",
      label: `Open ${candidate.label}`,
      risk: "safe",
      perform: () => openSite(url, candidate.label, browser),
    };
  },
};
