import { execFile } from "child_process";
import { promisify } from "util";
import { getLoginShellPath } from "./ptyManager";
import { SESSION_CWD } from "./paths";
import { cwdForSessionId } from "./chatHistory";

const execFileAsync = promisify(execFile);

// Every real `claude` process now originates here (`--bg`/`--bg --resume`),
// not in ptyManager's pty.spawn — so this needs the same three things that
// used to only matter for the pty spawn:
// - resolved login-shell PATH: a GUI-launched Electron app inherits
//   launchd's minimal PATH, which doesn't include wherever `claude` itself
//   lives (confirmed live: `claude` isn't found on a bare `/usr/bin:/bin`
//   PATH) — execFile doesn't do a shell PATH lookup, so without this every
//   mint call would fail outright in the packaged app.
// - cwd: defaults to SESSION_CWD, but every real caller now passes the
//   directory that actually matters for that mint — Clance's configured
//   default for a brand-new session (see config.ts's getDefaultDirectory),
//   or the target session's own recorded cwd for a resume (see
//   resolveOpenArgs below) — rather than unconditionally forcing
//   SESSION_CWD the way this used to. See docs/working-directory-design.md.
// - CLAUDE_CODE_AUTO_CONNECT_IDE: "false", same reasoning as ptyManager's
//   pty spawn — a Clance session has nothing to do with whatever file a
//   running VS Code/JetBrains instance has open.
function claudeExecOptions(cwd: string = SESSION_CWD): { cwd: string; env: NodeJS.ProcessEnv } {
  return {
    cwd,
    env: { ...process.env, PATH: getLoginShellPath(), CLAUDE_CODE_AUTO_CONNECT_IDE: "false" },
  };
}

// Applied at mint time now, not per-`attach` — a background agent is a
// real long-running `claude` process spawned once via `--bg`, so this is
// the only point that actually reaches it. (`attach <id>` on the disposable
// terminal-viewport pty accepts no other flags — confirmed live it just
// prints "extra arguments ignored" for anything appended there — so
// appending settings at that end, as an earlier version of this file did,
// silently never took effect.)
function cliSettingsArgs(): string[] {
  // Clance's embedded terminal always renders on a light background (see
  // popup.js / TerminalSection.js xterm themes). Left unset, the CLI
  // defaults to dark-theme-tuned colors and emits several UI colors (diff
  // add/remove, etc.) as hardcoded truecolor RGB rather than the basic ANSI
  // palette — those can't be fixed by remapping xterm's theme, so the CLI
  // itself has to be told the background is light.
  const cliSettings: Record<string, unknown> = { theme: "light" };
  return ["--settings", JSON.stringify(cliSettings)];
}

export type AgentSession = {
  id: string;
  sessionId: string;
  kind: "background" | "interactive";
  name?: string;
  status?: string;
  state?: string;
  // Present only for a live process — a stopped-but-known background
  // session (from the `--all` listing) has no pid.
  pid?: number;
  // The directory this specific background-agent process was actually
  // minted with — baked in at its own spawn time, immutable. See
  // resolveOpenArgs below: a stopped copy minted before cwd-awareness
  // existed (or at a since-changed default) can be sitting on the wrong
  // one forever, and attaching to it can't fix that.
  cwd?: string;
};

