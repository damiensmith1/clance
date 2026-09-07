import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { SESSION_CWD } from "./paths";
import { readConfig } from "./config";
import { getActiveMcpServers } from "./mcpConfig";

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "proposal"; id: string; text: string }
  | { kind: "done"; sessionId: string | undefined };

const CLANCE_TOOLS_SERVER_NAME = "clanceTools";
const PROPOSE_TEXT_TOOL_NAME = "proposeText";
// The SDK prefixes custom MCP-server tool names as mcp__<server>__<tool> in
// tool_use blocks and in allowedTools — verified empirically, not assumed;
// the server name above has no characters that would need sanitizing, so
// this qualified form is exact rather than a guess at any transformation.
const PROPOSE_TEXT_QUALIFIED_NAME = `mcp__${CLANCE_TOOLS_SERVER_NAME}__${PROPOSE_TEXT_TOOL_NAME}`;

/**
 * Streams text deltas from a single-turn (or resumed) query, with an
 * optional screenshot sent alongside the goal as image context. The model
 * can also "type it out" by calling the proposeText tool instead of
 * replying in prose — this never types anything itself; it only surfaces a
 * proposal event for the popup to show the user, who explicitly accepts
 * (typing happens via src/main/textInjection.ts, triggered from the
 * renderer) or rejects with revision instructions as a normal follow-up
 * turn in the same resumed session.
 */
export async function* askClance(
  prompt: string,
  resumeSessionId: string | undefined,
  screenshotBase64: string | undefined
): AsyncGenerator<AgentEvent> {
  let sessionId: string | undefined;

  // @anthropic-ai/claude-agent-sdk (and its zod dependency) ship ESM-only;
  // this project builds to CommonJS, so both must be brought in via dynamic
  // import rather than a static one.
  const { query, tool, createSdkMcpServer } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );
  const { z } = await import("zod");

  const proposeTextTool = tool(
    PROPOSE_TEXT_TOOL_NAME,
    "Propose text to type into the app the user invoked Clance from — a reply, an edit, anything the user asked to be typed/inserted on their behalf. This only shows the user a proposal; it does not type anything itself. Use this instead of replying in prose whenever the user's goal implies doing something in that app (writing, editing, filling something in), rather than just answering a question about it.",
    { text: z.string().describe("The exact text to propose inserting, verbatim — no extra commentary.") },
    async (args: { text: string }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: "Proposal shown to the user. Wait for their response — do not add further text this turn.",
          },
        ],
      };
    }
  );

  const clanceTools = createSdkMcpServer({
    name: CLANCE_TOOLS_SERVER_NAME,
    tools: [proposeTextTool],
    // Custom tools are deferred behind a tool-search step by default and
    // won't reliably surface to the model otherwise — confirmed by testing:
    // without this, the model insists it "can't type into applications"
    // because it never sees proposeText as an available tool at all.
    alwaysLoad: true,
  });

  // A screenshot can only be attached via the streaming-input form (a
  // plain string prompt has no way to carry an image block).
  async function* singleTurn() {
    const content: ContentBlockParam[] = [{ type: "text", text: prompt }];
    if (screenshotBase64) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: screenshotBase64,
        },
      });
    }

    yield {
      type: "user" as const,
      message: { role: "user" as const, content },
      parent_tool_use_id: null,
    };
  }

  const config = readConfig();

  for await (const message of query({
    prompt: singleTurn(),
    options: {
      cwd: SESSION_CWD,
      resume: resumeSessionId,
      includePartialMessages: true,
      // Cheapest current model, for dev/testing while the app is scaffolded.
      model: "claude-haiku-4-5",
      skills: config.enabledSkills,
      mcpServers: { ...getActiveMcpServers(), clanceTools },
      // Inert by design (the handler only acknowledges; real insertion
      // requires an explicit Accept click in the popup), so it's safe to
      // auto-allow without the SDK's normal interactive tool-permission
      // prompt — which, with no canUseTool callback wired up, would
      // otherwise auto-deny it outright (confirmed by testing).
      allowedTools: [PROPOSE_TEXT_QUALIFIED_NAME],
    },
  })) {
    if (message.type === "stream_event") {
      const event = message.event;
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { kind: "text", text: event.delta.text };
      }
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name === PROPOSE_TEXT_QUALIFIED_NAME) {
          const input = block.input as { text?: string };
          if (typeof input.text === "string") {
            yield { kind: "proposal", id: block.id, text: input.text };
          }
        }
      }
    } else if (message.type === "result") {
      sessionId = message.session_id;
    }
  }

  yield { kind: "done", sessionId };
}
