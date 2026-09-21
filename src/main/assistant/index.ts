import { pasteAtCursor } from "../frontApp";
import { openMainWindowSection } from "../mainWindow";
import { openPopupWithArgs, sessionMintArgs } from "../popupWindow";
import {
  cancelDictation,
  dictateOnce,
  getDictationState,
  setAssistantSink,
  toggleDictation,
} from "../dictation";
import { queryTranscripts } from "../dictationStore";
import { installBridge } from "./bridge";
import { installSpeech, onUtterance, stopAssistant, toggleAssistant } from "./session";

export { toggleAssistant, stopAssistant, cancelAssistant, assistantState } from "./session";
export { resetDecider, currentDecider, deciderName } from "./decide";

/**
 * Connects the assistant to the rest of Clance, once, at startup.
 *
 * Everything the assistant needs from above it — dictation, the widget, the
 * main window — arrives through here rather than through imports, because
 * dictation calls *into* the assistant and a cycle between the two would be
 * a real one. See bridge.ts.
 */
export function setUpAssistant(): void {
  installSpeech({
    // The same on-device whisper, the same HUD, the same microphone — only
    // where the text lands differs (see dictation.ts's DictationPurpose).
    startListening: () => toggleDictation("assistant"),
    stopListening: async () => {
      if (getDictationState() !== "idle") await cancelDictation();
    },
  });

  setAssistantSink((text) => onUtterance(text));

  installBridge({
    // dictateOnce, not toggleDictation: the assistant has to wait for the
    // words before it takes the microphone back. See bridge.ts.
    startDictation: () => dictateOnce(),
    lastDictation: () => queryTranscripts({}, 1)[0]?.text ?? null,
    pasteText: (text) => pasteAtCursor(text),
    openWidgetSession: async (prompt) => {
      const args = await sessionMintArgs("popup");
      await openPopupWithArgs(prompt ? [...args, prompt] : args);
    },
    openSection: (section) => openMainWindowSection(section),
  });
}
