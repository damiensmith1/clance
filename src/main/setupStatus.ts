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

  const isComplete =
    claude.installed &&
    claude.loggedIn &&
    permissions.screenRecording &&
    permissions.accessibility &&
    shortcutsConfigured;

  return { claude, permissions, shortcutsConfigured, isComplete };
}
