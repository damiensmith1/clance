import * as ax from "../ax";
import { resolveReadTarget, invalidateMenuCache } from "../capabilities";
import type { Context } from "./types";

// Where the user is. Resolved once per command rather than per resolver,
// because every resolver needs the same answer and asking macOS for the
// frontmost app eight times per utterance is eight times the latency.
//
// "The app in front" is the right question here, unlike for the MCP tools:
// the assistant's HUD is non-focusable by design, so pressing ⌥A never
// changes which app is frontmost (docs/assistant.md, "Invocation").

let lastIdentity = "";

export async function currentContext(utterance = ""): Promise<Context | { error: string }> {
  const target = await resolveReadTarget();
  if ("error" in target) return { error: target.error };

  const front = await ax.frontmostApp();
  const window = await ax.focusedWindow(target.pid);
  const context: Context = {
    app: {
      pid: target.pid,
      name: front?.name ?? target.label,
      bundleId: front?.bundleId ?? "",
      windowTitle: window?.title ?? window?.windowTitle ?? "",
    },
    target,
    utterance,
  };

  // A menu is a function of the app's state, so a stale one offers
  // commands that fail. Cheaper to notice the move here — where the app
  // and window have just been read anyway — than to watch for focus
  // notifications.
  const identity = `${context.app.bundleId}\u0000${context.app.windowTitle}`;
  if (identity !== lastIdentity) {
    invalidateMenuCache();
    lastIdentity = identity;
  }
  return context;
}
