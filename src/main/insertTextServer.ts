import { createServer } from "http";
import type { AddressInfo } from "net";
import { randomBytes, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod";
import { typeIntoCapturedWindow } from "./frontApp";

// Gives a Clance-launched terminal session (the real `claude` CLI, not the
// Agent SDK — see docs/design.md "Terminal-embedding architecture") a way to
// type text into the app the user had focused before opening the popup. The
// CLI process has no other route back into Electron's main process, so this
// exposes one tool over local-only MCP-over-HTTP rather than, say, a custom
// SDK tool (there's no SDK query() call left to attach one to).
//
// A fresh McpServer + transport per request, in stateless mode (no
// Mcp-Session-Id) — the tool has no per-session state, so there's nothing a
// persistent session would buy here, and the SDK's stateless transport
// isn't meant to be reused across unrelated request/response cycles: a
// shared instance answered the first (`initialize`) request fine but 500'd
// on the very next one (the `notifications/initialized` that always follows
// it), since its internal state assumes each instance handles exactly one
// request lifecycle.
//
// The listening port is picked randomly but isn't a secret — anything else
// on the machine (another local process, or a malicious page in a browser,
// via DNS rebinding) could still guess/scan for it and, without a check
// here, get to type into whatever app the user last had focused. A random
// per-launch bearer token closes that off: it's generated fresh each run,
// known only to this process and the `claude` CLI child process it hands
// the token to via --mcp-config's `headers`, and checked with a
// constant-time comparison to avoid leaking it through timing. The Host
// header check is defense in depth against DNS-rebinding specifically,
// independent of the token.
let server: { url: string; token: string } | undefined;

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "clance-insert-text", version: "1.0.0" });

  server.registerTool(
    "insert_text",
    {
      description:
        "Types text into the app the user had focused right before they opened this Clance popup " +
        "(e.g. an email compose window, a chat message box, a document). Delivers it at the OS level " +
        "(a clipboard paste), so it lands wherever that app's cursor/focus currently is — it does not " +
        "scroll to or click any particular field first. Use this when the user asks you to write, draft, " +
        "or insert something into the app they were just using, rather than printing it in this terminal.",
      inputSchema: { text: z.string().describe("The exact text to type, verbatim.") },
    },
    async ({ text }) => {
      try {
        await typeIntoCapturedWindow(text);
        return { content: [{ type: "text" as const, text: "Typed." }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to type text: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
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

// Starts (once) and returns the local URL + bearer token a launched CLI
// session's --mcp-config should use. 127.0.0.1 + a random free port, chosen
// fresh per app launch, plus a random per-launch token (see the note above
// `server` for why the port alone isn't enough).
export async function ensureInsertTextServer(): Promise<{ url: string; token: string }> {
  if (server) return server;

  const token = randomBytes(32).toString("hex");

  let expectedHost = "";
  const httpServer = createServer(async (req, res) => {
    if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::1" && req.socket.remoteAddress !== "::ffff:127.0.0.1") {
      res.writeHead(403).end();
      return;
    }
    if (!isAuthorized(req, expectedHost, token)) {
      res.writeHead(401).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let parsedBody: unknown;
    try {
      parsedBody = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400).end();
      return;
    }

    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  expectedHost = `127.0.0.1:${port}`;
  server = { url: `http://127.0.0.1:${port}/mcp`, token };
  return server;
}
