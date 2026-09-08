import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type ActiveAgentSession = {
  id: string;
  sessionId: string;
  kind: "background" | "interactive";
};

async function listActiveSessions(): Promise<ActiveAgentSession[]> {
  try {
    const { stdout } = await execFileAsync("claude", ["agents", "--json"]);
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// A session already running as a background agent can't be opened with
// `--resume` (the CLI refuses — it's already live elsewhere); `attach
// <shortId>` opens that same running session in this terminal instead.
export async function resolveOpenArgs(sessionId: string): Promise<string[]> {
  const active = await listActiveSessions();
  const running = active.find((s) => s.sessionId === sessionId && s.kind === "background");
  if (running) return ["attach", running.id];
  return ["--resume", sessionId];
}

// The inverse of resolveOpenArgs — recovers the underlying session id from
// a terminal's launch args, so a session moved into the main window (via
// the popup widget's "Open in App" button) can be labeled with its real
// title instead of a generic placeholder. `attach <shortId>` only carries
// the short agent id, not the session id, so that direction needs the
// same `claude agents --json` round trip in reverse. A freshly
// hotkey-launched widget session (`--append-system-prompt ...`, no id at
// all yet) has nothing to recover here — returns null.
export async function resolveSessionId(args: string[]): Promise<string | null> {
  if (args[0] === "--resume") return args[1] ?? null;
  if (args[0] === "attach") {
    const active = await listActiveSessions();
    return active.find((s) => s.id === args[1])?.sessionId ?? null;
  }
  return null;
}
