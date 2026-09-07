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
  // Whether opening an already-open tab (same section, or the same chat)
  // activates the existing tab instead of opening a duplicate.
  reuseTabs: boolean;
};

const CONFIG_PATH = join(SESSION_CWD, "config.json");

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space", sessionPicker: "Alt+Shift+Command+Space" },
  shortcutsConfigured: false,
  enabledSkills: [],
  reuseTabs: true,
};

export function readConfig(): ClanceConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(config: ClanceConfig): void {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}
