import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { canvasRequest, lodeCall } from "./lode";

// lode for Claude sessions: tools to see a project's code graph and the lode
// tabs' canvases, and to draw on them. Registered on Clance's local tools
// server (localToolsServer.ts), which sessions already connect to.
//
//   graph   lode-graph's own MCP tools (lodeTools: search, read, context,
//           impact, changes, entries), run against the project's lode that
//           Clance already has running for its lode tabs (lode.ts)
//   canvas  lode_canvases (which lode tabs are open), lode_canvas (one's
//           cards as context), and drawing: lode_show, lode_build_flow,
//           lode_expand, lode_close, lode_select, lode_focus,
//           lode_changes_shown, carried out by the window on the tab's
//           <lode-flow> (Shell.js's canvas handler: flow.apply)
//
// A tool's `canvas` is a lode tab's id (from lode_canvases); without one,
// the lode tab in front. The graph tools work on that canvas's project.
// Written against lode-graph's public API only, so this can move into
// lode-graph as a toolkit any host mounts.

export interface CanvasInfo {
  canvas: string;
  label: string;
  folder: string;
  cards: number;
  question?: string;
  showing: boolean; // the active tab of its pane
  focused: boolean; // the tab in front: the active pane's
}

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): Text => ({ content: [{ type: "text", text: t }], isError: true });

export const LODE_TOOL_NAMES = [
  "lode_canvases",
  "lode_canvas",
  "lode_show",
  "lode_build_flow",
  "lode_expand",
  "lode_close",
  "lode_select",
  "lode_focus",
  "lode_changes_shown",
  "lode_search",
  "lode_read",
  "lode_context",
  "lode_impact",
  "lode_changes",
  "lode_entries",
];

// The canvas a tool means: the one asked for, else the one in front (or
// showing, or any).
async function pick(canvas?: string): Promise<CanvasInfo> {
  const all = (await canvasRequest("list")) as CanvasInfo[];
  if (!all.length) throw new Error("No lode tab is open. Open one in Clance (Files → Open in lode) first.");
  if (canvas) {
    const hit = all.find((c) => c.canvas === canvas);
    if (!hit) throw new Error(`No lode tab ${canvas}; lode_canvases lists them.`);
    return hit;
  }
  return all.find((c) => c.focused) ?? all.find((c) => c.showing) ?? all[0];
}

