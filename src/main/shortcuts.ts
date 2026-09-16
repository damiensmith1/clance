export type ShortcutAction = {
  id: string;
  label: string;
  description: string;
  defaultAccelerator: string;
};

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "togglePopup",
    label: "New Conversation",
    description: "Hotkey to open the popup with a fresh conversation.",
    defaultAccelerator: "Alt+Space",
  },
  {
    id: "dictate",
    label: "Dictate",
    description: "Start or stop dictation. The transcript is typed wherever your cursor is.",
    defaultAccelerator: "Alt+D",
  },
];
