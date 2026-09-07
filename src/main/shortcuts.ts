export type ShortcutAction = {
  id: string;
  label: string;
  defaultAccelerator: string;
};

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "togglePopup",
    label: "Open Clance popup",
    defaultAccelerator: "Alt+Space",
  },
];
