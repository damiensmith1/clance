import { html, useEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { useTabState } from "../state/tabState.js";
import { useWorkSnapshot, setFocus, focusFor, useFocus } from "../state/workStore.js";
import { Icon, Logo } from "../../shared/icons.js";
import { SessionPeek } from "../components/SessionPeek.js";
import { MenuItem } from "../components/MenuItem.js";

// The Work tab: what the user's sessions are doing to their code, and every
// session, in one table. In flight is what needs a look now — grouped by what
// the user has to do, across every repository, branch and worktree; Repos is
// every checkout and branch; the session views are the history. Picking a row
// shows its changes in the Changes pane; ↩ opens its session. See
// docs/design.md's "Work".

const TOAST_MS = 5000;
const COMMAND_MATCHES = 5;
const COMMAND_RECENT_DIRS = 3;
const FOCUS_SEARCH_EVENT = "clance:focus-work-search";

// ⌘K anywhere in the main window (Shell.js) calls this after switching to the
// Work tab. The tab may not be mounted yet, so the request is also kept until
// the section mounts and picks it up.
let searchFocusPending = false;
export function focusWorkSearch() {
  searchFocusPending = true;
  window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
}

const VIEWS = [
  { id: "flight", label: "In flight" },
  { id: "repos", label: "Repos" },
  { id: "sessions", label: "Past sessions" },
  { id: "archived", label: "Archived" },
  // Sessions a program started (see chatHistory.ts's `automated`), e.g. a
  // plugin's commit reviews: kept out of the other views, like archived ones.
  { id: "automated", label: "Automated" },
];

const GROUPS = [
  { id: "needs", label: "needs you", tone: "attention" },
  { id: "review", label: "ready to review" },
  { id: "working", label: "working" },
  { id: "open", label: "open, nothing changed" },
  { id: "branches", label: "branches with no session" },
  { id: "shipped", label: "merged, ready to clean up" },
];

function dirBasename(dir) {
  const segments = (dir ?? "").split("/").filter(Boolean);
  return segments[segments.length - 1] || dir;
}

function tildePath(dir) {
  return (dir ?? "").replace(/^\/Users\/[^/]+/, "~");
}

// Short and mono, for the table's "updated" column: now, 12m, 3h, 4d, then
// a date.
function relativeTime(when) {
  const ms = typeof when === "number" ? when : Date.parse(when);
  if (!ms || Number.isNaN(ms)) return "";
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// True when a keystroke belongs to something else on screen: a text field,
// or a terminal (xterm's hidden textarea).
function typingElsewhere(target) {
  return Boolean(target?.closest?.("input, textarea, [contenteditable], .xterm"));
}

// ---- describing a row ----------------------------------------------------------

function sessionTone(state) {
  if (state === "working") return "live";
  if (state === "needs") return "attention";
  if (state === "failed") return "danger";
  if (state === "done") return "ok";
  return "plain";
}

function sessionWord(state) {
  return { needs: "needs you", working: "working", failed: "failed", done: "done", idle: "idle" }[state] ?? state;
}

/**
 * Whether a row is best called by its session. Only when its sessions work
 * there and nowhere else: one session editing two checkouts is two rows, and
 * both named after it would read as a duplicate.
 */
function titledBySession(item, sessions) {
  return sessions.length > 0 && (item.kind === "conversation" || sessions.every((s) => s.checkouts.length <= 1));
}

/** A work item's row: title, where it is, its state, its changes, when. */
function describe(item, sessions, view) {
  const b = item.branchState;
  const bySession = view === "flight" && titledBySession(item, sessions);
  const lead = sessions.find((s) => s.state === "needs" || s.state === "failed") ?? sessions.find((s) => s.state === "working") ?? sessions[0];
  const branch = item.branch ?? "detached";

  let title;
  let where;
  if (item.kind === "conversation") {
    title = lead?.title ?? "Session";
    where = tildePath(lead?.cwd) || "no folder";
  } else if (bySession) {
    title = sessions.length > 1 ? `${lead.title} +${sessions.length - 1}` : lead.title;
    where = `${item.repo} ⎇ ${branch}`;
  } else if (view === "repos") {
    title = branch;
    where = item.kind === "branch" ? "not checked out" : item.main ? "repository folder" : item.checkout.slice(item.root.length + 1);
  } else {
    title = item.kind === "checkout" && item.main ? item.repo : branch;
    where = item.kind === "checkout" && item.main ? branch : `${item.repo} · ${item.kind === "branch" ? "no checkout" : "worktree"}`;
  }

  let state;
  let tone = "plain";
  if (lead && (bySession || sessions.some((s) => s.state === "needs" || s.state === "working"))) {
    state = sessionWord(lead.state);
    tone = sessionTone(lead.state);
  } else if (item.operation) {
    state = item.operation;
    tone = "attention";
  } else if (item.uncommitted?.files) {
    state = `${item.uncommitted.files} uncommitted`;
  } else if (b?.isBase && b.unpushed) {
    state = `${b.unpushed} to push`;
  } else if (b && !b.isBase && b.ahead === 0 && b.behind === 0) {
    state = "no commits";
  } else if (b && !b.isBase && b.ahead === 0) {
    state = "merged";
    tone = item.group === "shipped" ? "ok" : "plain";
  } else if (b && !b.isBase) {
    state = `↑${b.ahead} ↓${b.behind}`;
  } else {
    state = "clean";
  }

  const t = item.total;
  const changes = t && t.files ? `+${t.insertions} −${t.deletions}` : "";
  const when = lead?.startedAt ?? (b ? b.date : null);
  const live = Boolean(lead && (lead.state === "working" || lead.state === "needs" || lead.state === "failed"));
  return { title, where, state, tone, changes, when, live, lead };
}

/**
 * A running session's row in In flight: called by its name, placed at the
 * checkout where most of its changes are (with "+n" for the others it has
 * edited), so a session is found by the name it goes by.
 */
function describeSession(session, primary) {
  const t = primary?.total;
  return {
    title: session.title,
    where: primary
      ? `${primary.repo} ⎇ ${primary.branch ?? "detached"}${session.checkouts.length > 1 ? ` +${session.checkouts.length - 1}` : ""}`
      : tildePath(session.cwd) || "no folder",
    state: sessionWord(session.state),
    tone: sessionTone(session.state),
    changes: t && t.files ? `+${t.insertions} −${t.deletions}` : "",
    when: session.startedAt,
    live: session.state === "working" || session.state === "needs" || session.state === "failed",
    lead: session,
  };
}

/** How much a checkout has changed: where a session's row points first. */
function weight(item) {
  return (item.uncommitted?.files ?? 0) * 1000 + (item.total?.files ?? 0);
}

function hasChanges(item) {
  const b = item.branchState;
  return Boolean(item.uncommitted?.files || (b && (b.isBase ? b.unpushed : b.ahead)));
}

// Enough placeholder rows to fill the window (rows are 42px tall), so the
// loading table reaches the bottom like a real list does.
const SKELETON_WIDTHS = [320, 250, 380, 210, 290];
const ROW_PX = 42;

function SkeletonRows() {
  const count = Math.max(SKELETON_WIDTHS.length, Math.ceil(window.innerHeight / ROW_PX));
  return Array.from({ length: count }, (_, i) => SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]).map(
    (width) => html`
      <div class="session-row work-row session-row-skeleton" aria-hidden="true">
        <span></span>
        <span class="skeleton" style=${{ width: `${width}px` }}></span>
        <span class="skeleton" style=${{ width: "90px" }}></span>
        <span></span>
        <span></span>
        <span class="skeleton skeleton-short"></span>
        <span></span>
      </div>
    `
  );
}

function WorkRow({ row, selected, onSelect, onOpen, onContextMenu, onPopOut, onStop, onTerminal }) {
  const d = row.d;
  return html`
    <div
      class="session-row work-row ${selected ? "session-row-selected" : ""}"
      role="button"
      tabindex="0"
      aria-selected=${selected}
      data-row-key=${row.key}
      onClick=${onSelect}
      onDblClick=${onOpen}
      onContextMenu=${onContextMenu}
    >
      <span class="work-indicator">
        ${d.live && html`<span class="status-dot ${d.tone === "live" ? "status-dot-live" : ""} session-dot-${d.tone}"></span>`}
      </span>
      <span class="session-title">${d.title}</span>
      <span class="session-project" title=${d.where}>${d.where}</span>
      <span class="session-state session-state-${d.tone}">${d.state}</span>
      <span class="work-changes">${d.changes}</span>
      <span class="session-updated">${relativeTime(d.when)}</span>
      <span class="session-actions">
        ${d.lead
          ? html`
              <button class="icon-button session-row-action" title="Open in floating window" aria-label="Open in floating window" onClick=${(e) => { e.stopPropagation(); onPopOut(); }}>
                ${Icon.popOut(14)}
              </button>
              <button class="icon-button session-row-action" title="Stop session" aria-label="Stop session" onClick=${(e) => { e.stopPropagation(); onStop(); }}>
                ${Icon.close(14)}
              </button>
            `
          : row.item.checkout &&
            html`<button class="icon-button session-row-action" title="Terminal here" aria-label="Terminal here" onClick=${(e) => { e.stopPropagation(); onTerminal(); }}>
              ${Icon.terminal(14)}
            </button>`}
      </span>
    </div>
  `;
}

function SessionRow({ row, selected, lastPinned, onSelect, onOpen, onContextMenu, onPopOut, onArchive, onTogglePin }) {
  return html`
    <div
      class="session-row work-row ${selected ? "session-row-selected" : ""} ${lastPinned ? "session-row-pinned-last" : ""}"
      role="button"
      tabindex="0"
      aria-selected=${selected}
      data-row-key=${row.key}
      onClick=${onSelect}
      onDblClick=${onOpen}
      onContextMenu=${onContextMenu}
    >
      <button
        class="session-pin ${row.pinned ? "session-pin-on" : ""} session-pin-tone-plain"
        title=${row.pinned ? "Unpin session" : "Pin session"}
        aria-label=${row.pinned ? "Unpin session" : "Pin session"}
        aria-pressed=${row.pinned}
        onClick=${(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        ${Icon.pin(13)}
      </button>
      <span class="session-title">${row.session.title}</span>
      <span class="session-project">${row.session.projectLabel}</span>
      <span class="session-state">${row.session.archived ? "archived" : row.session.automated ? "automated" : "closed"}</span>
      <span class="work-changes"></span>
      <span class="session-updated">${relativeTime(row.session.lastModified)}</span>
      <span class="session-actions">
        <button class="icon-button session-row-action" title="Open in floating window" aria-label="Open in floating window" onClick=${(e) => { e.stopPropagation(); onPopOut(); }}>
          ${Icon.popOut(14)}
        </button>
        ${row.session.archived
          ? html`<button class="btn-quiet btn-small session-row-action" onClick=${(e) => { e.stopPropagation(); onArchive(); }}>Restore</button>`
          : html`<button class="icon-button session-row-action" title="Archive" aria-label="Archive" onClick=${(e) => { e.stopPropagation(); onArchive(); }}>${Icon.archive(14)}</button>`}
      </span>
    </div>
  `;
}

export function WorkSection({ onOpenSession, onNewSession, onShowChanges, onOpenTerminal }) {
  const snapshot = useWorkSnapshot();
  const focus = useFocus();
  // What the page was showing and what the person was doing is the tab's
  // state (state/tabState.js), so moving the tab or switching away doesn't
  // lose it. The view and the search are also saved with the layout.
  const [history, setHistory] = useTabState("work.history", null);
  const [view, setView] = useTabState("work.view", "flight", { persist: true });
  const [query, setQuery] = useTabState("work.query", "", { persist: true });
  const [selectedKey, setSelectedKey] = useTabState("work.selected", null);
  const [pinnedIds, setPinnedIds] = useTabState("work.pinned", () => new Set());
  const [peekId, setPeekId] = useTabState("work.peek", null);
  const [recentDirs, setRecentDirs] = useTabState("work.recentDirs", []);
  const [defaultDirectory, setDefaultDirectory] = useTabState("work.defaultDirectory", null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState(null);
  const [toast, setToast] = useState(null);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    function takeFocus() {
      if (!searchFocusPending || !searchRef.current) return;
      searchFocusPending = false;
      searchRef.current.focus();
      searchRef.current.select();
    }
    takeFocus();
    window.addEventListener(FOCUS_SEARCH_EVENT, takeFocus);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, takeFocus);
  }, []);

  function readHistory() {
    window.clanceApp.listChatSessions().then((result) => {
      setHistory(result);
      setPinnedIds(new Set(result.filter((s) => s.pinned).map((s) => s.id)));
    });
  }

  useEffect(() => {
    readHistory();
    Promise.all([window.clanceApp.getRecentDirectories(), window.clanceApp.getPreferences()]).then(([dirs, prefs]) => {
      setRecentDirs(dirs ?? []);
      setDefaultDirectory(prefs?.defaultDirectory ?? null);
    });
    return () => clearTimeout(toastTimer.current);
  }, []);

  // A session that stops moves from the running ones to the history, which
  // was read when the page loaded: read it again so it's there.
  const liveIds = useMemo(() => new Set((snapshot?.sessions ?? []).map((s) => s.sessionId)), [snapshot]);
  const prevLiveIds = useRef(liveIds);
  useEffect(() => {
    const stopped = [...prevLiveIds.current].some((id) => !liveIds.has(id));
    prevLiveIds.current = liveIds;
    if (stopped) readHistory();
  }, [liveIds]);

  const sessionsById = useMemo(() => new Map((snapshot?.sessions ?? []).map((s) => [s.sessionId, s])), [snapshot]);
  const sessionsOf = (item) => item.sessionIds.map((id) => sessionsById.get(id)).filter(Boolean);

  // ---- the rows of the current view ----

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const out = [];
    if (view === "flight" || view === "repos") {
      const items = snapshot?.items ?? [];
      const toRow = (item) => {
        const sessions = sessionsOf(item);
        return { key: item.id, kind: "item", item, sessions, d: describe(item, sessions, view) };
      };
      const matches = (row) =>
        !q || [row.d.title, row.d.where, row.item.repo, row.item.branch, ...row.sessions.map((s) => s.title)].some((text) => text?.toLowerCase().includes(q));
      if (view === "flight") {
        // Running sessions are rows of their own, by name; a checkout one of
        // them is working in is reached through it (and the Changes pane's
        // branch menu) rather than listed again. What's left are checkouts
        // and branches no session is on.
        const byId = new Map(items.map((item) => [item.id, item]));
        const covered = new Set();
        const byGroup = new Map(GROUPS.map((group) => [group.id, []]));
        for (const session of snapshot?.sessions ?? []) {
          const touched = session.checkouts.map((path) => byId.get(`co:${path}`)).filter(Boolean);
          const primary = [...touched].sort((a, b) => weight(b) - weight(a))[0] ?? null;
          for (const item of touched) covered.add(item.id);
          const group =
            session.state === "needs" || session.state === "failed"
              ? "needs"
              : session.state === "working"
                ? "working"
                : touched.some(hasChanges)
                  ? "review"
                  : "open";
          const item = primary ?? byId.get(`s:${session.sessionId}`) ?? { id: `s:${session.sessionId}`, kind: "conversation", sessionIds: [session.sessionId] };
          byGroup.get(group).push({ key: `live:${session.sessionId}`, kind: "item", item, sessions: [session], d: describeSession(session, primary) });
        }
        for (const item of items) {
          if (item.kind === "conversation" || covered.has(item.id)) continue;
          const group = item.sessionIds.length ? (hasChanges(item) ? "review" : null) : item.group;
          if (group && byGroup.has(group)) byGroup.get(group).push(toRow(item));
        }
        for (const group of GROUPS) {
          const groupRows = byGroup.get(group.id).filter(matches);
          if (!groupRows.length) continue;
          out.push({ key: `group:${group.id}`, kind: "label", label: group.label, tone: group.tone, count: groupRows.length });
          out.push(...groupRows);
        }
      } else {
        for (const repo of snapshot?.repos ?? []) {
          const repoRows = items.filter((item) => item.root === repo.root && item.kind !== "conversation").map(toRow).filter(matches);
          if (!repoRows.length) continue;
          out.push({ key: `repo:${repo.root}`, kind: "label", label: repo.name, detail: tildePath(repo.root), root: repo.root });
          out.push(...repoRows);
        }
      }
      return out;
    }
    const visible = (history ?? []).filter((s) => {
      if (liveIds.has(s.id)) return false;
      if (view === "archived") return s.archived;
      if (view === "automated") return s.automated && !s.archived;
      return !s.archived && !s.automated;
    });
    const matching = q ? visible.filter((s) => s.title.toLowerCase().includes(q) || s.projectLabel.toLowerCase().includes(q)) : visible;
    // Pinned rows go above everything else, in the order they'd otherwise
    // have had. The view and search still decide what's listed at all.
    const pinned = matching.filter((s) => pinnedIds.has(s.id));
    const rest = matching.filter((s) => !pinnedIds.has(s.id));
    return [...pinned, ...rest].map((session, index) => ({
      key: `h:${session.id}`,
      kind: "session",
      session,
      pinned: pinnedIds.has(session.id),
      lastPinned: index === pinned.length - 1,
    }));
  }, [view, snapshot, history, q, pinnedIds, liveIds]);

  const selectable = useMemo(() => rows.filter((row) => row.kind !== "label"), [rows]);
  const loading = view === "flight" || view === "repos" ? snapshot === null : history === null;

  // The command menu under the search field: matching rows to open, then
  // folders to start a new session in.
  const commandOpen = searchFocused && query.trim().length > 0;
  const commandItems = useMemo(() => {
    if (!commandOpen) return [];
    const matches = selectable.slice(0, COMMAND_MATCHES).map((row) => ({ type: "open", row }));
    const dirs = [
      { type: "new", dir: null, title: "Default folder", detail: tildePath(defaultDirectory || "~/.clance"), shortcut: "⌘↩" },
      ...recentDirs.slice(0, COMMAND_RECENT_DIRS).map((dir) => ({ type: "new", dir, title: dirBasename(dir), detail: tildePath(dir) })),
      { type: "browse", title: "Choose folder…", shortcut: "⌘O" },
    ];
    return [...matches, ...dirs];
  }, [commandOpen, selectable, recentDirs, defaultDirectory]);

  useEffect(() => setCommandIndex(0), [query]);

  // ---- acting on rows ----

  function showToast(message, undo) {
    clearTimeout(toastTimer.current);
    setToast({ message, undo });
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  /** Picking a row shows its changes in the Changes pane. The selection only moves when the person moves it. */
  function select(row) {
    setSelectedKey(row.key);
    if (row.kind === "session") {
      setFocus({ kind: "session", sessionId: row.session.id, title: row.session.title });
    } else if (row.item.kind === "conversation") {
      if (row.d.lead) setFocus({ kind: "session", sessionId: row.d.lead.sessionId, title: row.d.title });
    } else {
      setFocus(focusFor(row.item));
    }
    onShowChanges();
  }

  /** ↩ or a double-click: into the session, if the row has one. */
  function open(row) {
    if (row.kind === "session") return onOpenSession(row.session);
    const lead = row.d.lead;
    if (lead) onOpenSession({ id: lead.sessionId, title: lead.title });
    else select(row);
  }

  async function popOut(row) {
    if (row.kind === "item") {
      if (row.d.lead?.agentId) window.clanceApp.openInWidget(["attach", row.d.lead.agentId]);
      return;
    }
    const args = await window.clanceApp.resolveOpenArgs(row.session.id, row.session.title);
    window.clanceApp.openInWidget(args);
  }

  async function stop(row) {
    const lead = row.d?.lead;
    if (!lead?.agentId) return;
    await window.clanceApp.stopAgent(lead.agentId);
    showToast(`Stopped ${lead.title}`);
  }

  function setArchived(session, archived) {
    // Optimistic — the row just needs to move out of the current view.
    setHistory((prev) => (prev ?? []).map((s) => (s.id === session.id ? { ...s, archived } : s)));
    window.clanceApp.setSessionArchived(session.id, archived);
  }

  function archive(row) {
    if (row.session.archived) return setArchived(row.session, false);
    setArchived(row.session, true);
    showToast("Session archived", () => {
      setArchived(row.session, false);
      setToast(null);
    });
  }

  function togglePin(row) {
    const id = row.session.id;
    const pinned = !pinnedIds.has(id);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (pinned) next.add(id);
      else next.delete(id);
      return next;
    });
    window.clanceApp.setSessionPinned(id, pinned);
  }

  function sessionIdOf(row) {
    return row.kind === "session" ? row.session.id : row.d?.lead?.sessionId ?? null;
  }

  function peek(row) {
    const id = sessionIdOf(row);
    if (!id) return showToast("There's no session here to peek at");
    setPeekId(id);
  }

  function rowForSession(id) {
    return selectable.find((row) => sessionIdOf(row) === id);
  }

  function folderOf(row) {
    return row.kind === "item" ? row.item.checkout ?? row.d.lead?.cwd ?? null : row.session.cwd ?? null;
  }

  async function chooseFolderAndStart() {
    const dir = await window.clanceApp.pickDirectory();
    if (dir) onNewSession(dir);
  }

  function runCommand(item) {
    if (!item) return;
    setQuery("");
    searchRef.current?.blur();
    if (item.type === "open") {
      select(item.row);
      if (sessionIdOf(item.row)) open(item.row);
    } else if (item.type === "new") onNewSession(item.dir);
    else chooseFolderAndStart();
  }

  function handleSearchKeyDown(e) {
    if (e.key === "Escape") {
      if (query) setQuery("");
      else e.currentTarget.blur();
      return;
    }
    // The menu's shortcuts work from the moment the field has focus, not
    // only once something's been typed and the menu is showing.
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      runCommand({ type: "new", dir: null });
      return;
    }
    if (e.key.toLowerCase() === "o" && e.metaKey) {
      e.preventDefault();
      runCommand({ type: "browse" });
      return;
    }
    if (!commandOpen) {
      if (e.key === "ArrowDown" && selectable.length > 0) {
        e.preventDefault();
        e.currentTarget.blur();
        select(selectable[0]);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCommandIndex((index) => (index + step + commandItems.length) % commandItems.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runCommand(commandItems[commandIndex]);
    }
  }

  // Keyboard control for the table. Scoped to this section: ignored while
  // typing in a field or a terminal, and while another pane has focus.
  useEffect(() => {
    function onKeyDown(e) {
      const root = rootRef.current;
      if (!root) return;
      const focusInside = root.contains(document.activeElement) || document.activeElement === document.body;
      if (!focusInside || typingElsewhere(e.target) || peekId) return;
      if (e.key === "Escape") {
        setContextMenu(null);
        setViewMenuOpen(false);
        return;
      }
      if (e.metaKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        onNewSession(null);
        return;
      }
      if (!selectable.length) return;
      const index = selectable.findIndex((row) => row.key === selectedKey);
      const current = index === -1 ? null : selectable[index];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setContextMenu(null);
        if (document.activeElement?.closest?.(".session-row")) document.activeElement.blur();
        root.classList.add("sessions-keyboard-nav");
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = index === -1 ? 0 : Math.max(0, Math.min(selectable.length - 1, index + step));
        select(selectable[next]);
        root.querySelector(`[data-row-key="${CSS.escape(selectable[next].key)}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && e.altKey && current) {
        e.preventDefault();
        popOut(current);
      } else if (e.key === "Enter" && current) {
        e.preventDefault();
        open(current);
      } else if (e.key === " " && current) {
        // Space is Quick Look's key in the Finder, and the same gesture here.
        e.preventDefault();
        peek(current);
      } else if (e.key === "Backspace" && e.metaKey && current) {
        e.preventDefault();
        if (current.kind === "session") archive(current);
        else stop(current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectable, selectedKey, peekId]);

  // While the arrow keys drive the selection, the row under a resting mouse
  // pointer mustn't look selected too: hover styling is off until the mouse
  // actually moves.
  useEffect(() => {
    let last = null;
    function onMouseMove(e) {
      const moved = last && (last.x !== e.screenX || last.y !== e.screenY);
      last = { x: e.screenX, y: e.screenY };
      if (moved) rootRef.current?.classList.remove("sessions-keyboard-nav");
    }
    window.addEventListener("mousemove", onMouseMove);
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, []);

  // Menus close on any outside click.
  useEffect(() => {
    if (!contextMenu && !viewMenuOpen) return;
    function close(e) {
      if (e.target.closest?.(".menu, .filter-button")) return;
      setContextMenu(null);
      setViewMenuOpen(false);
    }
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [contextMenu, viewMenuOpen]);

  function openContextMenu(e, row) {
    e.preventDefault();
    setSelectedKey(row.key);
    const x = Math.min(e.clientX, window.innerWidth - 250);
    const y = Math.min(e.clientY, window.innerHeight - 360);
    setContextMenu({ x, y, row });
  }

  function menuAction(fn) {
    return () => {
      const row = contextMenu.row;
      setContextMenu(null);
      fn(row);
    };
  }

  // The row the Changes pane is showing reads as selected, even after a
  // relaunch or when the pane was pointed elsewhere and back.
  // A checkout a session is working in is listed as that session's row.
  const shownId = !focus ? null : focus.kind === "checkout" ? `co:${focus.dir}` : focus.kind === "branch" ? `br:${focus.root}:${focus.branch}` : null;
  const shownKey = !focus
    ? null
    : shownId
      ? (selectable.find((row) => row.key === shownId) ?? selectable.find((row) => row.item?.id === shownId))?.key ?? null
      : selectable.find((row) => sessionIdOf(row) === focus.sessionId)?.key ?? null;
  const activeKey = selectable.some((row) => row.key === selectedKey) && selectable.find((row) => row.key === selectedKey)?.item?.id === shownId ? selectedKey : shownKey ?? selectedKey;

  const viewLabel = VIEWS.find((v) => v.id === view)?.label ?? "In flight";
  const nothingAtAll = !loading && view === "sessions" && (history ?? []).length === 0 && !(snapshot?.sessions ?? []).length;
  const workView = view === "flight" || view === "repos";

  const keyboardHints = html`
    <div class="keyboard-hints">
      <span>↑↓ select</span><span>↩ open</span><span>space peek</span><span>⌥↩ widget</span><span>⌘⌫ ${workView ? "stop" : "archive"}</span><span>⌘N new session</span>
    </div>
  `;

  return html`
    <div class="section-page sessions-page" ref=${rootRef}>
      <div class="search-row">
        <div class="command-search">
          <label class="search-input search-input-large">
            ${Icon.search(15)}
            <input
              ref=${searchRef}
              type="text"
              placeholder="Search sessions, repos and branches, or type to start a session"
              aria-label="Search sessions, repos and branches"
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
              ${commandItems.some((item) => item.type === "open") && html`<div class="menu-label">${viewLabel.toLowerCase()}</div>`}
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
                        title=${item.row.kind === "session" ? item.row.session.title : item.row.d.title}
                        detail=${item.row.kind === "session" ? item.row.session.projectLabel : item.row.d.where}
                        shortcut=${active ? "↩" : null}
                        active=${active}
                        onSelect=${() => runCommand(item)}
                      />`
                    : html`<${MenuItem} title=${item.title} detail=${item.detail} shortcut=${item.shortcut ?? (active ? "↩" : null)} active=${active} onSelect=${() => runCommand(item)} />`;
                return html`${header}${entry}`;
              })}
            </div>
          `}
        </div>
        <div class="filter-menu-wrap">
          <button class="btn-secondary filter-button" aria-haspopup="menu" aria-expanded=${viewMenuOpen} onClick=${() => setViewMenuOpen(!viewMenuOpen)}>
            ${viewLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          ${viewMenuOpen &&
          html`
            <div class="menu filter-menu" role="menu">
              ${VIEWS.map(
                (v, index) => html`
                  ${index === 2 && html`<div class="menu-separator"></div>`}
                  <button
                    class="menu-item"
                    role="menuitemradio"
                    aria-checked=${view === v.id}
                    onClick=${() => {
                      setView(v.id);
                      setViewMenuOpen(false);
                    }}
                  >
                    <span class="menu-check">${view === v.id ? "✓" : ""}</span>
                    <span class="menu-item-title">${v.label}</span>
                  </button>
                `
              )}
            </div>
          `}
        </div>
      </div>

      ${loading
        ? html`
            ${keyboardHints}
            <div class="session-table" aria-busy="true" aria-label="Loading"><${SkeletonRows} /></div>
          `
        : nothingAtAll
          ? html`
              <div class="empty-state">
                <span class="empty-state-logo">${Logo(28)}</span>
                <span class="empty-state-title">No sessions yet</span>
                <span class="empty-state-text">
                  Press <span class="kbd">⌥</span> <span class="kbd">Space</span> anywhere to ask Claude about what you're looking at, or start one here in a folder.
                </span>
                <span class="empty-state-actions">
                  <button class="btn-primary" onClick=${() => onNewSession(null)}>New session</button>
                  <button class="btn-secondary" onClick=${chooseFolderAndStart}>Choose folder…</button>
                </span>
              </div>
            `
          : selectable.length === 0
            ? html`<p class="empty-note">
                ${q
                  ? "Nothing matches that search."
                  : view === "flight"
                    ? "Nothing in flight: no session is running and nothing is waiting to be reviewed. Repos has every branch."
                    : view === "repos"
                      ? "No repositories yet. Start a session in one, or pick one in the Changes pane."
                      : `No ${viewLabel.toLowerCase()}.`}
              </p>`
            : html`
                ${keyboardHints}
                <div class="session-table">
                  ${rows.map((row) =>
                    row.kind === "label"
                      ? html`<div class="work-label ${row.tone === "attention" ? "work-label-attention" : ""}" key=${row.key}>
                          <span>${row.label}</span>
                          ${row.detail && html`<span class="work-label-detail">${row.detail}</span>`}
                          ${row.count !== undefined && html`<span class="work-label-count">${row.count}</span>`}
                          ${row.root &&
                          html`<button class="btn-quiet btn-small work-label-action" onClick=${() => window.clanceApp.workFetch(row.root).then((r) => showToast(r?.ok === false ? r.error : `Fetched ${row.label}`))}>Fetch</button>`}
                        </div>`
                      : row.kind === "item"
                        ? html`<${WorkRow}
                            key=${row.key}
                            row=${row}
                            selected=${row.key === activeKey}
                            onSelect=${() => select(row)}
                            onOpen=${() => open(row)}
                            onContextMenu=${(e) => openContextMenu(e, row)}
                            onPopOut=${() => popOut(row)}
                            onStop=${() => stop(row)}
                            onTerminal=${() => onOpenTerminal(row.item.checkout)}
                          />`
                        : html`<${SessionRow}
                            key=${row.key}
                            row=${row}
                            selected=${row.key === activeKey}
                            lastPinned=${row.lastPinned && row.pinned}
                            onSelect=${() => select(row)}
                            onOpen=${() => open(row)}
                            onContextMenu=${(e) => openContextMenu(e, row)}
                            onPopOut=${() => popOut(row)}
                            onArchive=${() => archive(row)}
                            onTogglePin=${() => togglePin(row)}
                          />`
                  )}
                </div>
              `}

      ${contextMenu &&
      html`
        <div class="menu context-menu" role="menu" style=${{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}>
          ${sessionIdOf(contextMenu.row) && html`<${MenuItem} title="Peek" shortcut="Space" onSelect=${menuAction(peek)} />`}
          ${sessionIdOf(contextMenu.row) && html`<${MenuItem} title=${contextMenu.row.kind === "session" ? "Resume" : "Open session"} shortcut="↩" onSelect=${menuAction(open)} />`}
          ${sessionIdOf(contextMenu.row) && html`<${MenuItem} title="Open in floating window" shortcut="⌥↩" onSelect=${menuAction(popOut)} />`}
          ${contextMenu.row.kind === "session" &&
          html`<${MenuItem} title="Resume in Terminal" onSelect=${menuAction((row) => window.clanceApp.resumeInTerminal({ sessionId: row.session.id }))} />`}
          <${MenuItem} title="Show changes" onSelect=${menuAction(select)} />
          <div class="menu-separator"></div>
          ${contextMenu.row.kind === "item" &&
          contextMenu.row.item.checkout &&
          html`
            <${MenuItem} title="Terminal here" onSelect=${menuAction((row) => onOpenTerminal(row.item.checkout))} />
            <${MenuItem} title="New session here" onSelect=${menuAction((row) => onNewSession(row.item.checkout))} />
          `}
          ${contextMenu.row.kind === "item" &&
          contextMenu.row.item.branch &&
          html`<${MenuItem} title="Copy branch name" onSelect=${menuAction((row) => navigator.clipboard.writeText(row.item.branch).then(() => showToast("Branch name copied")))} />`}
          ${folderOf(contextMenu.row) &&
          html`
            <${MenuItem} title="Copy folder path" onSelect=${menuAction((row) => navigator.clipboard.writeText(folderOf(row)).then(() => showToast("Folder path copied")))} />
            <${MenuItem} title="Reveal in Finder" onSelect=${menuAction((row) => window.clanceApp.revealFolder(folderOf(row)))} />
          `}
          ${contextMenu.row.kind === "session" &&
          html`
            <div class="menu-separator"></div>
            <${MenuItem} title=${contextMenu.row.pinned ? "Unpin" : "Pin"} onSelect=${menuAction(togglePin)} />
            <${MenuItem} title=${contextMenu.row.session.archived ? "Restore" : "Archive"} shortcut="⌘⌫" onSelect=${menuAction(archive)} />
          `}
          ${contextMenu.row.kind === "item" &&
          contextMenu.row.d.lead &&
          html`
            <div class="menu-separator"></div>
            <${MenuItem} title="Stop session" shortcut="⌘⌫" onSelect=${menuAction(stop)} />
          `}
        </div>
      `}

      ${peekId &&
      html`
        <${SessionPeek}
          sessionId=${peekId}
          onClose=${() => setPeekId(null)}
          onOpen=${() => {
            const row = rowForSession(peekId);
            setPeekId(null);
            if (row) open(row);
          }}
          onPopOut=${() => {
            const row = rowForSession(peekId);
            setPeekId(null);
            if (row) popOut(row);
          }}
        />
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
