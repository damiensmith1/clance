import { query } from "@anthropic-ai/claude-agent-sdk";
import { SESSION_CWD } from "./paths";

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "done"; sessionId: string | undefined };

/**
 * Talk-back only for now: streams text deltas from a single-turn (or
 * resumed) query. Screen context and text injection are not wired in yet.
 */
export async function* askClance(
  prompt: string,
  resumeSessionId: string | undefined
): AsyncGenerator<AgentEvent> {
  let sessionId: string | undefined;

  for await (const message of query({
    prompt,
    options: {
      cwd: SESSION_CWD,
      resume: resumeSessionId,
      includePartialMessages: true,
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
