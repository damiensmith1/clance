import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

export type ThemePreference = "light" | "dark" | "system";

export type ClanceConfig = {
  shortcuts: Record<string, string>;
  shortcutsConfigured: boolean;
  theme: ThemePreference;
};

const CONFIG_PATH = join(SESSION_CWD, "config.json");

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space" },
  shortcutsConfigured: false,
  theme: "system",
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
