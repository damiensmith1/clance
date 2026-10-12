// The hooks every Clance session gets (cliSettingsArgs, agentSessions.ts),
// so a lode tab can follow it (lodeFollow.ts): after an edit, when a prompt
// is sent and when a turn ends, the session posts the hook's input to
// Clance's local tools server (/hook). Kept apart from the server so the
// session code can read it without importing the server.
//
// The command is curl, with the server's current token read from its
// headers file when it runs: the CLI keeps a background session's args
// across Clance launches, so nothing in them may change between launches
// (the port and the file are fixed per install). If Clance isn't running,
// curl fails at once and the session carries on.

let endpoint: { url: string; headersPath: string } | null = null;

export function setFollowHookEndpoint(mcpUrl: string, headersPath: string): void {
  endpoint = { url: mcpUrl.replace(/\/mcp$/, "/hook"), headersPath };
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The `hooks` for a session's --settings, or null before the server runs. */
export function followHookSettings(): Record<string, unknown> | null {
  if (!endpoint) return null;
  const auth = `"$(sed -E 's/.*"Authorization": *"([^"]*)".*/Authorization: \\1/' ${quote(endpoint.headersPath)})"`;
  const command = `curl -s -m 3 -H ${auth} -H 'Content-Type: application/json' --data-binary @- ${quote(endpoint.url)} || true`;
  const hook = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
  return {
    PostToolUse: [{ matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash", hooks: hook[0].hooks }],
    UserPromptSubmit: hook,
    Stop: hook,
  };
}
