export type ShortcutAction = {
  id: string;
  label: string;
  description: string;
  defaultAccelerator: string;
};

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "togglePopup",
    label: "Global Keyboard Shortcut",
    description: "Hotkey to toggle the quick interaction popup window.",
    defaultAccelerator: "Alt+Space",
  },
];
