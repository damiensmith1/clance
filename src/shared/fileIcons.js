import map from "./vendor/file-icons/map.js";

// Which icon a file or folder gets in the Files tree, by name — Material Icon
// Theme's own mapping (a subset of it, vendored by
// scripts/build-file-icons.mjs). The icons are SVG files drawn with <img>, so
// nothing in them can run.

function url(icon) {
  return new URL(`./vendor/file-icons/${icon}.svg`, import.meta.url).href;
}

/** The icon for a file: its exact name, then its longest known extension. */
export function fileIconUrl(name) {
  const lower = name.toLowerCase();
  if (map.fileNames[lower]) return url(map.fileNames[lower]);
  // "a.test.ts" tries "test.ts" before "ts"; ".env" is its own extension.
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i += 1) {
    const extension = parts.slice(i).join(".");
    if (map.fileExtensions[extension]) return url(map.fileExtensions[extension]);
  }
  return url(map.file);
}

export function folderIconUrl(name, open) {
  const lower = name.toLowerCase();
  const icon = open ? map.folderNamesExpanded[lower] ?? map.folderExpanded : map.folderNames[lower] ?? map.folder;
  return url(icon);
}