// Unscoped by cwd on purpose (no `--cwd`) — a live session is a live
// session, whether Clance or the user elsewhere (a bare terminal, another
// machine) started it.
export async function listAgents(opts: { all?: boolean } = {}): Promise<AgentSession[]> {
  try {
    const args = opts.all ? ["agents", "--json", "--all"] : ["agents", "--json"];
    const { stdout } = await execFileAsync("claude", args, claudeExecOptions());
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Every ANSI-colored token in `claude --bg`'s stdout is wrapped the same
// way (`\x1b[36m<id>\x1b[39m`) whether or not the output is a real TTY —
// strip escape codes before parsing rather than relying on a no-color mode.
// eslint-disable-next-line no-control-regex
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// Spawns a brand-new background agent (`claude --bg -n <name> [claudeArgs]`)
// and returns its short id, parsed off the first line of stdout
// ("backgrounded · <id> · <name>"). Never through a shell string — args is
// a real argv array, same reasoning as ptyManager's pty.spawn.
export async function spawnBackgroundAgent(
  name: string,
  claudeArgs: string[] = [],
  cwd: string = SESSION_CWD
): Promise<string> {
  const { stdout } = await execFileAsync(
    "claude",
    ["--bg", "-n", name, ...claudeArgs, ...cliSettingsArgs()],
    claudeExecOptions(cwd)
  );
  const match = stripAnsi(stdout).match(/backgrounded\s*·\s*(\S+)\s*·/);
  if (!match) throw new Error(`Couldn't parse a session id from "claude --bg" output: ${stdout}`);
  return match[1];
}

// Continues an existing session as a background agent
// (`claude --bg --resume <sessionId>`) and returns the (possibly new) short
// id — see --bg's own help text: this starts a copy under a new id if the
// session is already running live elsewhere, rather than erroring.
async function spawnBackgroundResume(sessionId: string, name: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "claude",
    ["--bg", "--resume", sessionId, "-n", name, ...cliSettingsArgs()],
    claudeExecOptions(cwd)
  );
  const match = stripAnsi(stdout).match(/backgrounded\s*·\s*(\S+)\s*·/);
  if (!match) throw new Error(`Couldn't parse a session id from "claude --bg --resume" output: ${stdout}`);
  return match[1];
}

export async function stopAgent(id: string): Promise<void> {
  await execFileAsync("claude", ["stop", id], claudeExecOptions());
}

// Permanently removes a session — unlike stopAgent, there's no `claude
// attach`/`--resume` coming back from this. Used only for popup sessions
// confirmed to have zero real user turns (see popupWindow.ts's
// cleanupIfAbandoned) — a real conversation is never a candidate for this.
export async function rmAgent(id: string): Promise<void> {
  await execFileAsync("claude", ["rm", id], claudeExecOptions());
}

// Guards resolveOpenArgs against a double-click (or two windows/panes)
// racing to open the same session before the first mint has registered —
// `claude --bg --resume` isn't idempotent against itself: two concurrent
// calls for the same sessionId can each independently decide "not live
// yet" and each spawn their own copy under a brand-new sessionId, exactly
// the "clicking once opened two" bug this closes. Concurrent callers for
// the same sessionId now share one in-flight resolution instead.
const inFlightOpens = new Map<string, Promise<string[]>>();

// Every Clance-opened terminal is now purely a `claude attach <id>` viewport
// onto a background agent (see docs/background-agent-architecture.md) —
// this is the single place that decides which agent id a session id maps
// to, minting one if none exists yet. Collapses what the design doc
// describes as two Closed-section sub-cases into one lookup: `--all`
// already includes stopped-but-known agents (no `pid`), and `attach`
// transparently restarts those, so there's nothing left to special-case
// beyond "is there a known id at all."
export async function resolveOpenArgs(sessionId: string, name: string): Promise<string[]> {
  const existing = inFlightOpens.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    const known = await listAgents({ all: true });
    const match = known.find((s) => s.sessionId === sessionId && s.kind === "background");
    // Reopen it where it actually lives, not wherever Clance's own default
    // happens to be — read straight off its own transcript (see
    // cwdForSessionId), falling back to SESSION_CWD only for the edge case
    // of a transcript with no recorded cwd at all (very old session
    // format).
    const cwd = (await cwdForSessionId(sessionId)) ?? SESSION_CWD;
    if (match) {
      // A known match's own cwd is baked in at whenever *it* was minted —
      // if that was before cwd-awareness existed (or under a
      // since-changed default), it can be permanently stuck on the wrong
      // directory, and attaching to it can't fix that. A *live* one is a
      // real running process someone might be mid-conversation with —
      // can't remint out from under that, so attach to it as-is regardless
      // of cwd. A *stopped* one with the wrong cwd is safe to just
      // re-resume properly instead: `--bg --resume` on a stopped session
      // continues it under the same id (see spawnBackgroundResume), so
      // this corrects it going forward without deleting anything.
      if (match.cwd === cwd || match.pid) return ["attach", match.id];
    }
    const id = await spawnBackgroundResume(sessionId, name, cwd);
    return ["attach", id];
  })();

  inFlightOpens.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    inFlightOpens.delete(sessionId);
  }
}

// The inverse of resolveOpenArgs — recovers the underlying session id from
// a terminal's launch args, so a session moved into the main window (via
// the popup widget's "Open in App" button) can be labeled with its real
// title instead of a generic placeholder. `attach <shortId>` only carries
// the short agent id, not the session id, so that direction needs the
// same `claude agents --json --all` round trip in reverse.
export async function resolveSessionId(args: string[]): Promise<string | null> {
  if (args[0] === "--resume") return args[1] ?? null;
  if (args[0] === "attach") {
    const known = await listAgents({ all: true });
    return known.find((s) => s.id === args[1])?.sessionId ?? null;
  }
  return null;
}
