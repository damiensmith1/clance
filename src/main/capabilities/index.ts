// Everything Clance can do to the Mac, with no opinion about who asked.
//
// Two callers sit on top: localToolsServer.ts wraps these as MCP tools for a
// Claude Code session, and assistant/ calls them from a resolved spoken
// command. Neither owns them, which is the point — a capability added here
// is available to both, and the prose it returns is written once.
export { type Outcome, isImage } from "./types";
export { type ReadTarget, resolveReadTarget, unpublishedMessage } from "./target";
export { listOpenWindows, activateApp } from "./apps";
export { lookAtScreen, clickAt } from "./screen";
export { chord, pressEnter, type Chord } from "./keys";
export { typeText, searchWeb, findHere } from "./text";
export {
  type Page,
  type PageElement,
  type BrowserBlocked,
  isBrowser,
  readPage,
  clickElementInPage,
  typeInPage,
  openUrl,
} from "./browser";
export { SITES, spokenUrl, openSite } from "./sites";
export { readFocusedField, readWindowText, readSelection } from "./read";
export { writeField, type WriteMode } from "./write";
export {
  clickElement,
  listControls,
  listFields,
  forgetWindowTree,
  pressControl,
  focusField,
  labelOf,
  type Control,
} from "./controls";
export {
  type MenuCommand,
  menuCommands,
  currentMenuCommands,
  invalidateMenuCache,
  pressMenuCommand,
} from "./menu";
export { type InstalledApp, installedApps, forgetInstalledApps, launchApp, quitApp } from "./launch";
export { type NavigateVerb, navigate, NAVIGATE_INVERSE } from "./navigate";
export {
  type Arrangement,
  type WindowMove,
  ARRANGEMENT_LABELS,
  arrangeWindow,
  restoreWindow,
} from "./windows";
