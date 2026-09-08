import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

// Mirrors Claude Code CLI's own .mcp.json server config shape directly, per
// the compatibility goal in the requirements doc.
export type McpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
export type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};
export type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};
export type StoredMcpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

// The wrapping "enabled" flag is Clance's own addition — the CLI's own
// .mcp.json has no concept of a disabled-but-configured entry.
export type McpServerEntry = {
  enabled: boolean;
  config: StoredMcpServerConfig;
};

export type McpConfig = {
  mcpServers: Record<string, McpServerEntry>;
};

const MCP_CONFIG_PATH = join(SESSION_CWD, "mcp.json");

const DEFAULT_CONFIG: McpConfig = { mcpServers: {} };

// mcp.json entries end up spawning real child processes (stdio servers) or
// making real network requests (http/sse) once a launched CLI session reads
// them, so a malformed or corrupted file must not silently pass through to
// that sink — each entry's shape is checked before it's treated as configured
// at all.
function isStoredMcpServerConfig(value: unknown): value is StoredMcpServerConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;

  if (config.type === "http" || config.type === "sse") {
    return typeof config.url === "string" && config.url.length > 0;
  }
  if (config.type === undefined || config.type === "stdio") {
    return (
      typeof config.command === "string" &&
      config.command.length > 0 &&
      (config.args === undefined ||
        (Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string")))
    );
  }
  return false;
}

function isMcpServerEntry(value: unknown): value is McpServerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.enabled === "boolean" && isStoredMcpServerConfig(entry.config);
}

function sanitizeMcpConfig(parsed: unknown): McpConfig {
  if (!parsed || typeof parsed !== "object") return DEFAULT_CONFIG;
  const rawServers = (parsed as Record<string, unknown>).mcpServers;
  if (!rawServers || typeof rawServers !== "object") return DEFAULT_CONFIG;

  const mcpServers: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(rawServers)) {
    if (isMcpServerEntry(entry)) mcpServers[name] = entry;
  }
  return { mcpServers };
}

export function readMcpConfig(): McpConfig {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf8");
    return sanitizeMcpConfig(JSON.parse(raw));
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

  // name/enabled cross an IPC boundary from the renderer — only a known,
  // already-configured server name and a real boolean are accepted.
  if (typeof name === "string" && typeof enabled === "boolean" && entry) {
    config.mcpServers[name] = { ...entry, enabled };
    writeMcpConfig(config);
  }
  return listMcpServers();
}

// Enabled entries only, with Clance's own "enabled" wrapper stripped back
// off — see requirements.md's "Config surface" gap: nothing currently wires
// this into a launched session's --mcp-config yet.
export function getActiveMcpServers(): Record<string, StoredMcpServerConfig> {
  const config = readMcpConfig();
  const active: Record<string, StoredMcpServerConfig> = {};
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (entry.enabled) active[name] = entry.config;
  }
  return active;
}
