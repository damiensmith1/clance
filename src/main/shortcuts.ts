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
];
