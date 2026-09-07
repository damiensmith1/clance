import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
// prettier-ignore
import type { McpStdioServerConfig, McpSSEServerConfig, McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { SESSION_CWD } from "./paths";

// stdio/sse/http only — the SDK's fourth mcpServers variant ("sdk", an
// in-process server) carries a live, non-serializable object instance and
// has no place in a JSON config file.
export type StoredMcpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

// The inner shape (command/args/env for stdio; url/headers for sse/http)
// mirrors Claude Code's own .mcp.json server config directly, per the
// compatibility goal in the requirements doc — only the wrapping "enabled"
// flag is Clance's own addition, since the SDK's own mcpServers option has
// no concept of a disabled-but-configured entry.
export type McpServerEntry = {
  enabled: boolean;
  config: StoredMcpServerConfig;
};

export type McpConfig = {
  mcpServers: Record<string, McpServerEntry>;
};

const MCP_CONFIG_PATH = join(SESSION_CWD, "mcp.json");

const DEFAULT_CONFIG: McpConfig = { mcpServers: {} };

export function readMcpConfig(): McpConfig {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeMcpConfig(config: McpConfig): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

export type McpServerListItem = { name: string } & McpServerEntry;

export function listMcpServers(): McpServerListItem[] {
  const config = readMcpConfig();
  return Object.entries(config.mcpServers)
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function setMcpServerEnabled(name: string, enabled: boolean): McpServerListItem[] {
  const config = readMcpConfig();
  const entry = config.mcpServers[name];
  if (entry) {
    config.mcpServers[name] = { ...entry, enabled };
    writeMcpConfig(config);
  }
  return listMcpServers();
}

// What actually gets passed to query()'s mcpServers option — enabled
// entries only, with Clance's own "enabled" wrapper stripped back off.
export function getActiveMcpServers(): Record<string, StoredMcpServerConfig> {
  const config = readMcpConfig();
  const active: Record<string, StoredMcpServerConfig> = {};
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (entry.enabled) active[name] = entry.config;
  }
  return active;
}
