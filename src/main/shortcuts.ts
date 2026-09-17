export type ShortcutAction = {
  id: string;
  label: string;
  description: string;
  defaultAccelerator: string;
};

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "togglePopup",
    label: "Open Clance",
    description: "Show or hide the floating window.",
    defaultAccelerator: "Alt+Space",
  },
  {
    id: "dictate",
    label: "Dictate",
    description: "Talk anywhere; Clance types it.",
    defaultAccelerator: "Alt+D",
  },
];
