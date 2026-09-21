// The assistant's log, written to the Electron main process's own
// stdout/stderr — the terminal running `npm start`, or Console.app for a
// packaged build. Same shape as localToolsServer.ts's, so a session's tool
// calls and a spoken command read as one timeline when both are in flight.
//
// What gets logged, and what deliberately doesn't:
//
// The utterance is logged in full. It is by construction a command
// addressed to Clance, and when the decision service is on it is already
// being sent off the Mac — writing it to a local terminal is strictly less
// exposure than the feature itself. What never reaches this layer, and so
// can never appear here, is a field's contents or anything dictated: the
// dictate-into path focuses a field and hands over to whisper, and the
// words themselves never pass through a decider (docs/design.md, "What
// leaves the Mac").
//
// Candidate *labels* are logged; candidate lists are logged as counts. A
// window's full control list is hundreds of entries and would bury the one
// line that says what happened.

function stamp(): string {
  return new Date().toISOString();
}

export function log(message: string, ...rest: unknown[]): void {
  console.log(`[assistant ${stamp()}] ${message}`, ...rest);
}

export function warn(message: string, ...rest: unknown[]): void {
  console.warn(`[assistant ${stamp()}] ${message}`, ...rest);
}

/**
 * An API failure in the form that actually identifies it.
 *
 * The SDK throws typed errors carrying the status, the parsed body and a
 * request id, and the default `console.error(error)` buries all three under
 * a stack trace through the SDK's own internals. The body is the part that
 * matters: a 401 says the key is wrong, a 400 says the *request* is wrong —
 * a malformed question, too many labels on a choice — and those need
 * opposite fixes.
 */
export function apiFailure(what: string, error: unknown): void {
  const candidate = error as {
    status?: number;
    body?: unknown;
    requestId?: string;
    name?: string;
    message?: string;
  };
  if (typeof candidate?.status === "number") {
    warn(
      `${what}: HTTP ${candidate.status}` +
        (candidate.requestId ? ` (request ${candidate.requestId})` : ""),
      typeof candidate.body === "string" ? candidate.body : JSON.stringify(candidate.body)
    );
    return;
  }
  // A timeout or a connection failure has no status — the name is the
  // whole diagnosis (APITimeoutError vs APIConnectionError).
  warn(`${what}: ${candidate?.name ?? "error"} — ${candidate?.message ?? String(error)}`);
}

/** "3 of 292" — how hard a list was trimmed before it was sent. */
export function counted(shown: number, total: number): string {
  return shown === total ? String(total) : `${shown} of ${total}`;
}
