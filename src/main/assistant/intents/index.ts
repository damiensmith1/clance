import { launchResolver, switchResolver, quitResolver } from "./apps";
import { menuResolver } from "./menu";
import { navigateResolver } from "./navigate";
import { windowResolver } from "./window";
import { targetResolver } from "./target";
import { siteResolver } from "./site";
import { textResolver } from "./text";
import { searchResolver, findResolver, typeResolver } from "./say";
import { clanceResolver } from "./clance";
import { claudeResolver } from "./claude";
import { forgetWindowTree } from "../../capabilities";
import type { Candidate, Context, IntentId, Resolution, Resolver } from "../types";

// Adding a capability is adding a resolver here. The session, the decider
// and the actuator don't change — which is what keeps the "(new)" list in
// docs/assistant.md a matter of work rather than redesign.
export const RESOLVERS: Resolver[] = [
  launchResolver,
  switchResolver,
  quitResolver,
  menuResolver,
  navigateResolver,
  windowResolver,
  targetResolver,
  siteResolver,
  searchResolver,
  findResolver,
  typeResolver,
  textResolver,
  clanceResolver,
  claudeResolver,
];

const BY_ID = new Map<IntentId, Resolver>(RESOLVERS.map((resolver) => [resolver.id, resolver]));

export function resolverFor(intent: IntentId): Resolver | undefined {
  return BY_ID.get(intent);
}

/**
 * Every intent's candidates, gathered in parallel.
 *
 * All of them, every command — because the decider is asked the intent
 * question and the target question in the same call, and a candidate list
 * that arrived after the question was sent would be no use. A resolver that
 * throws is dropped rather than taking the utterance down with it: a
 * misbehaving app's accessibility tree shouldn't cost the user "open Mail".
 */
export async function gatherCandidates(ctx: Context): Promise<Record<string, Candidate[]>> {
  // One window tree for this whole gather, and a fresh one for the next.
  // Every resolver below that needs it shares this walk; between steps of a
  // loop the screen has changed, so the next gather reads it again.
  forgetWindowTree();
  const entries = await Promise.all(
    RESOLVERS.map(async (resolver) => {
      try {
        return [resolver.id, await resolver.candidates(ctx)] as const;
      } catch (error) {
        console.warn(`[assistant] ${resolver.id} couldn't list candidates:`, error);
        return [resolver.id, [] as Candidate[]] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

export async function resolve(
  intent: IntentId,
  candidate: Candidate,
  ctx: Context
): Promise<Resolution | null> {
  const resolver = BY_ID.get(intent);
  if (!resolver) return null;
  try {
    return await resolver.resolve(candidate, ctx);
  } catch (error) {
    console.warn(`[assistant] ${intent} couldn't resolve "${candidate.label}":`, error);
    return null;
  }
}

export { handOff } from "./claude";
