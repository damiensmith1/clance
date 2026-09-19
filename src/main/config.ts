import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

export type ClanceConfig = {
  shortcuts: Record<string, string>;
  shortcutsConfigured: boolean;
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
  // The repository the Changes pane was last pointed at, so it comes back
  // where the user left it rather than guessing from the recents list every
  // launch. Null until they've opened the pane once.
  lastGitRepo: string | null;
  // Which of localToolsServer.ts's LOCAL_TOOLS the agent may use. Defaults
  // to "all" (opt-out) — these are Clance's own first-party tools
  // (screenshot, click, type), not arbitrary third-party skill
  // instructions, so there's no "not vetted for this" concern; a user
  // disables one they specifically don't want rather than needing to opt
  // into what's already there.
  enabledLocalTools: string[] | "all";
  dictation: DictationConfig;
};

// Dictation settings (see docs/design.md's "Dictation"). `activeModel` null means no
// model has been installed yet, which is what gates the feature — the
// shortcut stays registered either way so pressing it can explain itself
// rather than doing nothing.
export type DictationConfig = {
  activeModel: string | null;
  // "paste" synthesizes Cmd+V into the frontmost app (needs Accessibility);
  // "clipboard" only copies, for users who'd rather paste themselves or
  // haven't granted it.
  insertMode: "paste" | "clipboard";
  autoStopSilenceMs: number;
  maxDurationMs: number;
  // Off by default: audio is a recording of the user, kept only when they
  // explicitly want it for debugging.
  keepAudio: boolean;
  // Seeded into whisper's --prompt. Phase 0 found this recovers camelCase
  // identifiers and fixes src-vs-source, for ~90ms.
  vocabulary: string;
  // The microphone chosen in Settings, or null to follow macOS's default
  // input. Stored with its name as well as its id: the HUD matches by id, then
  // by name, since an id can change when a Bluetooth device is re-paired.
  inputDevice: { id: string; label: string } | null;
};

const CONFIG_PATH = join(SESSION_CWD, "config.json");

export const DEFAULT_VOCABULARY =
  "tsconfig.json, package.json, npm, npx, git, grep, ripgrep, src, dist, " +
  "node-pty, argv, stdout, stderr, Electron, TypeScript, JavaScript, " +
  "Python, xterm.js, SQLite, JSON, YAML, API, CLI, UI, IPC, repo, async, " +
  "await, const, refactor, Claude, Clance.";

const DEFAULT_DICTATION: DictationConfig = {
  activeModel: null,
  insertMode: "paste",
  autoStopSilenceMs: 1500,
  maxDurationMs: 5 * 60 * 1000,
  keepAudio: false,
  vocabulary: DEFAULT_VOCABULARY,
  inputDevice: null,
};

const DEFAULT_CONFIG: ClanceConfig = {
  shortcuts: { togglePopup: "Alt+Space", dictate: "Alt+D" },
  shortcutsConfigured: false,
  defaultDirectory: null,
  recentDirectories: [],
  lastGitRepo: null,
  enabledLocalTools: "all",
  dictation: DEFAULT_DICTATION,
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
      // Same shallow-merge hazard as `shortcuts` above: a config written
      // before a dictation setting existed would otherwise replace the
      // whole object and drop the new key's default.
      dictation: { ...DEFAULT_DICTATION, ...stored.dictation },
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
// a main-window session) so they can never drift out of sync with each other or with
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

// The Changes pane's repo, remembered across launches. Written whenever the
// switcher lands on a repo, not when it's merely offered one.
export function setLastGitRepo(root: string | null): void {
  const config = readConfig();
  config.lastGitRepo = root;
  writeConfig(config);
}
