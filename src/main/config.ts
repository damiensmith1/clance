import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

export type ClanceConfig = {
  shortcuts: Record<string, string>;
  shortcutsConfigured: boolean;
  // Which skills from ~/.claude/skills/ the agent may use. Defaults to
  // none (opt-in) — skills can carry arbitrary instructions and were
  // likely installed for unrelated Claude Code CLI work, not vetted for
  // use inside Clance, so granting all of them by default would be a
  // broader grant than the app's setup flow gives anywhere else.
  // "all" remains a valid explicit value for anyone who wants it.
  enabledSkills: string[] | "all";
  // The `claude` CLI's own turn-complete desktop notification. Defaults to
  // false — a Clance-launched pty has no TERM_PROGRAM (Clance is a GUI
  // app, not spawned from a shell), so the CLI can't tell it's in a "real"
  // terminal and falls back to shelling out to `osascript -e 'display
  // notification'` directly, which macOS attributes to "Script Editor"
  // rather than Clance; opt-in via Settings rather than surprising anyone
  // with that. See ptyManager.ts's use of this flag.
  desktopNotifications: boolean;
};

const CONFIG_PATH = join(SESSION_CWD, "config.json");

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space", sessionPicker: "Alt+Shift+Command+Space" },
  shortcutsConfigured: false,
  enabledSkills: [],
  desktopNotifications: false,
};

export function readConfig(): ClanceConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const stored = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      // Shallow-merging the top level alone lets an on-disk config saved
      // before a new shortcut was added (e.g. sessionPicker) wipe out that
      // key entirely, since it replaces the whole shortcuts object.
      shortcuts: { ...DEFAULT_CONFIG.shortcuts, ...stored.shortcuts },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(config: ClanceConfig): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}
