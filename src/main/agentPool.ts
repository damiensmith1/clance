import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";
import { spawnBackgroundAgent, listAgents } from "./agentSessions";

// A small pool of pre-warmed `claude --bg` spares, claimed by the popup
// widget's hotkey to skip the mint latency on "New Conversation". A claimed
// spare can't carry invisible context (see popupWindow.ts's
// toggleClancePopupInner) — it was minted before there was any context to
// bake in — so this is purely a speed trade, accepted in exchange for
// giving up --append-system-prompt on the hotkey's common path.
//
// 1 spare, not more: a single global hotkey from a single user can't fire
// two "New Conversation" opens simultaneously, so the only case a bigger
// pool would help — a second press landing before the first claim's refill
// completes — is rare enough not to design around. refillPool() re-tops the
// pool immediately after every claim so it self-heals between presses.
const POOL_SIZE = 1;

const POOL_PATH = join(SESSION_CWD, "pool.json");

function readSpareIds(): string[] {
  try {
    const raw = readFileSync(POOL_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeSpareIds(ids: string[]): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(POOL_PATH, JSON.stringify(ids, null, 2), "utf8");
}

// Claims (and removes) one spare's id, if any is available. Fully
// synchronous against the on-disk list — no `await` between the read and
// the write — so two callers in the same process can't both claim the same
// spare; toggleClancePopup's own `opening` guard is what actually prevents
// concurrent hotkey presses from both reaching this at all. Callers should
// kick off refillPool() (fire-and-forget) right after a successful claim.
export function claimPoolSpare(): string | null {
  const ids = readSpareIds();
  const id = ids.shift();
  if (!id) return null;
  writeSpareIds(ids);
  return id;
}

// Hides pool spares from the Active-sessions list (see index.ts's
// "agents:list" handler) — a spare is a real, running `claude --bg` process
// from the CLI's point of view, but it isn't a conversation yet from the
// user's, so it shouldn't show up as one until claimed.
export function isPoolSpareId(id: string): boolean {
  return readSpareIds().includes(id);
}

let filling: Promise<void> | null = null;

// Tops the pool back up to POOL_SIZE, minting new spares as needed. Safe to
// call concurrently/repeatedly (app startup, after every claim) — collapses
// into whichever fill is already in flight rather than racing two mints
// against each other. `mcpArgs` is injected by the caller (popupWindow.ts's
// insertTextMcpArgs) rather than imported here, so this module doesn't need
// to know anything about insert_text wiring.
export async function refillPool(mcpArgs: string[] = [], nameFn: () => string = () => "Clance popup"): Promise<void> {
  if (filling) return filling;
  filling = (async () => {
    // Drop any id that isn't actually a known agent anymore (e.g. someone
    // ran `claude rm <id>` by hand) before deciding how many more to mint.
    const known = await listAgents({ all: true });
    const knownIds = new Set(known.map((agent) => agent.id));
    const ids = readSpareIds().filter((id) => knownIds.has(id));
    while (ids.length < POOL_SIZE) {
      // nameFn is popupWindow.ts's popupSessionName, injected rather than
      // imported directly (this module is imported BY popupWindow.ts, so
      // importing back would be circular) — not something pool-specific:
      // the CLI's `-n` name sticks as the session's own display name
      // (prompt box, terminal title) even after it's claimed and attached,
      // so a pool-only name would leak into a real conversation's UI the
      // moment someone used it. Pool membership is tracked separately via
      // pool.json, not by name, so there's no need to distinguish here.
      const id = await spawnBackgroundAgent(nameFn(), mcpArgs);
      ids.push(id);
    }
    writeSpareIds(ids);
  })();
  try {
    await filling;
  } finally {
    filling = null;
  }
}
