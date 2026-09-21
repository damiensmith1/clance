import type { Outcome } from "../capabilities";

// The rest of Clance, as seen by the assistant.
//
// The resolvers for "start dictation", "open a session" and "show me my
// chats" need dictation.ts, popupWindow.ts and mainWindow.ts — all of which
// sit *above* the assistant and one of which (dictation) calls into it.
// Injecting them here instead of importing them keeps that dependency
// pointing one way, and makes a resolver testable without an Electron app
// around it.
export type AssistantBridge = {
  /**
   * Dictate into whatever is focused, and **resolve only once it's done**.
   *
   * The awaiting is the whole point. Dictation and the assistant share one
   * microphone, so a dictate-into command has to hold the assistant's turn
   * open for as long as the user is speaking — otherwise the session
   * re-arms the instant the action returns and stops the dictation it just
   * started.
   */
  startDictation(): Promise<void>;
  /** The most recent transcript, for "paste what I just said". */
  lastDictation(): string | null;
  /** Paste text at the cursor in the app in front. */
  pasteText(text: string): Promise<void>;
  /** Open the floating widget on a new Claude Code session. */
  openWidgetSession(prompt: string): Promise<void>;
  /** Open the main window at one of its sections. */
  openSection(section: "chats" | "dictation" | "settings"): Promise<void>;
};

let bridge: AssistantBridge | null = null;

export function installBridge(next: AssistantBridge): void {
  bridge = next;
}

export function getBridge(): AssistantBridge | null {
  return bridge;
}

// Every resolver that uses the bridge goes through this, so "Clance isn't
// wired up yet" is an honest outcome rather than a crash.
export async function viaBridge(
  what: string,
  run: (bridge: AssistantBridge) => Promise<void>
): Promise<Outcome> {
  if (!bridge) return { ok: false, text: `Clance can't ${what} right now.` };
  try {
    await run(bridge);
    return { ok: true, text: what };
  } catch (error) {
    return { ok: false, text: `Couldn't ${what}: ${(error as Error).message}` };
  }
}
