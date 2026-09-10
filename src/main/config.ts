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
};

const CONFIG_PATH = join(SESSION_CWD, "config.json");

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space" },
  shortcutsConfigured: false,
  enabledSkills: [],
};

export function readConfig(): ClanceConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const stored = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      // Shallow-merging the top level alone lets an on-disk config saved
      // before a new shortcut was added wipe out that key entirely, since
      // it replaces the whole shortcuts object. (An on-disk config from
      // before a shortcut was *removed* — e.g. the old sessionPicker — just
      // carries a harmless, no-longer-read extra key here.)
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
