import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { SESSION_CWD } from "./paths";
import { readConfig } from "./config";
import { getActiveMcpServers } from "./mcpConfig";

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "done"; sessionId: string | undefined };

/**
 * Talk-back only for now: streams text deltas from a single-turn (or
 * resumed) query, with an optional screenshot sent alongside the goal as
 * image context. Text injection is not wired in yet.
 */
export async function* askClance(
  prompt: string,
  resumeSessionId: string | undefined,
  screenshotBase64: string | undefined
): AsyncGenerator<AgentEvent> {
  let sessionId: string | undefined;

  // @anthropic-ai/claude-agent-sdk ships ESM-only; this project builds to
  // CommonJS, so it must be brought in via dynamic import rather than a
  // static one.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

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
      mcpServers: getActiveMcpServers(),
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
    } else if (message.type === "result") {
      sessionId = message.session_id;
    }
  }

  yield { kind: "done", sessionId };
}
