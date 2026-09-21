import { TypeSafeClient } from "@typesafe-ai/sdk";
import { readConfig } from "../../config";
import type { Decider } from "../types";
import { KeywordDecider } from "./keyword";
import { log } from "../log";
import { JevDecider } from "./jev";

export { KeywordDecider } from "./keyword";
export { JevDecider } from "./jev";

// Which decider the assistant uses, decided once and re-decided when
// Settings change.
//
// Local matching is the floor, not an error state: it is what runs when the
// user has switched the decision service off, when no key is configured,
// and when Jev can't be reached. The assistant is never disabled by the
// network.
let current: Decider | null = null;

export function currentDecider(): Decider {
  if (current) return current;
  const local = new KeywordDecider();
  const { decider } = readConfig().assistant;
  if (decider === "local") {
    current = local;
    return current;
  }
  try {
    // The key comes from TYPESAFE_API_KEY, which is the variable the SDK
    // reads anyway — see .env.example. Nothing about the key is stored in
    // Clance's own config, so it never ends up in a settings backup.
    current = new JevDecider(new TypeSafeClient(), local);
    log("deciding with Jev");
  } catch (error) {
    // No key configured is the ordinary case on a fresh install, not a
    // failure worth shouting about.
    log(`no decision service configured, using local matching: ${(error as Error).message}`);
    current = local;
  }
  return current;
}

export function resetDecider(): void {
  current = null;
}

/**
 * What is *actually* deciding, as opposed to what Settings asks for.
 *
 * These come apart the moment the toggle is on and no key is configured,
 * which is every fresh install: the setting says Jev, the assistant runs on
 * local matching, and nothing on screen admits it. Settings shows this so
 * the answer to "am I using Jev?" isn't a guess.
 */
export function deciderName(): string {
  return currentDecider().name;
}
