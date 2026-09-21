import * as ax from "../ax";
import { type Outcome, ok, fail } from "./types";
import type { ReadTarget } from "./target";
import { chord, type Chord } from "./keys";

// An app's own commands, read from the menu bar it publishes to macOS.
//
// This is what makes the assistant general: "save", "new note", "close tab"
// and "export as PDF" are not a list Clance maintains, they're whatever the
// frontmost app happens to offer right now. An app installed after Clance
// works without Clance knowing anything about it.
//
// Nested submenus are a known soft spot — many apps don't populate a
// submenu's children until the menu is actually opened, so a command two
// levels down can be missing from this list. It surfaces as "no such
// command" rather than as a wrong action, which is the right way round.

export type MenuCommand = {
  // "File > Export as PDF…", the path the user would follow.
  path: string;
  // The leaf's own label, which is what people actually say.
  label: string;
  // The top-level menu it lives under.
  menu: string;
  enabled: boolean;
  handle: number;
};

type CachedMenu = { bundleId: string; windowTitle: string; commands: MenuCommand[] };

// A menu is a function of the app's state — items grey out as the selection
// changes — so the cache is keyed by app *and* window and thrown away when
// either moves. Walking a menu bar costs tens of milliseconds, which the
// latency budget in docs/design.md has no room for on every command.
let cached: CachedMenu | null = null;

export function invalidateMenuCache(): void {
  cached = null;
}

const MENU_ROLES = new Set(["AXMenuItem", "AXMenuBarItem"]);

function labelOf(node: ax.AxNode): string {
  return (node.title ?? node.label ?? "").trim();
}

export async function menuCommands(target: ReadTarget): Promise<MenuCommand[]> {
  const { nodes } = await ax.tree({
    pid: target.pid,
    root: "menuBar",
    maxNodes: 1500,
    maxDepth: 8,
    includeEnabled: true,
  });
  if (nodes.length === 0) return [];

  // The tree comes back flattened with each node's parent index, so a path
  // is walked back up rather than tracked on the way down.
  const pathOf = (index: number): string[] => {
    const parts: string[] = [];
    for (let i: number = index; i >= 0; i = nodes[i].parent) {
      const label = labelOf(nodes[i]);
      if (label && MENU_ROLES.has(nodes[i].role ?? "")) parts.unshift(label);
      if (nodes[i].parent < 0) break;
    }
    return parts;
  };

  const commands: MenuCommand[] = [];
  nodes.forEach((node, index) => {
    if (node.role !== "AXMenuItem") return;
    const label = labelOf(node);
    // Separators come through as menu items with no label at all.
    if (!label) return;
    // An item that owns a submenu is a heading, not a command; its children
    // are the commands, and pressing it only opens the submenu.
    const hasSubmenu = nodes.some((child) => child.parent === index && child.role === "AXMenu");
    if (hasSubmenu) return;
    const parts = pathOf(index);
    // The Apple menu and the app's own first menu both carry commands worth
    // having, so nothing is filtered by which menu it came from.
    commands.push({
      path: parts.join(" > "),
      label,
      menu: parts[0] ?? "",
      enabled: node.enabled !== false,
      handle: node.handle,
    });
  });
  return commands;
}

// The frontmost app's commands, cached. `windowTitle` is what invalidates
// it: a different document, a different set of enabled commands.
export async function currentMenuCommands(
  target: ReadTarget,
  identity: { bundleId: string; windowTitle: string }
): Promise<MenuCommand[]> {
  if (cached && cached.bundleId === identity.bundleId && cached.windowTitle === identity.windowTitle) {
    return cached.commands;
  }
  const commands = await menuCommands(target);
  cached = { ...identity, commands };
  return commands;
}

export async function pressMenuCommand(command: MenuCommand, appLabel: string): Promise<Outcome> {
  if (!command.enabled) {
    // Refused rather than attempted: AXPress on a disabled item does
    // nothing and reports success, which would read as "done" for an
    // action that never happened.
    return fail(`"${command.label}" is in ${appLabel}'s ${command.menu} menu but isn't available right now.`);
  }
  const pressed = await ax.performAction(command.handle, "AXPress");
  if (pressed) return ok(`${command.path} — ${appLabel}.`);

  // Some apps refuse AXPress on a menu item they are perfectly happy to
  // run from the keyboard — Chrome's Close Tab, measured, while New Tab in
  // the same menu worked. Every item that has a shortcut publishes it, so
  // the shortcut is the fallback.
  const shortcut = await keyboardShortcut(command.handle);
  if (!shortcut) return fail(`${appLabel} didn't accept "${command.label}".`);
  try {
    await chord(shortcut);
    return ok(`${command.path} — ${appLabel}.`);
  } catch (error) {
    return fail(`${appLabel} didn't accept "${command.label}": ${(error as Error).message}`);
  }
}

/**
 * A menu item's own keyboard shortcut, as a chord.
 *
 * `AXMenuItemCmdModifiers` is a bitmask *of what to add to Command*, with
 * one inversion: bit 3 means there is no Command key at all. So 0 is a
 * bare ⌘, 1 is ⇧⌘, and 8 is the key on its own.
 */
async function keyboardShortcut(handle: number): Promise<Chord | null> {
  const values = await ax.attributes(handle, ["AXMenuItemCmdChar", "AXMenuItemCmdModifiers"]);
  const key = values?.AXMenuItemCmdChar;
  if (typeof key !== "string" || key.length !== 1 || !/[A-Za-z0-9]/.test(key)) return null;
  const mask = typeof values?.AXMenuItemCmdModifiers === "number" ? values.AXMenuItemCmdModifiers : 0;
  return {
    key: key.toUpperCase(),
    command: (mask & 8) === 0,
    shift: (mask & 1) !== 0,
    option: (mask & 2) !== 0,
    control: (mask & 4) !== 0,
  };
}