// JSON Schema (lode-graph's tool schemas) → zod, for the MCP server: the
// shapes lode's tools use (strings, numbers, enums, string arrays).
function zodOf(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: string[]; description?: string; items?: { type?: string } }>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, p] of Object.entries(props)) {
    let t: z.ZodTypeAny =
      p.enum ? z.enum(p.enum as [string, ...string[]]) : p.type === "number" ? z.number() : p.type === "array" ? z.array(p.items?.type === "number" ? z.number() : z.string()) : p.type === "boolean" ? z.boolean() : z.string();
    if (p.description) t = t.describe(p.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

const canvasArg = z.string().optional().describe("A lode tab's id, from lode_canvases (default: the lode tab in front)");
const cardsArg = z.array(z.string()).describe("Cards on the canvas, by name (Journal.post) or id");

// lode-graph's MCP module is ESM: loaded once (preloadLodeTools, at
// startup), so registering, per request, stays synchronous.
type LodeMcp = Awaited<ReturnType<typeof loadLodeMcp>>;
const loadLodeMcp = () => import("lode-graph/mcp");
let lodeMcp: LodeMcp | null = null;
export async function preloadLodeTools(): Promise<void> {
  lodeMcp ??= await loadLodeMcp();
}

export function registerLodeTools(server: McpServer, wrap: <A extends unknown[], R>(name: string, handler: (...args: A) => Promise<R>) => (...args: A) => Promise<R>): void {
  // --- seeing -------------------------------------------------------------------

  server.registerTool(
    "lode_canvases",
    {
      description:
        "Lists the user's open lode tabs in Clance: code read as cards on a canvas, linked by what calls what. Each has an id (pass it as `canvas` to the other lode tools), its project folder, how many cards, the question it was built for, and whether it's the one in front.",
      inputSchema: {},
    },
    wrap("lode_canvases", async () => {
      const all = (await canvasRequest("list")) as CanvasInfo[];
      if (!all.length) return text("No lode tabs are open.");
      return text(
        all
          .map((c) => `${c.canvas} — ${c.label} · ${c.cards} card${c.cards === 1 ? "" : "s"} · ${c.folder}${c.question ? ` · built for "${c.question}"` : ""}${c.focused ? " · in front" : c.showing ? " · showing" : ""}`)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "lode_canvas",
    {
      description:
        "What's on a lode canvas the user is looking at: its cards' code (the selected ones when several are selected), how they connect, any git changes shown, and the question it was built for, as compact context. Call it before answering about \"this flow\", \"these cards\", \"what I'm looking at\".",
      inputSchema: { canvas: canvasArg, budget: z.number().optional().describe("About how many tokens (default 12000)") },
    },
    wrap("lode_canvas", async ({ canvas, budget }: { canvas?: string; budget?: number }) => {
      try {
        const c = await pick(canvas);
        const r = (await canvasRequest("read", { canvas: c.canvas, budget: budget ?? 12_000 })) as { markdown: string; cards: { key: string; name: string; file?: string; selected: boolean }[]; question?: string };
        if (!r.cards.length) return text(`${c.canvas} (${c.label}) is empty. lode_show or lode_build_flow put cards on it.`);
        const header = [
          `Canvas ${c.canvas} — ${c.label}, in ${c.folder}${r.question ? `, built for "${r.question}"` : ""}.`,
          `Cards: ${r.cards.map((k) => `${k.name}${k.selected ? " (selected)" : ""}`).join(", ")}`,
        ].join("\n");
        return text(`${header}\n\n${r.markdown}`);
      } catch (error) {
        return fail((error as Error).message);
      }
    }),
  );

  // --- drawing --------------------------------------------------------------------
  //
  // Each becomes one of lode's canvas actions (CanvasAction), applied by the
  // window; one tool call undoes as one step.

  const apply = async (canvas: string | undefined, actions: Record<string, unknown>[]) => {
    const c = await pick(canvas);
    const r = (await canvasRequest("apply", { canvas: c.canvas, actions })) as { cards: string[]; missing?: string[] };
    const missing = r.missing?.length ? ` (not on the canvas: ${r.missing.join(", ")})` : "";
    return text(`${c.canvas} now has ${r.cards.length} card${r.cards.length === 1 ? "" : "s"}: ${r.cards.join(", ")}${missing}`);
  };
  const guard =
    <A>(run: (args: A) => Promise<Text>) =>
    async (args: A) => {
      try {
        return await run(args);
      } catch (error) {
        return fail((error as Error).message);
      }
    };

  server.registerTool(
    "lode_show",
    {
      description: "Put symbols (functions, classes, files) on a lode canvas as cards, beside what's there, linked where they call each other. By id or name; lode_search finds them.",
      inputSchema: { canvas: canvasArg, symbols: z.array(z.string()).describe("Symbol ids (src/a.ts#run) or names (run)") },
    },
    wrap(
      "lode_show",
      guard(async ({ canvas, symbols }: { canvas?: string; symbols: string[] }) => {
        const c = await pick(canvas);
        const ids = await Promise.all(symbols.slice(0, 12).map((s) => resolveSymbol(c.folder, s)));
        const found = ids.filter((id): id is string => !!id);
        if (!found.length) return fail(`None of ${symbols.join(", ")} is a symbol in ${c.folder}; try lode_search.`);
        return apply(c.canvas, [{ kind: "add", ids: found }]);
      }),
    ),
  );

  server.registerTool(
    "lode_build_flow",
    {
      description: "Build the flow that answers a question (\"how is a transfer posted?\") and lay it out on a lode canvas: where to start and each step after, as linked cards with a note on why each is there.",
      inputSchema: { canvas: canvasArg, question: z.string().describe("What the flow should show") },
    },
    wrap(
      "lode_build_flow",
      guard(async ({ canvas, question }: { canvas?: string; question: string }) => {
        const c = await pick(canvas);
        const plan = (await lodeCall(c.folder, "ask", { question })) as { cards: unknown[]; answered: boolean; message?: string };
        if (!plan.answered || !plan.cards.length) return fail(`lode couldn't build a flow for that: ${plan.message ?? "nothing found"}`);
        return apply(c.canvas, [{ kind: "plan", plan }]);
      }),
    ),
  );

  for (const [name, kind, description] of [
    ["lode_expand", "expand", "Expand a card: all its lines, and everything it leads to (what it calls, its methods) opened as cards beside it."],
    ["lode_close", "close", "Close cards on a lode canvas."],
    ["lode_select", "select", "Select cards on a lode canvas (to point the user at them; the canvas's selection is what lode_canvas reads first)."],
    ["lode_focus", "focus", "Move a lode canvas's view to these cards."],
  ] as const) {
    server.registerTool(
      name,
      { description, inputSchema: { canvas: canvasArg, cards: cardsArg } },
      wrap(
        name,
        guard(async ({ canvas, cards }: { canvas?: string; cards: string[] }) =>
          apply(canvas, kind === "expand" ? cards.map((card) => ({ kind, card })) : [{ kind, cards }]),
        ),
      ),
    );
  }

  server.registerTool(
    "lode_changes_shown",
    {
      description: "Show or hide git changes on a lode canvas's cards: added and changed lines marked, removed ones struck through.",
      inputSchema: { canvas: canvasArg, base: z.string().nullable().describe("A git ref to compare with (HEAD: uncommitted changes), or null to hide them") },
    },
    wrap(
      "lode_changes_shown",
      guard(async ({ canvas, base }: { canvas?: string; base: string | null }) => apply(canvas, [{ kind: "changes", base }])),
    ),
  );

  // --- the graph: lode-graph's own tools, on the canvas's project -------------------

  if (!lodeMcp) return; // not loaded yet: the graph tools come with the next request
  const { lodeTools } = lodeMcp;
  const describing = lodeTools({ call: async () => null } as never); // names, descriptions, schemas
  for (const tool of describing) {
    server.registerTool(
      tool.name,
      { description: `${tool.description} Works on the project of a lode tab (\`canvas\`, default the one in front).`, inputSchema: { ...zodOf(tool.inputSchema), canvas: canvasArg } },
      wrap(
        tool.name,
        guard(async (args: Record<string, unknown>) => {
          const c = await pick(args.canvas as string | undefined);
          const service = { call: (method: string, params: Record<string, unknown>) => lodeCall(c.folder, method, params) };
          const run = lodeTools(service as never).find((t) => t.name === tool.name)!;
          return text(await run.run(args));
        }),
      ),
    );
  }
}

// A symbol by id ("src/a.ts#run", or a file) or by name ("run"), in a
// project.
async function resolveSymbol(folder: string, symbol: string): Promise<string | null> {
  const s = symbol.trim();
  if (!s) return null;
  if (s.includes("#") || /\.[a-z]+$/i.test(s)) return s;
  const found = (await lodeCall(folder, "search", { query: s })) as { id: string; name: string }[];
  return (found.find((n) => n.name === s) ?? found[0])?.id ?? null;
}
