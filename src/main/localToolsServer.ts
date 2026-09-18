import { app } from "electron";
import { checkPermissions } from "./permissions";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  typeIntoCapturedWindow,
  listOpenWindows,
  clearFocusedField,
  replaceFocusedField,
  activateApp,
  clickAtNormalized,
  capturedAppInfo,
} from "./frontApp";
import { captureActiveDisplay } from "./screenCapture";
import * as ax from "./ax";
import { readConfig, writeConfig } from "./config";
import { SESSION_CWD } from "./paths";

// The single source of truth for what local tools exist, both for
// popupWindow.ts's --allowedTools/--disallowedTools wiring (which needs
// `tier` to know which are pre-authorized) and for the Settings UI's
// per-tool toggle list (Settings → clance tools, SettingsSection.js) — kept next
// to createMcpServer() below so a new server.registerTool() call is never
// added without a matching entry here. `tier` mirrors the split
// docs/design.md's "Local tools server" documents: "auto" tools are
// pre-authorized (no CLI prompt) when enabled; "approval" tools still get
// the CLI's native "Allow / Deny / Always allow" prompt even when enabled
// — a toggle here only ever controls whether a tool is offered *at all*,
// never which tier it's in.
export type LocalToolTier = "auto" | "approval";
export type LocalToolInfo = { name: string; tier: LocalToolTier; description: string };
export const LOCAL_TOOLS: LocalToolInfo[] = [
  { name: "list_open_windows", tier: "auto", description: "List the user's open app windows." },
  { name: "look_at_screen", tier: "auto", description: "Take a fresh screenshot of the user's screen." },
  { name: "read_selection", tier: "auto", description: "Read whatever text is currently highlighted." },
  { name: "read_focused_field", tier: "auto", description: "Read the text of the field the user is typing in." },
  { name: "read_window_text", tier: "auto", description: "Read a window's text without a screenshot." },
  { name: "click_at", tier: "auto", description: "Click a position on the user's screen." },
  { name: "insert_text", tier: "approval", description: "Type text into another app." },
  { name: "activate_app", tier: "approval", description: "Bring a different app to the front." },
  {
    name: "clear_focused_field",
    tier: "approval",
    description: "Clear the entire contents of the focused field.",
  },
  {
    name: "replace_focused_field",
    tier: "approval",
    description: "Replace the entire contents of the focused field.",
  },
];

export type LocalToolStatus = LocalToolInfo & { enabled: boolean };

export function listLocalTools(): LocalToolStatus[] {
  const { enabledLocalTools } = readConfig();
  return LOCAL_TOOLS.map((tool) => ({
    ...tool,
    enabled: enabledLocalTools === "all" || enabledLocalTools.includes(tool.name),
  }));
}

// Turning one tool off for the first time converts the "all" default into
// an explicit list, so a tool added here later stays on by default
// afterward — a later "on" only ever adds back to that explicit list, it
// never collapses back to "all" implicitly.
export function setLocalToolEnabled(name: string, enabled: boolean): LocalToolStatus[] {
  const allNames = LOCAL_TOOLS.map((tool) => tool.name);
  // name/enabled cross an IPC boundary from the renderer — only ever a
  // known tool name is accepted, so a compromised or buggy renderer can't
  // write arbitrary strings into config.json.
  if (typeof name !== "string" || typeof enabled !== "boolean" || !allNames.includes(name)) {
    return listLocalTools();
  }

  const config = readConfig();
  const currentlyEnabled =
    config.enabledLocalTools === "all" ? allNames : [...config.enabledLocalTools];
  const next = enabled
    ? [...new Set([...currentlyEnabled, name])]
    : currentlyEnabled.filter((n) => n !== name);
  config.enabledLocalTools = next;
  writeConfig(config);
  return listLocalTools();
}

// Gives a Clance-launched terminal session (the real `claude` CLI, not the
// Agent SDK — see docs/background.md) a set of
// "computer use" tools — reading and acting on the user's screen — beyond
// what the CLI's own Read/Bash/Edit tools already cover (those act on the
// filesystem; these act on the GUI). The CLI process has no other route back
// into Electron's main process, so this exposes them over local-only
// MCP-over-HTTP rather than, say, custom SDK tools (there's no SDK query()
// call left to attach one to). See `docs/design.md` §"Local tools server"
// for the full tool list, the read/act/destructive tiering, and how
// popupWindow.ts's --allowedTools wiring pre-authorizes everything except
// the two destructive ones (clear/replace a field), which the CLI's own
// native permission prompt still gates.
//
// One real MCP *session* per `claude` process that connects, not one fresh
// McpServer/transport pair per HTTP request — a stateless, per-request
// design was tried first (simpler, and a truly *shared* single instance
// across every request had already failed once: it answered the first
// `initialize` fine but 500'd on the very next one, since its internal
// state assumed exactly one request per instance). Per-request instances
// avoided that crash, but broke the Streamable HTTP protocol's actual
// contract in a different way: a `GET` is supposed to open one persistent
// SSE stream for the *lifetime of a session*, correlated by
// `Mcp-Session-Id` with whatever POSTs came before and after it on that
// same session. With no session concept at all, that GET had no session to
// last as long as, so it either hung forever (nothing ever closes a stream
// with no defined lifetime) or, once closed immediately instead, triggered
// the real `claude` CLI's client to endlessly reconnect it (confirmed
// live — a tight loop of GET/close/reconnect in the logs) and eventually
// decide the whole server was unreachable, well before it ever tried the
// tool call the model actually wanted. Real sessions, each with their own
// long-lived transport instance kept in `sessions` below, is the fix:
// exactly the pattern the SDK's own reference server uses.
const sessions = new Map<
  string,
  { mcpServer: McpServer; transport: StreamableHTTPServerTransport; lastActivity: number }
