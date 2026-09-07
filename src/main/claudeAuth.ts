import { execFile, spawn } from "child_process";
import { shell } from "electron";

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

export function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "status", "--json"], (error, stdout) => {
      if (error && error.code === "ENOENT") {
        resolve({ installed: false });
        return;
      }
      try {
        resolve(parseAuthStatusJson(JSON.parse(stdout)));
      } catch {
        resolve({ installed: true, loggedIn: false });
      }
    });
  });
}

export function connectClaude(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["auth", "login"], { stdio: "ignore" });
    child.on("exit", () => {
      checkClaudeAuth().then(resolve);
    });
    child.on("error", () => {
      resolve({ installed: false });
    });
  });
}

export function openInstallDocs(): Promise<void> {
  return shell.openExternal("https://code.claude.com/docs/en/setup");
}
