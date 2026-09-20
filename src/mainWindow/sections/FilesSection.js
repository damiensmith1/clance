import { html, useEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";

// The Files explorer: a sidecar like Changes, and a reader like it too — it
// opens file tabs and never writes. Where Changes is a monitor of one
// repository, this browses any folder on the machine, which is the point of
// it: ⌘P needs you to know a filename already, and looking around a project
// is a different act from recalling one.
//
// Nothing here walks a tree. Expanding a directory asks the main process for
// that one level (files.ts), so a folder nobody has opened costs nothing.
//
// Which directories are open is kept per folder in `cache`, module-level, so
// closing the tab and opening it again lands where it was left. It doesn't
// survive a relaunch; persisting it would mean a new store, and the layout
// file already restores which tabs are open rather than what's inside them.
const cache = new Map();

function cacheFor(root) {
  let entry = cache.get(root);
  if (!entry) {
    entry = { expanded: new Set(), selected: null };
    cache.set(root, entry);
  }
  return entry;
}

function homeShort(path) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function FilesSection({ onOpenFile }) {
  const [folders, setFolders] = useState([]);
  const [root, setRoot] = useState(null);
  // path → the listing of that directory. "" is the chosen folder itself.
  const [dirs, setDirs] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [selected, setSelected] = useState(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [menu, setMenu] = useState(false);
  const [repo, setRepo] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  const rootRef = useRef(null);
  const switcherRef = useRef(null);
  const listRef = useRef(null);

  // ---- loading ----

  async function loadDir(targetRoot, path, ignored) {
    const listing = await window.clanceApp.filesListDirectory(targetRoot, path, ignored);
    // A folder switched while this was in flight loses — otherwise the old
    // folder's listing lands on top of the new one's.
    if (rootRef.current !== targetRoot) return;
    setDirs((current) => {
      const next = new Map(current);
      next.set(path, listing ?? { path, entries: [], error: "Folder could not be read", ignoreUnknown: false });
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, last] = await Promise.all([
        window.clanceApp.filesListFolders(),
        window.clanceApp.filesGetLastFolder(),
      ]);
      if (cancelled) return;
      setFolders(list ?? []);
      const start = last ?? (list && list.length > 0 ? list[0].root : null);
      setRoot(start);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    rootRef.current = root;
    if (!root) return;
    const saved = cacheFor(root);
    setExpanded(new Set(saved.expanded));
    setSelected(saved.selected);
    setDirs(new Map());
    setError(null);
    window.clanceApp.filesSetLastFolder(root);
    window.clanceApp.filesFolderRepo(root).then((found) => {
      if (rootRef.current === root) setRepo(found ?? null);
    });
    // The folder itself, plus every directory that was left open.
    loadDir(root, "", showIgnored);
    for (const path of saved.expanded) loadDir(root, path, showIgnored);
  }, [root]);

  // Showing or hiding ignored files changes every listing, not just the next.
  useEffect(() => {
    if (!root) return;
    for (const path of [...dirs.keys()]) loadDir(root, path, showIgnored);
  }, [showIgnored]);

  useEffect(() => {
    if (!root) return;
    const saved = cacheFor(root);
    saved.expanded = new Set(expanded);
    saved.selected = selected;
  }, [root, expanded, selected]);

  useEffect(() => {
    if (!menu) return;
    function onDown(event) {
      if (switcherRef.current && !switcherRef.current.contains(event.target)) setMenu(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setMenu(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // ---- the visible rows ----

  // The tree flattened to what's on screen: a directory contributes its own
  // row, and its children only while it's open.
  const rows = useMemo(() => {
    const out = [];
    (function walk(path, depth) {
      const listing = dirs.get(path);
      if (!listing) return;
      for (const entry of listing.entries) {
        out.push({ ...entry, depth });
        if (entry.directory && !entry.symlink && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    })("", 0);
    return out;
  }, [dirs, expanded]);

  const rootListing = dirs.get("");

  // ---- acting ----

  function toggleDir(entry) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (!dirs.has(entry.path)) loadDir(root, entry.path, showIgnored);
      }
      return next;
    });
  }

  async function openFile(entry) {
    setSelected(entry.path);
    const resolved = await window.clanceApp.filesResolveFile(root, entry.path);
    if (!resolved) {
      setError(`${entry.name} could not be opened`);
      return;
    }
    setError(null);
    onOpenFile(resolved.root, resolved.path);
  }

  function activate(entry) {
    if (entry.directory && !entry.symlink) toggleDir(entry);
    else openFile(entry);
  }

  async function browseForFolder() {
    setMenu(false);
    const dir = await window.clanceApp.pickDirectory();
    if (!dir) return;
    const resolved = await window.clanceApp.filesSetLastFolder(dir);
    if (!resolved) {
      setError("That folder could not be opened");
      return;
    }
    setFolders((current) =>
      current.some((folder) => folder.root === resolved)
        ? current
        : [...current, { root: resolved, name: resolved.split("/").filter(Boolean).pop() }]
    );
    setRoot(resolved);
  }

  // ---- keyboard ----

  function onKeyDown(event) {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.path === selected);
    const entry = index >= 0 ? rows[index] : null;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(rows[Math.min(index + 1, rows.length - 1)]?.path ?? rows[0].path);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(rows[Math.max(index - 1, 0)]?.path ?? rows[0].path);
    } else if (event.key === "ArrowRight") {
      if (!entry) return;
      event.preventDefault();
      // Open a closed directory; step into an open one. On a file, nothing —
      // there is nowhere further right to go.
      if (entry.directory && !entry.symlink && !expanded.has(entry.path)) toggleDir(entry);
      else if (entry.directory && rows[index + 1]?.depth > entry.depth) setSelected(rows[index + 1].path);
    } else if (event.key === "ArrowLeft") {
      if (!entry) return;
      event.preventDefault();
      // Close an open directory, or jump to the parent of whatever this is.
      if (entry.directory && expanded.has(entry.path)) {
        toggleDir(entry);
      } else {
        for (let i = index - 1; i >= 0; i -= 1) {
          if (rows[i].depth < entry.depth) {
            setSelected(rows[i].path);
            break;
          }
        }
      }
    } else if (event.key === "Enter") {
      if (!entry) return;
      event.preventDefault();
      activate(entry);
    }
  }

  useEffect(() => {
    if (!selected || !listRef.current) return;
    const row = listRef.current.querySelector('[data-selected="true"]');
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ---- render ----

  if (!root && loaded) {
    return html`
      <div class="files-pane">
        <div class="files-blank">
          <p>No folder yet.</p>
          <button class="btn-secondary btn-small" onClick=${browseForFolder}>Choose folder…</button>
        </div>
      </div>
    `;
  }

  const folderName = folders.find((f) => f.root === root)?.name ?? root?.split("/").filter(Boolean).pop() ?? "";

  return html`
    <div class="files-pane">
      <header class="files-bar">
        <div class="files-folder" ref=${switcherRef}>
          <button class="files-folder-button" title="Switch folder" onClick=${() => setMenu((open) => !open)}>
            ${Icon.folder(13)}
            <span class="files-folder-name">${folderName}</span>
          </button>
          ${repo && html`<span class="files-repo-hint" title=${`Inside the repository at ${homeShort(repo)}`}>repo</span>`}
          ${menu &&
          html`
            <div class="menu files-switcher">
              <div class="menu-label">folder</div>
              ${folders.map(
                (folder) => html`
                  <button
                    class="menu-item ${folder.root === root ? "menu-item-active" : ""}"
                    onClick=${() => {
                      setMenu(false);
                      if (folder.root !== root) setRoot(folder.root);
                    }}
                  >
                    <span class="menu-item-title">${folder.name}</span>
                    <span class="menu-item-detail">${homeShort(folder.root)}</span>
                  </button>
                `
              )}
              <button class="menu-item" onClick=${browseForFolder}>Choose folder…</button>
            </div>
          `}
        </div>
        ${repo &&
        html`<button
          class="btn-quiet btn-small files-ignored-toggle ${showIgnored ? "is-on" : ""}"
          title=${showIgnored ? "Hide files git ignores" : "Show files git ignores"}
          onClick=${() => setShowIgnored((on) => !on)}
        >
          ${showIgnored ? "all" : "tracked"}
        </button>`}
      </header>

      ${error && html`<div class="files-error">${error}</div>`}
      ${rootListing?.ignoreUnknown &&
      html`<div class="files-error">
        git couldn't read this repository's ignore rules, so everything is listed.
      </div>`}
      ${rootListing?.error && html`<div class="files-error">${rootListing.error}</div>`}

      <div class="files-tree" ref=${listRef} tabIndex="0" onKeyDown=${onKeyDown}>
        ${rows.map(
          (entry) => html`
            <button
              key=${entry.path}
              class="files-row ${entry.ignored ? "files-row-ignored" : ""}"
              data-selected=${entry.path === selected ? "true" : "false"}
              style=${`padding-left: ${6 + entry.depth * 11}px`}
              title=${entry.symlink ? `${entry.name} — a link, which the tree doesn't follow` : entry.name}
              onClick=${() => {
                setSelected(entry.path);
                activate(entry);
              }}
            >
              <span class="files-row-twist">
                ${entry.directory && !entry.symlink
                  ? html`<span class="files-chevron ${expanded.has(entry.path) ? "is-open" : ""}"
                      >${Icon.chevronRight(11)}</span
                    >`
                  : ""}
              </span>
              <span class="files-row-icon">
                ${entry.directory && !entry.symlink
                  ? expanded.has(entry.path)
                    ? Icon.folderOpen(13)
                    : Icon.folder(13)
                  : Icon.file(13)}
              </span>
              <span class="files-row-name">${entry.name}</span>
              ${entry.symlink && html`<span class="files-row-tag">link</span>`}
            </button>
          `
        )}
        ${loaded && rootListing && rows.length === 0 && !rootListing.error
          ? html`<div class="files-empty">Nothing here.</div>`
          : ""}
      </div>
    </div>
  `;
}