>();

// Sessions nobody has used in this long are closed. A Clance restart leaves
// every running `claude` process to re-initialize, and its background
// reconnect can race the tool call's own recovery, so one restart can create
// two or three sessions of which only one is ever used again.
const SESSION_IDLE_MS = 60 * 60 * 1000;

// The listening port isn't a secret — anything else on the machine (another
// local process, or a malicious page in a browser, via DNS rebinding) could
// scan for it and, without a check here, get to type into whatever app the
// user last had focused. A random per-launch bearer token closes that off,
// checked with a constant-time comparison. The Host header check is defense
// in depth against DNS rebinding specifically, independent of the token.
//
// Sessions must keep working across Clance restarts, and the CLI persists a
// background agent's --mcp-config and reuses it whenever the agent restarts.
// So nothing per-launch goes into that config: the port and server key are
// saved once per install (see readPersistentIdentity), and the token reaches
// the CLI through `headersHelper` — a command the CLI runs to read the
// current token from a headers file, re-running it after a 401. A running
// session hitting a restarted Clance gets 401 (old token), re-reads the
// token, reconnects and retries the call.
let server:
  | { url: string; token: string; serverKey: string; headersHelper: string; headersPath: string }
  | undefined;

// Dev and packaged builds each get their own port, key and token file, so a
// dev run next to the installed app never takes its port or hands its token
// to the other's sessions.
const CHANNEL_SUFFIX = app.isPackaged ? "" : ".dev";
const IDENTITY_PATH = join(SESSION_CWD, `local-tools${CHANNEL_SUFFIX}.json`);

// The token file is named after the port it belongs to. Sessions minted with
// a port Clance has since had to give up (see listenOnSavedPort) still run
// their headersHelper when they call that port; with a per-port file (and
// the old one deleted) they find nothing to send, instead of handing the
// current token to whatever process — possibly another user's — now listens
// there.
function headersPathForPort(port: number): string {
  return join(SESSION_CWD, `local-tools-headers-${port}${CHANNEL_SUFFIX}.json`);
}
const HEADERS_FILE_PATTERN = new RegExp(`^local-tools-headers(-\\d+)?${CHANNEL_SUFFIX.replace(".", "\\.")}\\.json$`);

type PersistentIdentity = {
  port: number;
  keySuffix: string;
  // Set when the saved port was taken and the server moved; shown as a
  // warning in Settings until dismissed.
  portChangedFrom?: number;
};

// `keySuffix` makes the server key (`clance-<suffix>`) unpredictable to a
// project's .mcp.json — see sessionMcpArgs in popupWindow.ts. `port` 0 means
// none has been bound yet.
function readPersistentIdentity(): PersistentIdentity {
  try {
    const parsed = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
    if (
      Number.isInteger(parsed?.port) &&
      parsed.port >= 0 &&
      parsed.port < 65536 &&
      typeof parsed?.keySuffix === "string" &&
      /^[0-9a-f]{16}$/.test(parsed.keySuffix)
    ) {
      return {
        port: parsed.port,
        keySuffix: parsed.keySuffix,
        ...(Number.isInteger(parsed.portChangedFrom) ? { portChangedFrom: parsed.portChangedFrom } : {}),
      };
    }
  } catch {
    // Missing or unreadable — start a new identity below.
  }
  const identity = { port: 0, keySuffix: randomBytes(8).toString("hex") };
  writePersistentIdentity(identity);
  return identity;
}

function writePersistentIdentity(identity: PersistentIdentity): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), "utf8");
}

// Written only after the server is listening: a second Clance that fails to
// bind must never overwrite the token the running one checks. Written to a
// temp file and renamed so the CLI never reads a half-written file, and
// created 0600 so other users on the Mac can't read the token. Every other
// token file for this build channel is deleted (see headersPathForPort).
function writeHeadersFile(headersPath: string, token: string): void {
  const tmpPath = `${headersPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ Authorization: `Bearer ${token}` }), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, headersPath);

  for (const name of readdirSync(SESSION_CWD)) {
    const path = join(SESSION_CWD, name);
    if (path === headersPath || !HEADERS_FILE_PATTERN.test(name)) continue;
    try {
      unlinkSync(path);
    } catch (error) {
      console.warn(`[localToolsServer ${new Date().toISOString()}] couldn't delete old token file ${name}:`, error);
    }
  }
}

