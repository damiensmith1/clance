import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { shell } from "electron";
import { getLoginShellPath } from "./ptyManager";

// An app opened from Finder, the Dock or Launchpad inherits launchd's
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the user's shell PATH.
// A bare execFile("claude") therefore fails with ENOENT for almost every
// real install — the native installer puts claude in ~/.local/bin — and the
// setup wizard told users with Claude installed that it wasn't, with an
// "I've installed it" button that could never succeed. It only worked when
// Clance was started from a terminal. Sessions never had this problem
// because agentSessions.ts spawns claude with the login-shell PATH; these
// checks now do the same.
const COMMON_CLAUDE_DIRS = [
  join(homedir(), ".local", "bin"), // native installer
  join(homedir(), ".claude", "local"), // older local installs
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

let workingEnv: NodeJS.ProcessEnv | undefined;

const LOGIN_PATH_WAIT_MS = 8000;

function envWithPath(...parts: (string | undefined)[]): NodeJS.ProcessEnv {
  const path = parts
    .flatMap((part) => (part ? part.split(":") : []))
    .filter((dir, index, all) => dir && all.indexOf(dir) === index)
    .join(":");
  return { ...process.env, PATH: path };
}

// Fast path first: if claude sits in a standard install location, use that
// without waiting on the login-shell PATH, which runs an interactive shell
// and can take many seconds on a first launch before it's cached.
function fastClaudeEnv(): NodeJS.ProcessEnv {
  return envWithPath(COMMON_CLAUDE_DIRS.join(":"), process.env.PATH);
}

async function loginClaudeEnv(): Promise<NodeJS.ProcessEnv> {
  // Catches nvm, npm-global, bun and other installs outside the standard
  // directories — and supplies `node` for an npm-installed claude, which
  // is a `#!/usr/bin/env node` script and fails without it.
  return envWithPath(await getLoginShellPath(), COMMON_CLAUDE_DIRS.join(":"), process.env.PATH);
}

// The environment for launching `claude` itself, preferring whichever one
// last worked for a status check.
async function claudeEnv(): Promise<NodeJS.ProcessEnv> {
  if (workingEnv) return workingEnv;
  const fast = fastClaudeEnv();
  if (COMMON_CLAUDE_DIRS.some((dir) => existsSync(join(dir, "claude")))) return fast;
  return loginClaudeEnv();
}

export type ClaudeAuthStatus =
  | { installed: false }
  | { installed: true; loggedIn: false }
  | {
      installed: true;
      loggedIn: true;
      email?: string;
      organization?: string;
      subscriptionType?: string;
    };

function parseAuthStatusJson(parsed: {
  loggedIn?: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}): ClaudeAuthStatus {
  if (!parsed.loggedIn) {
    return { installed: true, loggedIn: false };
  }
  return {
    installed: true,
    loggedIn: true,
    email: parsed.email,
    organization: parsed.orgName,
    subscriptionType: parsed.subscriptionType,
  };
}

type StatusAttempt =
  | { kind: "status"; status: ClaudeAuthStatus }
  | { kind: "not-found" }
  | { kind: "unparseable" };

function runAuthStatus(env: NodeJS.ProcessEnv): Promise<StatusAttempt> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      { timeout: 10000, env },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ kind: "not-found" });
          return;
        }
        try {
          resolve({ kind: "status", status: parseAuthStatusJson(JSON.parse(stdout)) });
        } catch {
          // Found but produced no JSON — typically an npm-installed claude
          // that couldn't find `node` on this PATH, rather than a real
          // logged-out state.
          resolve({ kind: "unparseable" });
        }
      }
    );
  });
}

export async function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  const fast = fastClaudeEnv();
  const first = await runAuthStatus(fast);
  if (first.kind === "status") {
    workingEnv = fast;
    return first.status;
  }

  // Not found, or found but broken on the minimal PATH: retry with the
  // full login-shell PATH before concluding anything.
  //
  // Bounded, because app startup awaits this check before opening any
  // window, and on a very first launch the login-shell PATH comes from an
  // interactive shell that can take tens of seconds. Past the bound this
  // returns the fast-path answer for now; resolution keeps running and is
  // cached to disk, so the wizard's own re-check picks up the real answer.
  const login = await Promise.race([
    loginClaudeEnv(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LOGIN_PATH_WAIT_MS)),
  ]);
  if (!login) {
    return first.kind === "not-found" ? { installed: false } : { installed: true, loggedIn: false };
  }
  const second = await runAuthStatus(login);
  if (second.kind === "status") {
    workingEnv = login;
    return second.status;
  }
  if (second.kind === "not-found" && first.kind === "not-found") {
    return { installed: false };
  }
  return { installed: true, loggedIn: false };
}

const CONNECT_TIMEOUT_MS = 120000; // interactive browser login; generous but bounded

export async function connectClaude(): Promise<ClaudeAuthStatus> {
  const env = await claudeEnv();
  return new Promise((resolve) => {
    const child = spawn("claude", ["auth", "login"], { stdio: "ignore", env });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ installed: true, loggedIn: false });
    }, CONNECT_TIMEOUT_MS);

    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      checkClaudeAuth().then(resolve);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ installed: false });
    });
  });
}

export async function disconnectClaude(): Promise<void> {
  const env = await claudeEnv();
  return new Promise((resolve, reject) => {
    execFile("claude", ["auth", "logout"], { timeout: 5000, env }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function openInstallDocs(): Promise<void> {
  return shell.openExternal("https://code.claude.com/docs/en/setup");
}
