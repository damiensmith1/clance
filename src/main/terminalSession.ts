import { spawn } from "child_process";

export function spawnClaudeChatSession(sessionId: string): void {
  // Use AppleScript to open Terminal and run the claude command
  const script = `tell application "Terminal"
    do script "claude chat ${sessionId}"
    activate
  end tell`;

  spawn("osascript", ["-e", script], { detached: true });
}
