import { checkClaudeAuth, ClaudeAuthStatus } from "./claudeAuth";
import { checkPermissions, PermissionsStatus } from "./permissions";
import { readConfig } from "./config";

export type SetupStatus = {
  claude: ClaudeAuthStatus;
  permissions: PermissionsStatus;
  shortcutsConfigured: boolean;
  isComplete: boolean;
};

export async function getSetupStatus(): Promise<SetupStatus> {
  const claude = await checkClaudeAuth();
  const permissions = checkPermissions();
  const { shortcutsConfigured } = readConfig();

  // Screen Recording is deliberately not part of this. Since 2026-09-14
  // nothing is captured automatically — the screen is only read when a
  // session calls look_at_screen — so requiring it
  // meant a user who declined an optional capability couldn't use Clance at
  // all. Microphone is excluded for the same reason (dictation is optional).
  const isComplete =
    Boolean(process.env.CLANCE_FORCE_MAIN_WINDOW) ||
    (claude.installed && claude.loggedIn && permissions.accessibility && shortcutsConfigured);

  return { claude, permissions, shortcutsConfigured, isComplete };
}
