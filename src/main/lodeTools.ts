import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { canvasRequest, lodeCall } from "./lode";

// lode for Claude sessions: tools to see the lode tabs' canvases and their
// projects' code graphs, and to draw on them (code cards, flows, notes,
// links, diagrams). The tools are lode-graph's own (canvasTools, from
// lode-graph/mcp), registered on Clance's local tools server
// (localToolsServer.ts), which sessions already connect to. Clance is their
// CanvasHost: the canvases are the lode tabs, which the window holds
// (canvasRequest → Shell.js's canvas handler, sections/lodeCanvases.js),
// and a canvas's graph is its project's running lode (lodeCall, lode.ts).

type LodeMcp = Awaited<ReturnType<typeof loadLodeMcp>>;
const loadLodeMcp = () => import("lode-graph/mcp");
let lodeMcp: LodeMcp | null = null;

// lode-graph's MCP module is ESM: loaded once (at startup), so registering,
// per request, stays synchronous.
export async function preloadLodeTools(): Promise<void> {
  lodeMcp ??= await loadLodeMcp();
}

/** lode-graph's tools, for the local tools list (localToolsServer.ts):
 *  each pre-authorized, described by its first sentence. Empty until
 *  loaded. */
export function lodeToolInfo(): { name: string; tier: "auto"; description: string }[] {
  if (!lodeMcp) return [];
  return lodeMcp.canvasTools(host as never).map((tool) => ({ name: tool.name, tier: "auto" as const, description: (tool.description.match(/^.*?[.:](\s|$)/)?.[0] ?? tool.description).trim() }));
}

interface CanvasInfo {
  canvas: string;
  label: string;
  folder: string;
  cards: number;
  question?: string;
  showing: boolean;
  focused: boolean;
  folders?: string[];
}

const host = {
  list: () => canvasRequest("list") as Promise<CanvasInfo[]>,
  read: (canvas: string, budget: number) =>
    canvasRequest("read", { canvas, budget }) as Promise<{ markdown: string; cards: { name: string; selected: boolean; note?: boolean; folder?: string; group?: string }[]; question?: string; groups?: { id: string; title: string; cards: string[] }[] }>,
  apply: (canvas: string, actions: unknown[]) => canvasRequest("apply", { canvas, actions }) as Promise<{ cards: string[] }>,
  // The project's lode for a canvas, or another folder's on it (the window
  // adds the folder to the canvas, which opens its lode, and says its path).
  service: (canvas: string, folder?: string) => ({
    call: async (method: string, params: Record<string, unknown> = {}) => {
      const root = folder
        ? ((await canvasRequest("folder", { canvas, folder })) as string)
        : ((await canvasRequest("list")) as CanvasInfo[]).find((c) => c.canvas === canvas)?.folder;
      if (!root) throw new Error(`No lode tab ${canvas}.`);
      return lodeCall(root, method, params);
    },
  }),
};

// JSON Schema (lode-graph's tool schemas) → zod, for the MCP server:
// strings, numbers, booleans, enums, nulls, arrays and objects.
type JsonSchema = { type?: string | string[]; enum?: string[]; description?: string; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[] };
function zodType(p: JsonSchema): z.ZodTypeAny {
  const types = Array.isArray(p.type) ? p.type : [p.type];
  const nullable = types.includes("null");
  const type = types.find((t) => t !== "null");
  let t: z.ZodTypeAny = p.enum
    ? z.enum(p.enum as [string, ...string[]])
    : type === "number"
      ? z.number()
      : type === "boolean"
        ? z.boolean()
        : type === "array"
          ? z.array(p.items ? zodType(p.items) : z.unknown())
          : type === "object"
            ? z.object(zodShape(p))
            : z.string();
  if (nullable) t = t.nullable();
  return p.description ? t.describe(p.description) : t;
}
function zodShape(schema: JsonSchema): Record<string, z.ZodTypeAny> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, p]) => [key, required.has(key) ? zodType(p) : zodType(p).optional()]));
}

export function registerLodeTools(server: McpServer, wrap: <A extends unknown[], R>(name: string, handler: (...args: A) => Promise<R>) => (...args: A) => Promise<R>): void {
  if (!lodeMcp) return; // not loaded yet: they come with the next session
  for (const tool of lodeMcp.canvasTools(host as never)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: zodShape(tool.inputSchema as JsonSchema) },
      wrap(tool.name, async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: "text" as const, text: await tool.run(args ?? {}) }] };
        } catch (error) {
          return { content: [{ type: "text" as const, text: (error as Error).message }], isError: true };
        }
      }),
    );
  }
}
