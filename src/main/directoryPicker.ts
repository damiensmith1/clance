import { dialog, BrowserWindow } from "electron";

// Shared by both the popup's "Open in... > New session in..." flow and
// Settings' default-directory field — a single native folder picker rather
// than two separate implementations. Anchored to whichever window actually
// triggered it (resolved by the caller via BrowserWindow.fromWebContents,
// same pattern as index.ts's "terminal:reparent" handler) so it opens as a
// proper sheet on that window instead of an unanchored dialog. Null if the
// user cancels.
export async function pickDirectory(parent: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}
