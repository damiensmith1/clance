import { Menu, MenuItemConstructorOptions } from "electron";
import { cancelDictation, toggleDictation } from "./dictation";
import { readConfig } from "./config";

export function createAppMenu(): Menu {
  // The HUD is frameless and non-focusable by design, so it has no title
  // bar, no close button, and can't receive ⌘W — which left the menu bar
  // with no way to stop or dismiss it. These items are that way out.
  const dictationMenu: MenuItemConstructorOptions = {
    label: "Dictation",
    submenu: [
      {
        label: "Start / Stop Dictation",
        // Shown as the menu accelerator but not registered by the menu:
        // the real binding is the user-configurable global shortcut, which
        // works whether or not a Clance window is open.
        accelerator: readConfig().shortcuts.dictate,
        registerAccelerator: false,
        click: () => void toggleDictation(),
      },
      {
        label: "Cancel Dictation",
        accelerator: "Escape",
        registerAccelerator: false,
        // Enabled state can't update live in a static menu, so this is
        // always clickable and simply no-ops when nothing is running.
        click: () => void cancelDictation(),
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: "Clance",
      submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
    },
    dictationMenu,
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "close" },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
