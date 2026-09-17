import { html, useEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon, Logo } from "../../shared/icons.js";

// No Node `path` module in the renderer (contextIsolation) — a directory
// picked via the native folder dialog is always a plain forward-slash
// absolute path on macOS, so a simple split covers it. Same helper as
// popup.js's dirBasename — small enough that duplicating it here beats
// introducing a shared util module for one three-line function.
function dirBasename(dir) {
  const segments = dir.split("/").filter(Boolean);
  return segments[segments.length - 1] || dir;
}

// Home-relative for display: /Users/name/projects → ~/projects.
function tildePath(dir) {
  return dir.replace(/^\/Users\/[^/]+/, "~");
}

// How often the live rows re-poll `claude agents --json` while this
// section is mounted — live state can change between visits, and a session
// can end from elsewhere (another Clance window, a bare terminal, Remote
// Control) without Clance ever hearing about it directly.
const ACTIVE_POLL_MS = 5000;
const TOAST_MS = 5000;
const COMMAND_MATCHES = 5;
const COMMAND_RECENT_DIRS = 3;

const FILTERS = [
  { id: "all", label: "All sessions" },
  { id: "running", label: "Running" },
  { id: "closed", label: "Closed" },
  { id: "archived", label: "Archived" },
];

// Short and mono, for the table's "updated" column: now, 12m, 3h, 4d, then
// a date.
function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// A live agent's state word and tone, from `claude agents --json`: `state`
// is working | blocked | done | failed | stopped, `status` is busy | idle.
// "blocked" is Claude Code waiting on the user.
function agentState(agent) {
  switch (agent.state) {
    case "working":
      return { label: "working", tone: "live" };
    case "blocked":
      return { label: "needs you", tone: "attention" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "done":
      return { label: "done", tone: "ok" };
    default:
      return agent.status === "busy"
        ? { label: "working", tone: "live" }
        : { label: agent.state || agent.status || "running", tone: "plain" };
  }
}

// True when a keystroke belongs to something else on screen: a text field,
// or a terminal (xterm's hidden textarea).
function typingElsewhere(target) {
  return Boolean(target?.closest?.("input, textarea, [contenteditable], .xterm"));
}

function SessionTableHead() {
  return html`
    <div class="session-table-head" aria-hidden="true">
      <span></span>
      <span>session</span>
      <span>project</span>
      <span>state</span>
      <span class="session-updated">updated</span>
      <span></span>
    </div>
  `;
}

function SkeletonRows() {
  return [320, 250, 380, 210, 290].map(
    (width) => html`
      <div class="session-row session-row-skeleton" aria-hidden="true">
        <span></span>
        <span class="skeleton" style=${{ width: `${width}px` }}></span>
        <span class="skeleton" style=${{ width: "80px" }}></span>
        <span></span>
        <span class="skeleton skeleton-short"></span>
        <span></span>
      </div>
    `
  );
}

function SessionRow({ row, selected, onOpen, onContextMenu, onPopOut, onArchiveOrStop }) {
  const showDot = row.tone === "live" || row.tone === "attention" || row.tone === "danger";
  return html`
    <div
      class="session-row ${selected ? "session-row-selected" : ""}"
      role="button"
      tabindex="0"
      aria-selected=${selected}
      data-row-key=${row.key}
      onClick=${onOpen}
      onContextMenu=${onContextMenu}
      onKeyDown=${(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <span class="session-lead">
        ${showDot &&
        html`<span class="status-dot ${row.tone === "live" ? "status-dot-live" : ""} session-dot-${row.tone}"></span>`}
      </span>
      <span class="session-title">${row.title}</span>
      <span class="session-project">${row.project}</span>
      <span class="session-state session-state-${row.tone}">${row.state}</span>
      <span class="session-updated">${row.updated}</span>
      <span class="session-actions">
        <button
          class="icon-button session-row-action"
          title="Open in floating window"
          aria-label="Open in floating window"
          onClick=${(e) => {
            e.stopPropagation();
            onPopOut();
          }}
        >
          ${Icon.popOut(14)}
        </button>
        ${row.kind === "archived"
          ? html`
              <button
                class="btn-quiet btn-small session-row-action"
                onClick=${(e) => {
                  e.stopPropagation();
                  onArchiveOrStop();
                }}
              >
                Restore
              </button>
            `
          : html`
              <button
                class="icon-button session-row-action"
                title=${row.kind === "live" ? "Stop session" : "Archive"}
                aria-label=${row.kind === "live" ? "Stop session" : "Archive"}
                onClick=${(e) => {
                  e.stopPropagation();
                  onArchiveOrStop();
                }}
              >
                ${row.kind === "live" ? Icon.close(14) : Icon.archive(14)}
              </button>
            `}
      </span>
    </div>
  `;
}

// A menu item: title, optional right-aligned mono detail and shortcut.
// mousedown is swallowed so clicking an item doesn't blur the search field
// (which would close the command menu before the click lands).
function MenuItem({ title, detail, shortcut, active, onSelect }) {
  return html`
    <button
      class="menu-item ${active ? "menu-item-active" : ""}"
      role="menuitem"
      onMouseDown=${(e) => e.preventDefault()}
      onClick=${onSelect}
    >
      <span class="menu-item-title">${title}</span>
      <span class="menu-item-detail">${detail ?? ""}</span>
      ${shortcut && html`<span class="menu-shortcut">${shortcut}</span>`}
    </button>
  `;
}

export function ChatsListSection({ onOpenChat, onNewChat }) {
  const [sessions, setSessions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [selectedKey, setSelectedKey] = useState(null);
  const [recentDirs, setRecentDirs] = useState([]);
  const [defaultDirectory, setDefaultDirectory] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [toast, setToast] = useState(null);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    window.clanceApp.listChatSessions().then((result) => {
      setSessions(result);
      setLoading(false);
    });
    Promise.all([window.clanceApp.getRecentDirectories(), window.clanceApp.getPreferences()]).then(
      ([dirs, prefs]) => {
        setRecentDirs(dirs ?? []);
        setDefaultDirectory(prefs?.defaultDirectory ?? null);
      }
    );
    return () => clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      window.clanceApp.listAgents().then((result) => {
        if (!cancelled) setAgents(result);
      });
    }
    poll();
    const interval = setInterval(poll, ACTIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const liveSessionIds = useMemo(() => new Set(agents.map((a) => a.sessionId)), [agents]);

  // Every Clance-minted agent gets a generic mint-time name ("New Chat",
  // "Clance popup") since there's no real conversation yet to title it
  // from. Once one exists, prefer the same first-user-message title
  // chatHistory.ts derives for closed sessions, so a live row reads the same
  // way it will once it closes. Falls back to the mint-time name for a
  // session too new to have a transcript title yet.
  const sessionTitleById = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions]);
  function displayNameFor(agent) {
    return sessionTitleById.get(agent.sessionId) || agent.name || agent.sessionId;
  }

  // Every row the table can show, live sessions first. "Closed" is
  // everything with history that isn't currently a live background agent.
  const allRows = useMemo(() => {
    const live = agents.map((agent) => {
      const { label, tone } = agentState(agent);
      return {
        key: `agent:${agent.id}`,
        kind: "live",
        agent,
        title: displayNameFor(agent),
        project: agent.cwd ? dirBasename(agent.cwd) : "",
        state: label,
        tone,
        updated: agent.startedAt ? relativeTime(agent.startedAt) : "",
      };
    });
    const history = sessions
      .filter((s) => !liveSessionIds.has(s.id))
      .map((session) => ({
        key: `session:${session.id}`,
        kind: session.archived ? "archived" : "closed",
        session,
        title: session.title,
        project: session.projectLabel,
        state: session.archived ? "archived" : "closed",
        tone: "plain",
        updated: relativeTime(session.lastModified),
      }));
    return [...live, ...history];
  }, [agents, sessions, liveSessionIds, sessionTitleById]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((row) => {
      if (filter === "all" && row.kind === "archived") return false;
      if (filter === "running" && row.kind !== "live") return false;
      if (filter === "closed" && row.kind !== "closed") return false;
      if (filter === "archived" && row.kind !== "archived") return false;
      if (!q) return true;
      return row.title.toLowerCase().includes(q) || row.project.toLowerCase().includes(q);
    });
  }, [allRows, filter, query]);

  // The command menu under the search field: matching sessions to open,
  // then folders to start a new session in.
  const commandOpen = searchFocused && query.trim().length > 0;
  const commandItems = useMemo(() => {
    if (!commandOpen) return [];
    const matches = rows.slice(0, COMMAND_MATCHES).map((row) => ({ type: "open", row }));
    const dirs = [
      { type: "new", dir: null, title: "Default folder", detail: tildePath(defaultDirectory || "~/.clance"), shortcut: "⌘↩" },
      ...recentDirs
        .slice(0, COMMAND_RECENT_DIRS)
        .map((dir) => ({ type: "new", dir, title: dirBasename(dir), detail: tildePath(dir) })),
      { type: "browse", title: "Choose folder…", shortcut: "⌘O" },
    ];
    return [...matches, ...dirs];
  }, [commandOpen, rows, recentDirs, defaultDirectory]);

  useEffect(() => setCommandIndex(0), [query]);

  function showToast(message, undo) {
    clearTimeout(toastTimer.current);
    setToast({ message, undo });
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  function setArchived(sessionId, archived) {
    // Optimistic — the row just needs to move out of the current view,
    // not wait on a round trip to find out it's allowed to.
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, archived } : s)));
    window.clanceApp.setSessionArchived(sessionId, archived);
  }

  function archive(row) {
    setArchived(row.session.id, true);
    showToast("Session archived", () => {
      setArchived(row.session.id, false);
      setToast(null);
    });
  }

  async function stopAgent(agent) {
    if (!agent?.id) {
      // Seen live: `claude stop` invoked with an undefined id — a stale
      // reference from a poll tick that already rotated it out. Nothing
      // sensible to stop; don't shell out a garbage command for it.
      console.warn("stopAgent: agent has no id, skipping", agent);
      return;
    }
    // Optimistic — this is exactly what moves the row from live to closed;
    // the next poll would confirm it.
    setAgents((prev) => prev.filter((a) => a.id !== agent.id));
    await window.clanceApp.stopAgent(agent.id);
  }

  function archiveOrStop(row) {
    if (row.kind === "live") stopAgent(row.agent);
    else if (row.kind === "archived") setArchived(row.session.id, false);
    else archive(row);
  }

  function openRow(row) {
    if (row.kind === "live") {
      // Goes through the same resolveOpenArgs lookup as any other row
      // (Shell.js's openChatTab) — it's already live, so that lookup just
      // finds it and returns `attach` args, no re-spawn.
      onOpenChat({ id: row.agent.sessionId, filePath: row.agent.sessionId, title: row.title });
    } else {
      onOpenChat(row.session);
    }
  }

  async function popOut(row) {
    if (row.kind === "live") {
      window.clanceApp.openInWidget(["attach", row.agent.id]);
      return;
    }
    const args = await window.clanceApp.resolveOpenArgs(row.session.id, row.title);
    window.clanceApp.openInWidget(args);
  }

  async function folderFor(row) {
    if (row.kind === "live") return row.agent.cwd ?? null;
    return window.clanceApp.sessionFolder(row.session.id);
  }

  async function copyFolder(row) {
    const dir = await folderFor(row);
    if (!dir) {
      showToast("This session's folder isn't known");
      return;
    }
    await navigator.clipboard.writeText(dir);
    showToast("Folder path copied");
  }

  async function revealFolder(row) {
    const dir = await folderFor(row);
    if (!dir || !(await window.clanceApp.revealFolder(dir))) showToast("This session's folder isn't available");
  }

  function resumeInTerminal(row) {
    const target =
      row.kind === "live" ? { agentId: row.agent.id, cwd: row.agent.cwd } : { sessionId: row.session.id };
    window.clanceApp.resumeInTerminal(target);
  }

  async function chooseFolderAndStart() {
    const dir = await window.clanceApp.pickDirectory();
    if (dir) onNewChat(dir);
  }

  function runCommand(item) {
    if (!item) return;
    setQuery("");
    searchRef.current?.blur();
    if (item.type === "open") openRow(item.row);
    else if (item.type === "new") onNewChat(item.dir);
    else chooseFolderAndStart();
  }

  function handleSearchKeyDown(e) {
    if (e.key === "Escape") {
      if (query) setQuery("");
      else e.currentTarget.blur();
      return;
    }
    if (!commandOpen) {
      if (e.key === "ArrowDown" && rows.length > 0) {
        e.preventDefault();
        e.currentTarget.blur();
        setSelectedKey(rows[0].key);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCommandIndex((index) => (index + step + commandItems.length) % commandItems.length);
    } else if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      runCommand(commandItems.find((item) => item.type === "new"));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runCommand(commandItems[commandIndex]);
    } else if (e.key === "o" && e.metaKey) {
      e.preventDefault();
      runCommand({ type: "browse" });
    }
  }

  // Keyboard control for the table. Scoped to this section: ignored while
  // typing in a field or a terminal, and while another pane has focus.
  useEffect(() => {
    function onKeyDown(e) {
      const root = rootRef.current;
      if (!root) return;
      const focusInside = root.contains(document.activeElement) || document.activeElement === document.body;
      if (!focusInside) return;

      if (e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typingElsewhere(e.target)) return;

      if (e.key === "Escape") {
        setContextMenu(null);
        setFilterMenuOpen(false);
        return;
      }
      if (e.metaKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        onNewChat(null);
        return;
      }
      if (rows.length === 0) return;
      const index = rows.findIndex((row) => row.key === selectedKey);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = index === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, index + step));
        setSelectedKey(rows[next].key);
        root.querySelector(`[data-row-key="${CSS.escape(rows[next].key)}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && e.altKey && index !== -1) {
        e.preventDefault();
        popOut(rows[index]);
      } else if (e.key === "Enter" && index !== -1) {
        e.preventDefault();
        openRow(rows[index]);
      } else if (e.key === "Backspace" && e.metaKey && index !== -1) {
        e.preventDefault();
        archiveOrStop(rows[index]);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rows, selectedKey]);

  // Menus close on any outside click.
  useEffect(() => {
    if (!contextMenu && !filterMenuOpen) return;
    function close(e) {
      if (e.target.closest?.(".menu, .filter-button")) return;
      setContextMenu(null);
      setFilterMenuOpen(false);
    }
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [contextMenu, filterMenuOpen]);

  function openContextMenu(e, row) {
    e.preventDefault();
    setSelectedKey(row.key);
    const x = Math.min(e.clientX, window.innerWidth - 250);
    const y = Math.min(e.clientY, window.innerHeight - 300);
    setContextMenu({ x, y, row });
  }

  function menuAction(fn) {
    return () => {
      const row = contextMenu.row;
      setContextMenu(null);
      fn(row);
    };
  }

  const hasAnySession = allRows.length > 0;
  const filterLabel = FILTERS.find((f) => f.id === filter).label;

  return html`
    <div class="section-page sessions-page" ref=${rootRef}>
      <div class="search-row">
        <div class="command-search">
          <label class="search-input search-input-large">
            ${Icon.search(15)}
            <input
              ref=${searchRef}
              type="text"
              placeholder="Search sessions, or type to start a new one"
              aria-label="Search sessions, or type to start a new one"
              aria-expanded=${commandOpen}
              value=${query}
              onInput=${(e) => setQuery(e.target.value)}
              onFocus=${() => setSearchFocused(true)}
              onBlur=${() => setSearchFocused(false)}
              onKeyDown=${handleSearchKeyDown}
            />
            ${commandOpen ? html`<span class="mono-label">esc</span>` : html`<span class="kbd kbd-quiet">⌘K</span>`}
          </label>
          ${commandOpen &&
          html`
            <div class="menu command-menu" role="menu">
              ${commandItems.some((item) => item.type === "open") && html`<div class="menu-label">sessions</div>`}
              ${commandItems.map((item, index) => {
                const startsNewGroup = item.type === "new" && commandItems[index - 1]?.type !== "new";
                const header = startsNewGroup
                  ? html`${index > 0 && html`<div class="menu-separator"></div>`}
                      <div class="menu-label">start a new session in</div>`
                  : null;
                const active = index === commandIndex;
                const entry =
                  item.type === "open"
                    ? html`<${MenuItem}
                        title=${item.row.title}
                        detail=${[item.row.project, item.row.updated].filter(Boolean).join(" · ")}
                        shortcut=${active ? "↩" : null}
                        active=${active}
                        onSelect=${() => runCommand(item)}
                      />`
                    : html`<${MenuItem}
                        title=${item.title}
                        detail=${item.detail}
                        shortcut=${item.shortcut ?? (active ? "↩" : null)}
                        active=${active}
                        onSelect=${() => runCommand(item)}
                      />`;
                return html`${header}${entry}`;
              })}
            </div>
          `}
        </div>
        <div class="filter-menu-wrap">
          <button
            class="btn-secondary filter-button"
            aria-haspopup="menu"
            aria-expanded=${filterMenuOpen}
            onClick=${() => setFilterMenuOpen(!filterMenuOpen)}
          >
            ${filterLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          ${filterMenuOpen &&
          html`
            <div class="menu filter-menu" role="menu">
              ${FILTERS.map(
                (f, index) => html`
                  ${index === 3 && html`<div class="menu-separator"></div>`}
                  <button
                    class="menu-item"
                    role="menuitemradio"
                    aria-checked=${filter === f.id}
                    onClick=${() => {
                      setFilter(f.id);
                      setFilterMenuOpen(false);
                    }}
                  >
                    <span class="menu-check">${filter === f.id ? "✓" : ""}</span>
                    <span class="menu-item-title">${f.label}</span>
                  </button>
                `
              )}
            </div>
          `}
        </div>
      </div>

      ${loading
        ? html`
            <div class="mono-label sessions-loading-label">loading sessions</div>
            <div class="session-table"><${SkeletonRows} /></div>
          `
        : !hasAnySession
          ? html`
              <div class="empty-state">
                <span class="empty-state-logo">${Logo(28)}</span>
                <span class="empty-state-title">No sessions yet</span>
                <span class="empty-state-text">
                  Press <span class="kbd">⌥</span> <span class="kbd">Space</span> anywhere to ask Claude about
                  what you're looking at, or start one here in a folder.
                </span>
                <span class="empty-state-actions">
                  <button class="btn-primary" onClick=${() => onNewChat(null)}>New session</button>
                  <button class="btn-secondary" onClick=${chooseFolderAndStart}>Choose folder…</button>
                </span>
              </div>
            `
          : rows.length === 0
            ? html`<p class="empty-note">
                ${query.trim() ? "Nothing matches that search." : `No ${filterLabel.toLowerCase()} sessions.`}
              </p>`
            : html`
                <div class="session-table">
                  <${SessionTableHead} />
                  ${rows.map(
                    (row) => html`
                      <${SessionRow}
                        key=${row.key}
                        row=${row}
                        selected=${row.key === selectedKey}
                        onOpen=${() => openRow(row)}
                        onContextMenu=${(e) => openContextMenu(e, row)}
                        onPopOut=${() => popOut(row)}
                        onArchiveOrStop=${() => archiveOrStop(row)}
                      />
                    `
                  )}
                </div>
                <div class="keyboard-hints">
                  <span>↑↓ select</span><span>↩ open</span><span>⌘N new session</span><span>⌘⌫ archive</span><span>⌘K search</span>
                </div>
              `}

      ${contextMenu &&
      html`
        <div class="menu context-menu" role="menu" style=${{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}>
          <${MenuItem} title="Open" shortcut="↩" onSelect=${menuAction(openRow)} />
          <${MenuItem} title="Open in floating window" shortcut="⌥↩" onSelect=${menuAction(popOut)} />
          <${MenuItem} title="Resume in Terminal" onSelect=${menuAction(resumeInTerminal)} />
          <div class="menu-separator"></div>
          <${MenuItem} title="Copy folder path" onSelect=${menuAction(copyFolder)} />
          <${MenuItem} title="Reveal in Finder" onSelect=${menuAction(revealFolder)} />
          <div class="menu-separator"></div>
          ${contextMenu.row.kind === "live"
            ? html`<${MenuItem} title="Stop session" shortcut="⌘⌫" onSelect=${menuAction(archiveOrStop)} />`
            : contextMenu.row.kind === "archived"
              ? html`<${MenuItem} title="Restore" onSelect=${menuAction(archiveOrStop)} />`
              : html`<${MenuItem} title="Archive" shortcut="⌘⌫" onSelect=${menuAction(archiveOrStop)} />`}
        </div>
      `}

      ${toast &&
      html`
        <div class="toast toast-floating" role="status">
          <span class="toast-message">${toast.message}</span>
          ${toast.undo && html`<button class="toast-action" onClick=${toast.undo}>Undo</button>`}
        </div>
      `}
    </div>
  `;
}
