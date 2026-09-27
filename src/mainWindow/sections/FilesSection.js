import { html, useEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { MenuItem } from "./ChatsSection.js";
import { useTabState, useTabScroll } from "../state/tabState.js";

// The Files explorer: a narrow pane like Changes, browsing any folder on the
// machine — ⌘P needs you to know a filename already, and looking around a
// project is a different act from recalling one. It opens file tabs, and it
// creates, renames, moves, duplicates and trashes; every one of those is
// checked in the main process (fileOps.ts), not here.
//
// Nothing here walks a tree. Expanding a directory asks the main process for
// that one level (files.ts), so a folder nobody has opened costs nothing. The
// tree re-reads what's open after its own changes and whenever the window
// comes back to the front, since sessions create files too.
//
// Which directories are open, what's selected and the listings already read
// are kept per folder as the tab's state (state/tabState.js), so moving the
// tab or switching away and back redraws the tree at once and re-reads it
// quietly, rather than starting from a blank folder.

function homeShort(path) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function parentOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

const DRAG_THRESHOLD_PX = 4;

export function FilesSection({ onOpenFile, onPathMoved, onOpenTerminal, onAskClaude }) {
  const [byRoot] = useTabState("files.byRoot", () => new Map());
  function cacheFor(folder) {
    if (!byRoot.has(folder)) byRoot.set(folder, { expanded: new Set(), selected: null, dirs: new Map() });
    return byRoot.get(folder);
  }
  const [folders, setFolders] = useTabState("files.folders", []);
  const [root, setRoot] = useTabState("files.root", null);
  const initial = root ? byRoot.get(root) ?? null : null;
  // path → the listing of that directory. "" is the chosen folder itself.
  const [dirs, setDirs] = useState(() => initial?.dirs ?? new Map());
  const [expanded, setExpanded] = useState(() => new Set(initial?.expanded ?? []));
  const [selected, setSelected] = useState(initial?.selected ?? null);
  // On by default: the tree is for looking around a folder, and a build
  // output or a local scratch file is as much in it as a tracked one.
  // Ignored rows are dimmed rather than hidden, and the toggle hides them.
  const [showIgnored, setShowIgnored] = useTabState("files.showIgnored", true, { persist: true });
  const [menu, setMenu] = useState(false);
  const [repo, setRepo] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  // { entry | null, x, y } — the right-click menu. A null entry is the
  // folder itself (a click on empty space).
  const [rowMenu, setRowMenu] = useState(null);
  // An inline name field: { kind: "rename", path, value } or
  // { kind: "file" | "folder", parent, value }.
  const [editing, setEditing] = useState(null);
  // A Finder drop whose names are taken: { dest, sources, conflicts }.
  const [pendingDrop, setPendingDrop] = useState(null);
  // A tree drag in progress: { path, target } (target: a directory path, or
  // "" for the folder itself, or null when not over anywhere it can go).
  const [dragging, setDragging] = useState(null);
  const [dropHover, setDropHover] = useState(null);

  const rootRef = useRef(null);
  const switcherRef = useRef(null);
  const listRef = useRef(null);
  useTabScroll(listRef, root ? "files.tree" : null, { version: root });
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  // ---- loading ----

  async function loadDir(targetRoot, path, ignored) {
    const listing = await window.clanceApp.filesListDirectory(targetRoot, path, ignored);
    // A folder switched while this was in flight loses — otherwise the old
    // folder's listing lands on top of the new one's.
    if (rootRef.current !== targetRoot) return;
    setDirs((current) => {
      const next = new Map(current);
      if (!listing && path !== "") next.delete(path);
      else next.set(path, listing ?? { path, entries: [], error: "Folder could not be read", ignoreUnknown: false });
      return next;
    });
  }

  function reloadOpen() {
    if (!root) return;
    for (const path of [...dirsRef.current.keys()]) loadDir(root, path, showIgnored);
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
      setLoaded(true);
      // Coming back to a tab that already had a folder keeps it.
      if (root) return;
      setRoot(last ?? (list && list.length > 0 ? list[0].root : null));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    rootRef.current = root;
    if (!root) return;
    // A folder seen before comes back as it was, then re-reads; a new one
    // starts empty.
    const saved = cacheFor(root);
    setExpanded(new Set(saved.expanded));
    setSelected(saved.selected);
    setDirs(new Map(saved.dirs));
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
    reloadOpen();
  }, [showIgnored]);

  // A folder opened from Finder or `clance` while the tree is already open.
  useEffect(() => {
    function onFolder(event) {
      const dir = event.detail;
      setFolders((current) =>
        current.some((folder) => folder.root === dir) ? current : [...current, { root: dir, name: dir.split("/").filter(Boolean).pop() }]
      );
      setRoot(dir);
    }
    window.addEventListener("clance:files-folder", onFolder);
    return () => window.removeEventListener("clance:files-folder", onFolder);
  }, []);

  // Sessions create and delete files too; the tree catches up whenever the
  // window comes back to the front.
  useEffect(() => {
    const onFocus = () => reloadOpen();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [root, showIgnored]);

  useEffect(() => {
    if (!root) return;
    const saved = cacheFor(root);
    saved.expanded = new Set(expanded);
    saved.selected = selected;
    saved.dirs = dirs;
  }, [root, expanded, selected, dirs]);

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

  useEffect(() => {
    if (!rowMenu) return;
    function onDown(event) {
      if (!event.target.closest?.(".files-row-menu")) setRowMenu(null);
    }
    function onKey(event) {
      if (event.key === "Escape") setRowMenu(null);
    }
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [rowMenu]);

  // ---- the visible rows ----

  // The tree flattened to what's on screen: a directory contributes its own
  // row, and its children only while it's open. A new-file field sits first
  // among its parent's children.
  const rows = useMemo(() => {
    const out = [];
    (function walk(path, depth) {
      if (editing && editing.kind !== "rename" && editing.parent === path) out.push({ creating: true, depth, path: "\0new" });
      const listing = dirs.get(path);
      if (!listing) return;
      for (const entry of listing.entries) {
        out.push({ ...entry, depth });
        if (entry.directory && !entry.symlink && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    })("", 0);
    return out;
  }, [dirs, expanded, editing]);

  const rootListing = dirs.get("");

  // ---- acting ----

  function expand(path) {
    setExpanded((current) => {
      if (current.has(path)) return current;
      const next = new Set(current);
      next.add(path);
      return next;
    });
    if (!dirs.has(path)) loadDir(root, path, showIgnored);
  }

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

  // ---- writing ----

  /** The directory a new entry goes into, given what was clicked. */
  function dirFor(entry) {
    if (!entry) return "";
    return entry.directory && !entry.symlink ? entry.path : parentOf(entry.path);
  }

  function absolute(path) {
    return path ? `${root}/${path}` : root;
  }

  function startCreate(kind, entry) {
    const parent = dirFor(entry);
    if (parent) expand(parent);
    setEditing({ kind, parent, value: "" });
  }

  function startRename(entry) {
    setSelected(entry.path);
    setEditing({ kind: "rename", path: entry.path, value: entry.name });
  }

  function report(result) {
    if (result.ok) {
      setError(null);
      return true;
    }
    setError(result.error);
    return false;
  }

  // The field's own value, not state: a keystroke and Enter can land before
  // the re-render that would carry the last character into state.
  async function commitEditing(value) {
    const current = editing;
    setEditing(null);
    const name = (value ?? current?.value)?.trim();
    if (!current || !name) return;
    if (current.kind === "rename") {
      const oldName = current.path.split("/").pop();
      if (name === oldName) return;
      const result = await window.clanceApp.filesRename(root, current.path, name);
      if (report(result)) {
        onPathMoved?.(absolute(current.path), absolute(result.path));
        setSelected(result.path);
      }
      loadDir(root, parentOf(current.path), showIgnored);
      return;
    }
    const result = await window.clanceApp.filesCreate(root, current.parent, name, current.kind);
    loadDir(root, current.parent, showIgnored);
    if (!report(result)) return;
    setSelected(result.path);
    if (current.kind === "file") {
      const resolved = await window.clanceApp.filesResolveFile(root, result.path);
      if (resolved) onOpenFile(resolved.root, resolved.path);
    }
  }

  async function duplicate(entry) {
    const result = await window.clanceApp.filesDuplicate(root, entry.path);
    loadDir(root, parentOf(entry.path), showIgnored);
    if (report(result)) setSelected(result.path);
  }

  // To the Trash, which is its own undo. An open tab on the file stays, and
  // says the file is gone.
  async function trash(entry) {
    const result = await window.clanceApp.filesTrash(root, entry.path);
    loadDir(root, parentOf(entry.path), showIgnored);
    report(result);
  }

  async function move(path, destDir) {
    if (parentOf(path) === destDir) return;
    const result = await window.clanceApp.filesMove(root, path, destDir);
    loadDir(root, parentOf(path), showIgnored);
    loadDir(root, destDir, showIgnored);
    if (report(result)) {
      onPathMoved?.(absolute(path), absolute(result.path));
      if (destDir) expand(destDir);
      setSelected(result.path);
    }
  }

  async function copyIn(dest, sources, onConflict) {
    const result = await window.clanceApp.filesCopyIn(root, dest, sources, onConflict);
    if (!result.ok && result.conflicts) {
      setPendingDrop({ dest, sources, conflicts: result.conflicts });
      return;
    }
    setPendingDrop(null);
    if (dest) expand(dest);
    loadDir(root, dest, showIgnored);
    if (report(result) && result.paths.length > 0) setSelected(result.paths[result.paths.length - 1]);
  }

  // ---- drag within the tree (pointer events, like tabs — see "Panes") ----

  function startRowDrag(event, entry) {
    if (event.button !== 0 || editing) return;
    const target = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let over = null;

    function targetAt(x, y) {
      const element = document.elementFromPoint(x, y);
      const row = element?.closest?.(".files-row[data-path]");
      if (row) {
        const path = row.dataset.path;
        const dest = row.dataset.dir === "true" ? path : parentOf(path);
        // Not onto itself or into its own subtree.
        if (dest === entry.path || dest.startsWith(`${entry.path}/`)) return null;
        return dest;
      }
      return element?.closest?.(".files-tree") ? "" : null;
    }

    function onMove(e) {
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
        active = true;
      }
      over = targetAt(e.clientX, e.clientY);
      setDragging({ path: entry.path, target: over });
    }
    // Listened for on the window, not the row: the row can leave the page
    // mid-gesture (the tree re-reads after a delete or a session's changes),
    // and a release it never hears would leave the tree stuck mid-drag.
    function end() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      setDragging(null);
    }
    function onUp() {
      end();
      if (active && over !== null) move(entry.path, over);
      else if (!active && target.isConnected) {
        setSelected(entry.path);
        activate(entry);
      }
    }
    function onCancel() {
      over = null;
      active = true;
      end();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  }

  // ---- drops from Finder (native: they come from outside the window) ----

  // A Finder drag can end anywhere — dropped elsewhere, cancelled, taken out
  // of the window — and not every ending reaches the tree, so any ending
  // clears the highlight.
  useEffect(() => {
    const clear = () => setDropHover(null);
    // Leaving the window has no element to go to.
    const onLeave = (event) => {
      if (!event.relatedTarget) clear();
    };
    window.addEventListener("drop", clear);
    window.addEventListener("dragend", clear);
    window.addEventListener("blur", clear);
    document.addEventListener("dragleave", onLeave);
    return () => {
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("blur", clear);
      document.removeEventListener("dragleave", onLeave);
    };
  }, []);

  function dropTargetOf(event) {
    const row = event.target.closest?.(".files-row[data-path]");
    if (!row) return "";
    return row.dataset.dir === "true" ? row.dataset.path : parentOf(row.dataset.path);
  }

  function onDragOver(event) {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropHover(dropTargetOf(event));
  }

  function onDrop(event) {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    const dest = dropTargetOf(event);
    setDropHover(null);
    const sources = [...event.dataTransfer.files].map((file) => window.clanceApp.getPathForFile(file)).filter(Boolean);
    if (sources.length) copyIn(dest, sources, "ask");
  }

  // ---- keyboard ----

  function onKeyDown(event) {
    if (editing) return;
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
    } else if (event.key === "F2") {
      if (!entry) return;
      event.preventDefault();
      startRename(entry);
    } else if (event.key === "Backspace" && event.metaKey) {
      if (!entry) return;
      event.preventDefault();
      trash(entry);
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

  function openRowMenu(event, entry) {
    event.preventDefault();
    event.stopPropagation();
    if (entry) setSelected(entry.path);
    setRowMenu({
      entry,
      x: Math.min(event.clientX, window.innerWidth - 250),
      y: Math.min(event.clientY, window.innerHeight - 440),
    });
  }

  function renderRowMenu() {
    const { entry } = rowMenu;
    const act = (fn) => () => {
      setRowMenu(null);
      fn();
    };
    const abs = absolute(entry?.path ?? "");
    const folder = entry ? (entry.directory && !entry.symlink ? abs : absolute(parentOf(entry.path))) : root;
    return html`
      <div class="menu context-menu files-row-menu" role="menu" style=${{ left: `${rowMenu.x}px`, top: `${rowMenu.y}px` }}>
        <${MenuItem} title="New File" onSelect=${act(() => startCreate("file", entry))} />
        <${MenuItem} title="New Folder" onSelect=${act(() => startCreate("folder", entry))} />
        ${entry &&
        html`
          <div class="menu-separator"></div>
          <${MenuItem} title="Rename" shortcut="F2" onSelect=${act(() => startRename(entry))} />
          <${MenuItem} title="Duplicate" onSelect=${act(() => duplicate(entry))} />
          <${MenuItem} title="Move to Trash" shortcut="⌘⌫" onSelect=${act(() => trash(entry))} />
        `}
        <div class="menu-separator"></div>
        <${MenuItem} title="Copy Path" onSelect=${act(() => navigator.clipboard.writeText(abs))} />
        ${entry && html`<${MenuItem} title="Copy Relative Path" onSelect=${act(() => navigator.clipboard.writeText(entry.path))} />`}
        <${MenuItem}
          title="Reveal in Finder"
          onSelect=${act(() => (entry && !(entry.directory && !entry.symlink) ? window.clanceApp.revealFile(abs) : window.clanceApp.revealFolder(abs)))}
        />
        <${MenuItem} title="Open in Terminal" onSelect=${act(() => onOpenTerminal?.(folder))} />
        ${onAskClaude && html`<${MenuItem} title="Ask Claude About This" onSelect=${act(() => onAskClaude({ path: abs, directory: !entry || entry.directory }))} />`}
      </div>
    `;
  }

  function renderNameField(depth) {
    return html`
      <div class="files-row files-row-editing" style=${`padding-left: ${6 + depth * 11}px`}>
        <span class="files-row-twist"></span>
        <span class="files-row-icon">${editing.kind === "folder" ? Icon.folder(13) : Icon.file(13)}</span>
        <input
          class="files-name-input"
          value=${editing.value}
          ref=${(el) => {
            if (el && document.activeElement !== el) {
              el.focus();
              // Select the name without its extension, as Finder does.
              const dot = el.value.lastIndexOf(".");
              el.setSelectionRange(0, editing.kind === "rename" && dot > 0 ? dot : el.value.length);
            }
          }}
          onInput=${(e) => setEditing((current) => current && { ...current, value: e.target.value })}
          onKeyDown=${(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitEditing(e.target.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(null);
            }
          }}
          onBlur=${() => setEditing(null)}
        />
      </div>
    `;
  }

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
        <span class="files-bar-actions">
          <button
            class="btn-quiet btn-small files-bar-button"
            title="New File"
            onClick=${() => startCreate("file", rows.find((row) => row.path === selected && row.directory) ?? null)}
          >
            ${Icon.file(13)}<span>+</span>
          </button>
          <button
            class="btn-quiet btn-small files-bar-button"
            title="New Folder"
            onClick=${() => startCreate("folder", rows.find((row) => row.path === selected && row.directory) ?? null)}
          >
            ${Icon.folder(13)}<span>+</span>
          </button>
          ${repo &&
          html`<button
            class="btn-quiet btn-small files-ignored-toggle ${showIgnored ? "is-on" : ""}"
            title=${showIgnored ? "Hide files git ignores" : "Show files git ignores"}
            onClick=${() => setShowIgnored((on) => !on)}
          >
            ${showIgnored ? "all" : "tracked"}
          </button>`}
        </span>
      </header>

      ${error && html`<div class="files-error">${error}</div>`}
      ${pendingDrop &&
      html`
        <div class="files-error files-conflict">
          <span>
            ${pendingDrop.conflicts.length === 1
              ? `“${pendingDrop.conflicts[0]}” already exists here.`
              : `${pendingDrop.conflicts.length} of these already exist here.`}
          </span>
          <span class="files-conflict-actions">
            <button class="btn-quiet btn-small" onClick=${() => copyIn(pendingDrop.dest, pendingDrop.sources, "replace")}>Replace</button>
            <button class="btn-quiet btn-small" onClick=${() => copyIn(pendingDrop.dest, pendingDrop.sources, "keep-both")}>Keep Both</button>
            <button class="btn-quiet btn-small" onClick=${() => setPendingDrop(null)}>Cancel</button>
          </span>
        </div>
      `}
      ${rootListing?.ignoreUnknown &&
      html`<div class="files-error">
        git couldn't read this repository's ignore rules, so everything is listed.
      </div>`}
      ${rootListing?.error && html`<div class="files-error">${rootListing.error}</div>`}

      <div
        class="files-tree ${dropHover === "" || dragging?.target === "" ? "files-tree-drop" : ""}"
        ref=${listRef}
        tabIndex="0"
        onKeyDown=${onKeyDown}
        onContextMenu=${(e) => openRowMenu(e, null)}
        onDragOver=${onDragOver}
        onDragLeave=${(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDropHover(null);
        }}
        onDrop=${onDrop}
      >
        ${rows.map((entry) => {
          if (entry.creating) return renderNameField(entry.depth);
          if (editing?.kind === "rename" && editing.path === entry.path) return renderNameField(entry.depth);
          const isDir = entry.directory && !entry.symlink;
          const dropTarget = (dragging && dragging.target === entry.path && isDir) || (dropHover === entry.path && isDir);
          return html`
            <button
              key=${entry.path}
              class="files-row ${entry.ignored ? "files-row-ignored" : ""} ${dropTarget ? "files-row-drop" : ""} ${
                dragging?.path === entry.path ? "files-row-dragging" : ""
              }"
              data-path=${entry.path}
              data-dir=${isDir ? "true" : "false"}
              data-selected=${entry.path === selected ? "true" : "false"}
              style=${`padding-left: ${6 + entry.depth * 11}px`}
              title=${entry.symlink ? `${entry.name} — a link, which the tree doesn't follow` : entry.name}
              onPointerDown=${(e) => startRowDrag(e, entry)}
              onContextMenu=${(e) => openRowMenu(e, entry)}
            >
              <span class="files-row-twist">
                ${isDir
                  ? html`<span class="files-chevron ${expanded.has(entry.path) ? "is-open" : ""}"
                      >${Icon.chevronRight(11)}</span
                    >`
                  : ""}
              </span>
              <span class="files-row-icon">
                ${isDir ? (expanded.has(entry.path) ? Icon.folderOpen(13) : Icon.folder(13)) : Icon.file(13)}
              </span>
              <span class="files-row-name">${entry.name}</span>
              ${entry.symlink && html`<span class="files-row-tag">link</span>`}
            </button>
          `;
        })}
        ${loaded && rootListing && rows.length === 0 && !rootListing.error
          ? html`<div class="files-empty">Nothing here. Right-click to create a file, or drop one in from Finder.</div>`
          : ""}
      </div>
      ${rowMenu && renderRowMenu()}
    </div>
  `;
}
