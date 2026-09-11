import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";
import { spawnBackgroundAgent, stopAgent, rmAgent, listAgents } from "./agentSessions";

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

// A spare's cwd is baked into its OS process at spawn time — immutable
// once running — so it has to be tracked per-entry, not just its id. A
// spare only ever helps a claim whose target directory matches exactly
// (see claimPoolSpare/refillPool below); one minted under a since-changed
// default directory (Settings, see config.ts's getDefaultDirectory) is
// stale and gets discarded rather than claimed. See
// docs/working-directory-design.md.
type PoolSpare = { id: string; cwd: string };

function readSpares(): PoolSpare[] {
  try {
    const raw = readFileSync(POOL_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PoolSpare =>
        entry && typeof entry.id === "string" && typeof entry.cwd === "string"
    );
  } catch {
    return [];
  }
}

function writeSpares(spares: PoolSpare[]): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(POOL_PATH, JSON.stringify(spares, null, 2), "utf8");
}

// Permanently discards a spare — a real running process, so this actually
// stops+removes it rather than just dropping it from tracking (which would
// leak an orphaned `claude` process every time a stale spare is found).
// Best-effort/fire-and-forget: a failure here just leaves an extra
// stopped-but-untracked session sitting around, not a crash.
function discardSpare(spare: PoolSpare): void {
  stopAgent(spare.id).catch(() => {});
  rmAgent(spare.id).catch(() => {});
}

// Claims (and removes) one spare, if one is available *for `targetCwd`*.
// Fully synchronous against the on-disk list up to (and including) the
// removal — no `await` between the read and the write — so two callers in
// the same process can't both claim the same spare; toggleClancePopup's
// own `opening` guard is what actually prevents concurrent hotkey presses
// from both reaching this at all. Callers should kick off refillPool()
// (fire-and-forget) right after a successful claim.
//
// The cwd check here is a safety net, not the primary mechanism — the
// primary one is refillPool() discarding a stale spare proactively the
// moment the default directory changes (see index.ts's
// settings:set-default-directory handler). This just covers the gap in
// between (e.g. the app crashed between the config write and the refill).
export function claimPoolSpare(targetCwd: string): string | null {
  const spares = readSpares();
  const spare = spares[0];
  if (!spare) return null;
  writeSpares(spares.slice(1));
  if (spare.cwd !== targetCwd) {
    discardSpare(spare);
    return null;
  }
  return spare.id;
}

// Hides pool spares from the Active-sessions list (see index.ts's
// "agents:list" handler) — a spare is a real, running `claude --bg` process
// from the CLI's point of view, but it isn't a conversation yet from the
// user's, so it shouldn't show up as one until claimed.
export function isPoolSpareId(id: string): boolean {
  return readSpares().some((spare) => spare.id === id);
}

let filling: Promise<void> | null = null;

// Makes the pool correct *for `cwd`* — not just "make sure there are
// POOL_SIZE of something". Any tracked spare minted under a different
// directory (the default directory changed since it was minted) is
// discarded here too, not just filtered out of the list, so a Settings
// change doesn't quietly leak an orphaned background process. Safe to call
// concurrently/repeatedly (app startup, after every claim, on a Settings
// change) — collapses into whichever fill is already in flight rather than
// racing two mints against each other. `mcpArgs`/`nameFn` are injected by
// the caller (popupWindow.ts) rather than imported here, so this module
// doesn't need to know anything about insert_text wiring or naming.
export async function refillPool(
  mcpArgs: string[],
  nameFn: () => string,
  cwd: string
): Promise<void> {
  if (filling) return filling;
  filling = (async () => {
    // Drop any entry that isn't actually a known agent anymore (e.g.
    // someone ran `claude rm <id>` by hand) before deciding what's left.
    const known = await listAgents({ all: true });
    const knownIds = new Set(known.map((agent) => agent.id));
    const current = readSpares().filter((spare) => knownIds.has(spare.id));
    const valid = current.filter((spare) => spare.cwd === cwd);
    const stale = current.filter((spare) => spare.cwd !== cwd);
    for (const spare of stale) discardSpare(spare);

    const spares = [...valid];
    while (spares.length < POOL_SIZE) {
      // nameFn is popupWindow.ts's popupSessionName, injected rather than
      // imported directly (this module is imported BY popupWindow.ts, so
      // importing back would be circular) — not something pool-specific:
      // the CLI's `-n` name sticks as the session's own display name
      // (prompt box, terminal title) even after it's claimed and attached,
      // so a pool-only name would leak into a real conversation's UI the
      // moment someone used it. Pool membership is tracked separately via
      // pool.json, not by name, so there's no need to distinguish here.
      const id = await spawnBackgroundAgent(nameFn(), mcpArgs, cwd);
      spares.push({ id, cwd });
    }
    writeSpares(spares);
  })();
  try {
    await filling;
  } finally {
    filling = null;
  }
}
