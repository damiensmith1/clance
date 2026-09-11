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
  // Working directory new Clance-created sessions open in — null means
  // "use SESSION_CWD" (see getDefaultDirectory below). Doesn't affect
  // resuming an existing session, which always inherits that session's own
  // recorded cwd (see chatHistory.ts's cwdForSessionId) regardless of this
  // setting.
  defaultDirectory: string | null;
  // Directories picked via the "Open in... > New session in..." flow,
  // most-recently-used first — lets that flow offer one-click reopen
  // without a fresh Finder dialog every time.
  recentDirectories: string[];
};

const CONFIG_PATH = join(SESSION_CWD, "config.json");

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space" },
  shortcutsConfigured: false,
  enabledSkills: [],
  defaultDirectory: null,
  recentDirectories: [],
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

// Single source of truth for "what directory should a brand-new
// Clance-created session open in" — used everywhere a session gets minted
// (the popup hotkey path, the background-agent pool, the main window's
// "New Chat") so they can never drift out of sync with each other or with
// what Settings actually shows the user.
export function getDefaultDirectory(): string {
  const configured = readConfig().defaultDirectory;
  return configured && configured.trim() ? configured : SESSION_CWD;
}

const MAX_RECENT_DIRECTORIES = 8;

// Most-recently-used first, deduped, capped — called whenever a "New
// session in..." open actually happens (not at pick-time), so re-opening
// an existing recent entry bumps it back to the top too.
export function addRecentDirectory(dir: string): void {
  const config = readConfig();
  const withoutDup = config.recentDirectories.filter((d) => d !== dir);
  config.recentDirectories = [dir, ...withoutDup].slice(0, MAX_RECENT_DIRECTORIES);
  writeConfig(config);
}
