import { getHud, hideHud, sendToHud, showHud } from "../dictationWindow";
import type { Candidate, Resolution } from "./types";

// The assistant's surface, which is the dictation HUD.
//
// Reused rather than rebuilt: that window is already non-focusable, already
// shown with showInactive(), already above full-screen apps and already
// pre-warmed at launch — and the assistant's whole premise is that the app
// the user was in keeps focus. Two HUDs can't be up at once anyway, since
// ⌥D and ⌥A are the same microphone.

export type AssistantView =
  | { state: "listening"; heard: string }
  | { state: "thinking"; heard: string }
  | { state: "asking"; question: string; options: string[] }
  | { state: "acting"; label: string }
  | { state: "said"; message: string; ok: boolean };

export async function openHud(): Promise<void> {
  await showHud();
  sendToHud("assistant:open");
}

export function show(view: AssistantView): void {
  sendToHud("assistant:view", view);
}

/**
 * Bring the pill back if something else put it away.
 *
 * Dictation hides the HUD when it finishes, and a dictate-into command
 * runs a whole dictation in the middle of a listening session — so without
 * this the assistant's acknowledgement of it would be sent to a hidden
 * window and the user would see the session go quiet.
 */
export async function ensureVisible(): Promise<void> {
  const window = getHud();
  if (window && !window.isDestroyed() && window.isVisible()) return;
  await openHud();
}

export function closeHud(): void {
  sendToHud("assistant:close");
  hideHud();
}

export function confirmationFor(resolution: Resolution): AssistantView {
  return {
    state: "asking",
    question: `${resolution.label}?`,
    options: ["Yes", "No", "Always allow this"],
  };
}

export function ambiguityFor(among: Candidate[]): AssistantView {
  return {
    state: "asking",
    question: "Which one?",
    options: among.map((candidate) => candidate.detail ?? candidate.label),
  };
}
