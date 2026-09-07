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
    id: "sessionPicker",
    label: "Continue a Conversation",
    description:
      "Hotkey to open the popup and pick a past conversation to continue, with fresh screen context.",
    defaultAccelerator: "Alt+Shift+Command+Space",
  },
];
