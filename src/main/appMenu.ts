import { BaseWindow, BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";
import { cancelDictation, toggleDictation } from "./dictation";
import { readConfig } from "./config";
import { isMainWindow } from "./mainWindow";
import { closeWidget, isPopupWindow } from "./popupWindow";

// The window a menu command was invoked from. Menu clicks hand back a
// BaseWindow, which has no webContents of its own.
function browserWindowFor(win: BaseWindow | undefined): BrowserWindow | null {
  return win instanceof BrowserWindow ? win : null;
}

// Tab commands only mean something in the main window; anywhere else the
// keystroke does nothing rather than acting on some other window's tabs.
function sendTabCommand(target: BaseWindow | undefined, command: "close-tab" | "next-tab" | "prev-tab"): void {
  const win = browserWindowFor(target);
  if (win && isMainWindow(win)) win.webContents.send("window-command", command);
}

// ⌘W in the main window closes a tab (and the window itself once its last
// one goes — see Shell.js). On the widget it is that window's ✕, exactly:
// `closeWidget` hides it and releases a session nothing was ever typed
// into. Not `win.close()` — the widget's window is never destroyed, since
// its live session and xterm state are what make the next hotkey press
// instant.
function closeFocused(target: BaseWindow | undefined): void {
  const win = browserWindowFor(target);
  if (!win) return;
  if (isMainWindow(win)) win.webContents.send("window-command", "close-tab");
  else if (isPopupWindow(win)) closeWidget();
  else win.close();
}

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
        // Registered here rather than as a key listener in the renderer:
        // a menu accelerator is handled before the window sees the key, so
        // a focused terminal can't swallow it, and the binding stays where
        // macOS users look for it.
        {
          label: "Show Next Tab",
          accelerator: "Control+Tab",
          click: (_item, win) => sendTabCommand(win, "next-tab"),
        },
        {
          label: "Show Previous Tab",
          accelerator: "Control+Shift+Tab",
          click: (_item, win) => sendTabCommand(win, "prev-tab"),
        },
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: "CommandOrControl+W",
          click: (_item, win) => closeFocused(win),
        },
        // ⇧⌘W for the window itself, as in every tabbed macOS app, now that
        // plain ⌘W belongs to the tab.
        { role: "close", label: "Close Window", accelerator: "Shift+CommandOrControl+W" },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
