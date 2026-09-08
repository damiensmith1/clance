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