// The CLI runs headersHelper through a shell, so the path is single-quoted
// (with any embedded single quote escaped) rather than trusted to be
// shell-safe.
function headersHelperCommand(headersPath: string): string {
  return `cat '${headersPath.replace(/'/g, `'\\''`)}'`;
}

// insert_text/replace_focused_field's `text` param is arbitrary user
// content typed into another app — could be a password, a personal
// message, anything — so it's never logged verbatim, only its length.
// Every other arg (app, x, y) is low-sensitivity enough to log as-is: it's
// already visible to the model itself (an app name it picked, or
// coordinates it chose), just not content the user is delivering somewhere.
function redactForLogging(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    redacted[key] = key === "text" && typeof value === "string" ? `<redacted, ${value.length} chars>` : value;
  }
  return redacted;
}

// Every tool call gets logged (start, success/failure, timing) to the
// Electron main process's own stdout/stderr (visible in the terminal
// running `npm start`/`electron .`) — added after a report of "unable to
// connect" errors on tool calls that a health check (a plain `initialize`
// round trip) couldn't reproduce, meaning whatever's wrong is specific to
// an actual tool invocation, not the connection/auth/handshake layer the
// health check already exercises. Wraps every server.registerTool handler
// below rather than instrumenting each individually. Return values are
// deliberately never logged at all (not even redacted) — several of them
// (read_selection's text, look_at_screen's image data) are exactly the
// kind of content this shouldn't be writing to a persistent/observable
// channel, and logging that "a call finished" never needed the result to
// be useful for debugging a hang or an error in the first place.
function withLogging<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const start = Date.now();
    console.log(`[localToolsServer ${new Date().toISOString()}] ${name} called`, args[0] ? JSON.stringify(redactForLogging(args[0])) : "");
    // --disallowedTools is fixed when a session is minted and persisted with
    // it, so a tool switched off in Settings afterwards would stay callable
    // in older sessions. Checked here on every call, the setting applies to
    // all sessions immediately.
    if (!listLocalTools().find((tool) => tool.name === name)?.enabled) {
      console.log(`[localToolsServer ${new Date().toISOString()}] ${name} refused: turned off in Settings`);
      return {
        content: [{ type: "text" as const, text: `The user has turned off ${name} in Clance's Settings.` }],
        isError: true,
      } as R;
    }
    try {
      const result = await handler(...args);
      console.log(`[localToolsServer ${new Date().toISOString()}] ${name} returned (${Date.now() - start}ms)`);
      return result;
    } catch (error) {
      // registerTool handlers below already catch their own expected
      // failures and return { isError: true } instead of throwing — a
      // throw escaping here is unexpected, and previously would have
      // propagated all the way up through mcpServer.connect()/
      // transport.handleRequest() with nothing catching it (see
      // ensureLocalToolsServer's now-wrapped request handler below),
      // leaving the connection hanging with no response ever sent — which
      // looks exactly like "unable to connect" from the CLI's side, not
      // like a clean tool error.
      console.error(`[localToolsServer ${new Date().toISOString()}] ${name} threw (${Date.now() - start}ms):`, error);
      throw error;
    }
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "clance-tools", version: "1.0.0" });

  server.registerTool(
    "insert_text",
    {
      description:
        "Types text into an app running on the user's Mac. Delivers it at the OS level (a clipboard " +
        "paste), so it lands wherever that app's cursor/focus currently is — it does not scroll to or " +
        "click any particular field first. Use this when the user asks you to write, draft, or insert " +
        "something into an app, rather than printing it in this terminal.\n\n" +
        "By default this targets the app the user had focused right before they opened this Clance " +
        "popup. To send it somewhere else instead (e.g. the user says 'put this in Slack' while looking " +
        "at something else), pass `app` with a name/substring of the target window's title — call " +
        "list_open_windows first if you need to see what's actually open and what its title looks like.",
      inputSchema: {
        text: z.string().describe("The exact text to type, verbatim."),
        app: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring to match against open window titles, to redirect the text to a " +
              "different app than the one focused when the popup opened. Omit to use that default app."
          ),
      },
    },
    withLogging("insert_text", async ({ text, app }) => {
      try {
        await typeIntoCapturedWindow(text, app);
        return { content: [{ type: "text" as const, text: "Typed." }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to type text: ${(error as Error).message}` }],
          isError: true,
        };
      }
    })
  );

  server.registerTool(
    "list_open_windows",
    {
      description:
        "Lists the titles of the user's currently open app windows. Use this to find the right value " +
        "for the `app` parameter on insert_text, clear_focused_field, replace_focused_field, or " +
        "activate_app, when you want to act on an app other than the one focused when this Clance " +
        "popup opened.",
      inputSchema: {},
    },
    withLogging("list_open_windows", async () => {
      const titles = await listOpenWindows();
      return {
        content: [
          {
            type: "text" as const,
            text: titles.length > 0 ? titles.join("\n") : "No open windows found.",
          },
        ],
      };
    })
  );

  server.registerTool(
    "look_at_screen",
    {
      description:
        "Takes a fresh screenshot of the user's screen right now and returns it as an image, so you can " +
        "see what they're actually looking at at this moment in the conversation — not just whatever was " +
        "captured when this popup first opened. Use this whenever the screen may have changed since then " +
        "(the user switched apps, scrolled, something loaded) and it matters to what they're asking.",
      inputSchema: {},
    },
    withLogging("look_at_screen", async () => {
      // Screen Recording is optional, so a user declining it is a supported
      // state rather than a misconfiguration — say so plainly, in words the
      // model can pass on, instead of a guess.
      if (!checkPermissions().screenRecording) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Screen Recording isn't enabled for Clance, so the screen can't be read. " +
                "The user can turn it on in System Settings → Privacy & Security → Screen Recording " +
                "(Clance needs a restart after enabling it).",
            },
          ],
          isError: true,
        };
      }
      const base64 = await captureActiveDisplay();
      if (!base64) {
        return {
          content: [{ type: "text" as const, text: "Couldn't capture the screen." }],
          isError: true,
        };
      }
      return { content: [{ type: "image" as const, data: base64, mimeType: "image/png" }] };
    })
  );

  // Which app a read should be about. Almost always "the one the user was in
  // when they asked", which is *not* the frontmost app: Clance is frontmost
  // while they type to Claude. So an explicit hint wins, then the app
  // recorded when the widget took focus, then whatever is in front.
  async function resolveReadTarget(
    appHint?: string
  ): Promise<{ pid?: number; label: string } | { error: string }> {
    if (!ax.isAvailable()) {
      return {
        error:
          "Clance's accessibility reader isn't available in this build, so the screen can't be read as text. " +
          "look_at_screen still works.",
      };
    }
    if (!ax.isTrusted()) {
      return {
        error:
          "Accessibility isn't enabled for Clance, so other apps' text can't be read. " +
          "The user can turn it on in System Settings → Privacy & Security → Accessibility.",
      };
    }
    if (appHint) {
      const matches = await ax.appByName(appHint);
      if (matches.length === 0) return { error: `No running app matches "${appHint}".` };
      const match = matches[0];
      return { pid: match.pid, label: match.name ?? appHint };
    }
    const front = await ax.frontmostApp();
    if (front && !front.ours) return { pid: front.pid, label: front.name ?? "the frontmost app" };
    const captured = capturedAppInfo();
    if (captured) return { pid: captured.pid, label: captured.name ?? "the app you came from" };
    return {
      error:
        "Clance is the frontmost app and there's no record of which app the user came from, " +
        "so there's nothing to read. Pass `app` to name one.",
    };
  }

  const appParameter = z
    .string()
    .optional()
    .describe(
      "Case-insensitive app name to read, e.g. \"Obsidian\". Omit to read the app the user was in " +
        "when they opened Clance — which is what they almost always mean."
    );

  server.registerTool(
    "read_focused_field",
    {
      description:
        "Reads the text of the field the user is typing in — its contents, what is selected inside it, " +
        "and where the cursor is — straight from the app's accessibility tree, with no screenshot and " +
        "without touching their clipboard. Use this before editing text in another app, so an edit is " +
        "made against what is actually there. Reads the app the user came from, not Clance.",
      inputSchema: { app: appParameter },
    },
    withLogging("read_focused_field", async ({ app }) => {
      const target = await resolveReadTarget(app);
      if ("error" in target) {
        return { content: [{ type: "text" as const, text: target.error }], isError: true };
      }
      const { element, via } = await ax.focusedField(target.pid);
      if (!element) {
        return {
          content: [
            { type: "text" as const, text: `Nothing is focused in ${target.label} that can be read as text.` },
          ],
        };
      }
      if (element.secure) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `A password field is focused in ${element.app?.name ?? target.label}. Its contents are ` +
                "never readable through Clance, deliberately — ask the user if you need what's in it.",
            },
          ],
        };
      }
      const value = typeof element.value === "string" ? element.value : "";
      const lines = [
        `Field in ${element.app?.name ?? target.label}: ${element.role ?? "unknown role"}` +
          (element.editable === false ? " (read-only)" : ""),
      ];
      if (element.placeholder) lines.push(`Placeholder: ${element.placeholder}`);
      if (element.selectedRange) {
        const { location, length } = element.selectedRange;
        lines.push(length > 0 ? `Selected: characters ${location}–${location + length}` : `Cursor at character ${location}`);
      }
      // "marked" means the app wasn't active and this is the field it would
      // return to — worth saying, since it's a claim about a moment ago.
      if (via === "marked-container") lines.push("(no text field was focused; this is the focused element)");
      lines.push("", value.length > 0 ? value : "(the field is empty)");
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    })
  );

  server.registerTool(
    "read_window_text",
    {
      description:
        "Reads a window's visible text from the app's accessibility tree, as text rather than as a " +
        "screenshot to interpret: labels, headings, fields, buttons, and a browser's page content. " +
        "Cheaper and more exact than look_at_screen when the question is about what something says " +
        "rather than how it looks. Reads the app the user came from unless told otherwise.",
      inputSchema: {
        app: appParameter,
        maxChars: z
          .number()
          .optional()
          .describe("Stop after roughly this many characters (default 8000)."),
      },
    },
    withLogging("read_window_text", async ({ app, maxChars }) => {
      const target = await resolveReadTarget(app);
      if ("error" in target) {
        return { content: [{ type: "text" as const, text: target.error }], isError: true };
      }
      const { text, truncated } = await ax.windowText({
        pid: target.pid,
        maxChars: maxChars ?? 8000,
      });
      if (!text) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No readable text came back from ${target.label}. Some apps publish little or nothing to ` +
                "the accessibility tree — look_at_screen will still show it.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: truncated ? `${text}\n\n(truncated)` : text,
          },
        ],
      };
    })
  );

  server.registerTool(
    "read_selection",
    {
      description:
        "Reads whatever text the user has highlighted, from the app's accessibility tree — no clipboard " +
        "involved and nothing typed into their app. Reads the app they came from rather than Clance, " +
        "so it still works while they're typing here. A highlighted passage is usually the subject of " +
        "the question, so this is worth reading when they say \"this\" without saying what.",
      inputSchema: { app: appParameter },
    },
    withLogging("read_selection", async ({ app }) => {
      const target = await resolveReadTarget(app);
      if ("error" in target) {
        return { content: [{ type: "text" as const, text: target.error }], isError: true };
      }
      const { element } = await ax.focusedField(target.pid);
      const selected = element?.selectedText ?? "";
      if (!selected.trim()) {
        return {
          content: [
            { type: "text" as const, text: `Nothing is selected in ${element?.app?.name ?? target.label}.` },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: selected }] };
    })
  );

  server.registerTool(
    "activate_app",
    {
      description:
        "Brings a different app to the front, by name, without typing or clicking anything — use this " +
        "before click_at if you need to act on an app that isn't already frontmost. Call " +
        "list_open_windows first if you're not sure of the exact title.",
      inputSchema: {
        app: z.string().describe("Case-insensitive substring to match against open window titles."),
      },
    },
    withLogging("activate_app", async ({ app }) => {
      const ok = await activateApp(app);
      return {
        content: [
          { type: "text" as const, text: ok ? `Activated "${app}".` : `No open window matching "${app}".` },
        ],
        isError: !ok,
      };
    })
  );

  server.registerTool(
    "click_at",
    {
      description:
        "Clicks at a position on the user's screen, wherever the cursor's display currently is. `x` and " +
        "`y` are fractions of that display's width/height (0.0 to 1.0 each way, e.g. the center of the " +
        "screen is x=0.5, y=0.5) — estimate them visually from a screenshot you just looked at " +
        "(look_at_screen, or the one attached at the start of this conversation), not pixel coordinates. " +
        "To click in a specific app, call activate_app first so it's the one actually on screen.",
      inputSchema: {
        x: z.number().min(0).max(1).describe("Horizontal position, as a fraction of the display's width."),
        y: z.number().min(0).max(1).describe("Vertical position, as a fraction of the display's height."),
      },
    },
    withLogging("click_at", async ({ x, y }) => {
      try {
        await clickAtNormalized(x, y);
        return { content: [{ type: "text" as const, text: `Clicked at (${x}, ${y}).` }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to click: ${(error as Error).message}` }],
          isError: true,
        };
      }
    })
  );

  server.registerTool(
    "clear_focused_field",
    {
      description:
        "Selects everything in the currently focused field and deletes it (Cmd+A, then Delete). A blunt " +
        "instrument — it clears the whole field, not a specific word or range — since there's no generic " +
        "way to know a field's exact contents or cursor position across apps. Use replace_focused_field " +
        "instead if you're about to type something back in.",
      inputSchema: {
        app: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring to match against open window titles, to redirect this to a " +
              "different app than the one focused when the popup opened. Omit to use that default app."
          ),
      },
    },
    withLogging("clear_focused_field", async ({ app }) => {
      try {
        await clearFocusedField(app);
        return { content: [{ type: "text" as const, text: "Cleared." }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to clear field: ${(error as Error).message}` }],
          isError: true,
        };
      }
    })
  );

  server.registerTool(
    "replace_focused_field",
    {
      description:
        "Replaces the entire contents of the currently focused field with new text (Cmd+A, then pastes " +
        "the given text) — one atomic action instead of separately clearing and typing. A blunt " +
        "instrument — it replaces the whole field, not a specific word or range.",
      inputSchema: {
        text: z.string().describe("The exact text to replace the field's contents with, verbatim."),
        app: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring to match against open window titles, to redirect this to a " +
              "different app than the one focused when the popup opened. Omit to use that default app."
          ),
      },
    },
    withLogging("replace_focused_field", async ({ text, app }) => {
      try {
        await replaceFocusedField(text, app);
        return { content: [{ type: "text" as const, text: "Replaced." }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to replace field: ${(error as Error).message}` }],
          isError: true,
        };
      }
    })
  );

  return server;
}

function isAuthorized(req: import("http").IncomingMessage, expectedHost: string, token: string): boolean {
  if (req.headers.host !== expectedHost) return false;

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== expectedHost) return false;
    } catch {
      return false;
    }
  }

  const authHeader = req.headers.authorization;
  const expected = `Bearer ${token}`;
  const provided = Buffer.from(authHeader ?? "", "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
}

// An unknown Mcp-Session-Id means this server lost the session — almost
// always because Clance restarted while the `claude` process kept running.
// The MCP spec's signal for that is 404, which makes the client
// re-initialize and carry on; a 400 is read as a bad request, and the
// session stays broken for good (both confirmed against the real CLI).
function rejectUnknownSession(res: import("http").ServerResponse, method: string, sessionId: string): void {
  console.warn(`[localToolsServer ${new Date().toISOString()}] ${method} for unknown session ${sessionId}: 404, client should re-initialize`);
  res.writeHead(404, { "Content-Type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } })
  );
}

// Binds the saved port if there is one, so the URL persisted in every
// session's --mcp-config stays valid. If another app has taken it, falls
// back to a new random port and saves that; sessions persisted with the old
// port then lose their tools until they're stopped and reopened (see
// resolveOpenArgs in agentSessions.ts).
async function listenOnSavedPort(httpServer: Server, identity: PersistentIdentity): Promise<number> {
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, "127.0.0.1");
    });

  if (identity.port !== 0) {
    try {
      await listen(identity.port);
      return identity.port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      console.warn(
        `[localToolsServer ${new Date().toISOString()}] saved port ${identity.port} is in use; picking a new one — sessions minted with the old port need reopening`
      );
    }
  }
  await listen(0);
  const { port } = httpServer.address() as AddressInfo;
  writePersistentIdentity({
    ...identity,
    port,
    ...(identity.port !== 0 ? { portChangedFrom: identity.port } : {}),
  });
  return port;
}

// Starts (once) and returns what a launched CLI session's --mcp-config
// should use: the URL on the per-install port, the per-install server key,
// and the headersHelper command that reads this launch's token (see the
// note above `server`). The token itself is returned only for the health
// check below. Started at app launch (index.ts), not lazily on the first
// mint, since sessions from earlier launches may call in at any time.
let starting: Promise<{ url: string; token: string; serverKey: string; headersHelper: string }> | undefined;

export function ensureLocalToolsServer(): Promise<{
  url: string;
  token: string;
  serverKey: string;
  headersHelper: string;
}> {
  if (server) return Promise.resolve(server);
  starting ??= startLocalToolsServer().finally(() => {
    starting = undefined;
  });
  return starting;
}

async function startLocalToolsServer(): Promise<{
  url: string;
  token: string;
  serverKey: string;
  headersHelper: string;
}> {
  const identity = readPersistentIdentity();
  const token = randomBytes(32).toString("hex");

  let expectedHost = "";
  // Wrapped in try/catch with a guaranteed response in every branch —
  // previously, anything throwing/rejecting between here and
  // transport.handleRequest() (nothing did, as far as testing found, but
  // nothing here proved it either) would leave `res` never written to at
  // all: no timeout, no error, just a hung connection. From the CLI's
  // side, that's indistinguishable from "the server never responded" —
  // exactly a reported "unable to connect", not a clean tool error. Now
  // every request is logged and every code path ends the response.
  const httpServer = createServer((req, res) => {
    void (async () => {
      const start = Date.now();
      const remote = req.socket.remoteAddress;
      console.log(`[localToolsServer ${new Date().toISOString()}] ${req.method} ${req.url} from ${remote}`);
      try {
        if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
          console.warn(`[localToolsServer ${new Date().toISOString()}] rejected: unexpected remote address ${remote}`);
          res.writeHead(403).end();
          return;
        }
        if (!isAuthorized(req, expectedHost, token)) {
          console.warn(
            `[localToolsServer ${new Date().toISOString()}] rejected: unauthorized (host header: ${req.headers.host}, expected: ${expectedHost})`
          );
          res.writeHead(401).end();
          return;
        }

        const sessionIdHeader = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
        const existing = sessionId ? sessions.get(sessionId) : undefined;

        res.on("close", () => console.log(`[localToolsServer ${new Date().toISOString()}] request finished (${Date.now() - start}ms)`));

        // GET opens a long-lived SSE stream for server-initiated
        // messages — genuinely optional per spec, and this server has no
        // server-initiated messages to push through one anyway (every
        // tool result rides back on its own POST response). Three earlier
        // attempts at supporting it regardless each failed live in a
        // different way: hanging forever (no session to bound its
        // lifetime), closing immediately (client reconnect-looped, back
        // when there was no session concept to even reconnect *to*), and
        // finally — once real sessions existed — leaving it open but
        // silent: the official MCP client library
        // (@modelcontextprotocol/sdk's StreamableHTTPClientTransport)
        // treats an idle GET stream that never sends a byte as an
        // *unexpected* disconnect once its own HTTP stack's idle/body
        // timeout fires, retries reconnecting it a couple of times, and
        // once those retries are exhausted marks the whole session
        // broken — exactly the "Failed to reconnect... (detail withheld)"
        // seen live, after which every subsequent tool call failed
        // without the CLI even issuing an HTTP request for it. Declining
        // GET with 405 sidesteps all of that: the client's own source
        // hard-codes 405 as an *expected* case ("server does not offer an
        // SSE stream... should not trigger an error") and silently falls
        // back to POST-only, which is all this server ever needed to
        // begin with. DELETE (session termination) still requires and
        // uses a real session, same as before — it's a one-shot request,
        // not a stream, so it was never the idle-timeout problem.
        if (req.method === "GET") {
          console.log(`[localToolsServer ${new Date().toISOString()}] declining GET (no server-initiated messages to stream)`);
          res.writeHead(405, { Allow: "POST, DELETE" }).end();
          return;
        }
        if (req.method === "DELETE") {
          if (!existing) {
            if (sessionId) {
              rejectUnknownSession(res, "DELETE", sessionId);
            } else {
              console.warn(`[localToolsServer ${new Date().toISOString()}] rejected DELETE: no session id`);
              res.writeHead(400).end();
            }
            return;
          }
          await existing.transport.handleRequest(req, res);
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let parsedBody: unknown;
        try {
          parsedBody = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        } catch (error) {
          console.error(`[localToolsServer ${new Date().toISOString()}] rejected: unparseable request body:`, error);
          res.writeHead(400).end();
          return;
        }

        if (existing) {
          existing.lastActivity = Date.now();
          // Reusing the same transport instance the session was created
          // with — not a fresh one — is exactly what makes this stateful:
          // the SDK's own internal session/stream bookkeeping only works
          // if every request for one session goes through the one
          // transport object that's tracking it.
          await existing.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (sessionId) {
          rejectUnknownSession(res, "POST", sessionId);
          return;
        }

        if (isInitializeRequest(parsedBody)) {
          const mcpServer = createMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomBytes(16).toString("hex"),
            onsessioninitialized: (newSessionId) => {
              console.log(`[localToolsServer ${new Date().toISOString()}] session ${newSessionId} initialized`);
              sessions.set(newSessionId, { mcpServer, transport, lastActivity: Date.now() });
            },
          });
          transport.onerror = (error) => {
            console.error(`[localToolsServer ${new Date().toISOString()}] transport error (session ${transport.sessionId}):`, error);
          };
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && sessions.has(sid)) {
              console.log(`[localToolsServer ${new Date().toISOString()}] session ${sid} closed`);
              sessions.delete(sid);
            }
            void mcpServer.close();
          };
          // Connected before handling the request, same as the SDK's own
          // reference server — responses need the transport already
          // wired to the server to have anywhere to flow back through.
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        // No session and not an initialize — nothing valid to do with this
        // request. (The CLI sends a `server/discover` probe like this before
        // initializing; the 400 is harmless.)
        console.warn(`[localToolsServer ${new Date().toISOString()}] rejected: no session and not an initialize request`);
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          })
        );
      } catch (error) {
        console.error(`[localToolsServer ${new Date().toISOString()}] request handler threw (${Date.now() - start}ms):`, error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: `Internal error: ${(error as Error)?.message ?? error}` },
            })
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });

  // Node's http.Server defaults to a 5-second keep-alive timeout — it
  // closes an idle persistent connection that quickly, since a typical web
  // server expects a client to reconnect for its next request soon after
  // the last one. The real `claude` CLI's MCP client instead opens ONE
  // connection per session and expects to reuse it for as long as the
  // session lives, with no idea our server ever unilaterally closed it —
  // so it kept trying to write the next request onto a socket we'd
  // already dropped. Confirmed live: a `claude --debug-file` capture
  // showed a tool call failing *instantly* ("Tool ... failed after 0s:
  // Unable to connect") with the client's own log noting "HTTP connection
  // dropped after 56s uptime" — 56s of ordinary idle time (the user
  // reading the screen, thinking, typing) comfortably past our 5s
  // default, well before any actual hang or slowness anywhere. This isn't
  // a "some requests are slow" bug — every request after any gap over 5s
  // failed the same way, instantly, on the very next request regardless
  // of which "session number" it was; the earlier first-widget/
  // second-widget pattern was circumstantial (whichever widget's user
  // happened to pause more than 5s before their next message). Raised to
  // comfortably outlast any realistic idle gap inside one conversation —
  // `headersTimeout` has to exceed `keepAliveTimeout` (Node enforces
  // this) so it's raised to match.
  httpServer.keepAliveTimeout = 60 * 60 * 1000;
  httpServer.headersTimeout = 60 * 60 * 1000 + 1000;

  const port = await listenOnSavedPort(httpServer, identity);
  expectedHost = `127.0.0.1:${port}`;
  const headersPath = headersPathForPort(port);
  writeHeadersFile(headersPath, token);

  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [sid, session] of sessions) {
      if (session.lastActivity >= cutoff) continue;
      console.log(`[localToolsServer ${new Date().toISOString()}] closing idle session ${sid}`);
      void session.transport.close();
    }
  }, 10 * 60 * 1000).unref();

  server = {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    serverKey: `clance-${identity.keySuffix}`,
    headersHelper: headersHelperCommand(headersPath),
    headersPath,
  };
  console.log(`[localToolsServer ${new Date().toISOString()}] listening on ${server.url}`);
  return server;
}

// Whether the server has started yet. It's started at app launch, so "not
// running" means startup failed or hasn't finished. Doesn't start it itself;
// that's what the health check below is for.
//
// `portChange` is set when the saved port was taken at some launch and the
// server moved: sessions minted with the old port have no local tools, and
// nothing else would tell the user why.
export function getLocalToolsServerStatus(): {
  running: boolean;
  url?: string;
  portChange: { from: number; to: number } | null;
} {
  const identity = readPersistentIdentity();
  const portChange =
    identity.portChangedFrom !== undefined ? { from: identity.portChangedFrom, to: identity.port } : null;
  return server ? { running: true, url: server.url, portChange } : { running: false, portChange };
}

export function dismissLocalToolsPortChange(): ReturnType<typeof getLocalToolsServerStatus> {
  const { portChangedFrom: _dismissed, ...identity } = readPersistentIdentity();
  writePersistentIdentity(identity);
  return getLocalToolsServerStatus();
}

// Exercises the same path a launched CLI session uses — the token read from
// the headers file headersHelper serves, then an `initialize` POST to the
// /mcp URL — so a failure here narrows down whether a reported "tool call
// failed" is this server's fault or something in how the CLI was configured
// to reach it. Starts the server first if it isn't running yet (unlike
// getLocalToolsServerStatus above), since "can it even start" is itself part
// of what's being checked. Ends the session it opens, so checks don't leave
// sessions behind.
export async function checkLocalToolsServerHealth(): Promise<{
  ok: boolean;
  detail: string;
  latencyMs?: number;
}> {
  let url: string, token: string;
  try {
    ({ url, token } = await ensureLocalToolsServer());
  } catch (error) {
    return { ok: false, detail: `Couldn't start the server: ${(error as Error).message}` };
  }

  let authorization: unknown;
  try {
    authorization = JSON.parse(readFileSync(server!.headersPath, "utf8"))?.Authorization;
  } catch (error) {
    return { ok: false, detail: `Couldn't read the token file sessions use: ${(error as Error).message}` };
  }
  if (authorization !== `Bearer ${token}`) {
    return {
      ok: false,
      detail: "The token file sessions read doesn't match this server — another Clance may have overwritten it.",
    };
  }

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: authorization,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "clance-health-check", version: "1.0.0" },
        },
      }),
    });
    const latencyMs = Date.now() - start;
    const bodyText = await res.text();
    const sessionId = res.headers.get("mcp-session-id");
    if (sessionId) {
      void fetch(url, {
        method: "DELETE",
        headers: { Authorization: authorization, "Mcp-Session-Id": sessionId },
      }).catch(() => {});
    }
    if (!res.ok) {
      return {
        ok: false,
        detail: `Server responded with HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
        latencyMs,
      };
    }
    // Not a full protocol client — just confirming the response looks like
    // a real MCP reply rather than, say, an empty 200 from something else
    // entirely on that port.
    const looksValid = bodyText.includes('"jsonrpc"') && bodyText.includes("result");
    return {
      ok: looksValid,
      detail: looksValid
        ? `Responding normally (${latencyMs}ms).`
        : `Unexpected response body: ${bodyText.slice(0, 200)}`,
      latencyMs,
    };
  } catch (error) {
    return { ok: false, detail: `Couldn't reach the server: ${(error as Error).message}` };
  }
}
