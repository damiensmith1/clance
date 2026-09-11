import { html, useEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";

// No Node `path` module in the renderer (contextIsolation) — a directory
// picked via the native folder dialog is always a plain forward-slash
// absolute path on macOS, so a simple split covers it. Same helper as
// popup.js's dirBasename — small enough that duplicating it here beats
// introducing a shared util module for one three-line function.
function dirBasename(dir) {
  const segments = dir.split("/").filter(Boolean);
  return segments[segments.length - 1] || dir;
}

// The Sessions page's "New Session" button — a dropdown rather than a
// single click, so a fresh session can open somewhere other than the
// configured default without a separate flow. Same shape as the popup's
// "Open in..." dropdown (default first, then recent directories, then
// Browse...) rather than a split-button that keeps the single click
// instant — deliberate: this page is already a multi-step, considered
// surface (open app, go to Sessions, click), so the extra click to
// confirm/pick isn't the same cost it would be on the hotkey path.
function NewSessionButton({ onNewChat }) {
  const [open, setOpen] = useState(false);
  const [recentDirs, setRecentDirs] = useState([]);
  const [defaultDirectory, setDefaultDirectory] = useState(null);
  const wrapRef = useRef(null);

  function openDropdown() {
    Promise.all([window.clanceApp.getRecentDirectories(), window.clanceApp.getPreferences()]).then(
      ([dirs, prefs]) => {
        setRecentDirs(dirs);
        setDefaultDirectory(prefs.defaultDirectory);
      }
    );
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    // Capture phase so this runs before anything else might stop the
    // event from bubbling — same pattern as popup.js's dropdown.
    document.addEventListener("click", handleOutsideClick, true);
    return () => document.removeEventListener("click", handleOutsideClick, true);
  }, [open]);

  function pick(dir) {
    setOpen(false);
    onNewChat(dir);
  }

  async function handleBrowse() {
    const dir = await window.clanceApp.pickDirectory();
    setOpen(false);
    if (dir) onNewChat(dir);
  }

  return html`
    <div class="new-session-wrap" ref=${wrapRef}>
      <button class="btn-ghost" onClick=${() => (open ? setOpen(false) : openDropdown())}>
        ${Icon.addServer(12)} New Session
      </button>
      ${open &&
      html`
        <div class="new-session-dropdown">
          <button class="dir-pick-row" onClick=${() => pick(null)}>
            <span class="dir-pick-row-title">Default</span>
            <span class="dir-pick-row-meta">${defaultDirectory || "Clance's own directory"}</span>
          </button>
          ${recentDirs.length > 0 && html`<div class="dir-pick-divider"></div>`}
          ${recentDirs.map(
            (dir) => html`
              <button key=${dir} class="dir-pick-row" onClick=${() => pick(dir)}>
                <span class="dir-pick-row-title">${dirBasename(dir)}</span>
                <span class="dir-pick-row-meta">${dir}</span>
              </button>
            `
          )}
          <div class="dir-pick-divider"></div>
          <button class="dir-pick-row" onClick=${handleBrowse}>
            <span class="dir-pick-row-title">Browse…</span>
          </button>
        </div>
      `}
    </div>
  `;
}

// How often the Active list re-polls `claude agents --json` while this
// section is mounted — live status (busy/idle) can change between visits,
// and a session can end from elsewhere (another Clance window, a bare
// terminal, Remote Control) without Clance ever hearing about it directly.
const ACTIVE_POLL_MS = 5000;

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

function dayGroupLabel(iso) {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays <= 0) return "Recent";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Archiving is Clance-local bookkeeping (see archivedSessions.ts) — it
// never touches the actual transcript file, which is the real Claude Code
// CLI's own storage and may belong to a project that has nothing to do
// with Clance. That's also why there's no permanent-delete action here.
// Orthogonal to the Active/Closed split below (see
// docs/background-agent-architecture.md) — composes with either.
function SessionList({ sessions, emptyNote, showingArchived, onOpen, onSetArchived }) {
  if (sessions.length === 0) {
    return html`<p class="empty-note">${emptyNote}</p>`;
  }

  const groups = [];
  let currentLabel = null;
  for (const session of sessions) {
    const label = dayGroupLabel(session.lastModified);
    if (label !== currentLabel) {
      groups.push({ label, items: [] });
      currentLabel = label;
    }
    groups[groups.length - 1].items.push(session);
  }

  return html`
    ${groups.map(
      (group) => html`
        <div class="list-group">
          ${group.label !== "Recent" && html`<div class="list-group-label">${group.label}</div>`}
          ${group.items.map(
            (session) => html`
              <div class="session-row" onClick=${() => onOpen(session)}>
                <div class="session-row-main">
                  <span class="session-headline">${session.title}</span>
                  <span class="session-byline">${session.projectLabel} · ${relativeTime(session.lastModified)}</span>
                </div>
                <button
                  class="session-archive-btn"
                  title=${showingArchived ? "Restore" : "Archive"}
                  onClick=${(e) => {
                    e.stopPropagation();
                    onSetArchived(session.id, !showingArchived);
                  }}
                >
                  ${showingArchived ? "Restore" : Icon.archive(14)}
                </button>
              </div>
            `
          )}
        </div>
      `
    )}
  `;
}

// Live sessions — sourced from `claude agents --json`, polled while
// mounted. Global, not Clance-scoped: any running background agent shows
// up here, whether Clance, a bare terminal, or Remote Control started it.
function ActiveList({ agents, displayNameFor, onOpen, onClose }) {
  if (agents.length === 0) {
    return html`<p class="empty-note">No active sessions.</p>`;
  }
  return html`
    <div class="list-group">
      ${agents.map(
        (agent) => html`
          <div class="session-row" onClick=${() => onOpen(agent)}>
            <div class="session-row-main">
              <span class="session-headline">${displayNameFor(agent)}</span>
              <span class="session-byline">${agent.status ?? "running"}</span>
            </div>
            <button
              class="session-archive-btn"
              title="Close"
              onClick=${(e) => {
                e.stopPropagation();
                onClose(agent);
              }}
            >
              ${Icon.close(14)}
            </button>
          </div>
        `
      )}
    </div>
  `;
}

export function ChatsListSection({ onOpenChat, onNewChat }) {
  const [sessions, setSessions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    window.clanceApp.listChatSessions().then((result) => {
      setSessions(result);
      setLoading(false);
    });
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
  // "Clance popup") — see docs/background-agent-architecture.md — since
  // there's no real conversation yet to title it from. Once one exists,
  // prefer the same first-user-message title chatHistory.ts already
  // derives for the Closed list, so a live row reads the same way it will
  // once it moves there, rather than showing its generic birth name
  // forever. Falls back to the mint-time name for a session too new to
  // have a transcript title yet.
  const sessionTitleById = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions]);
  function displayNameFor(agent) {
    return sessionTitleById.get(agent.sessionId) || agent.name || agent.sessionId;
  }

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => displayNameFor(a).toLowerCase().includes(q));
  }, [agents, query, sessionTitleById]);

  // "Closed" is everything with history that isn't currently a live
  // background agent — see docs/background-agent-architecture.md. Opening
  // either kind goes through the same resolveOpenArgs lookup (Shell.js),
  // so there's no UI-level branching between "known stopped id" and
  // "never had one."
  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (Boolean(s.archived) !== showArchived) return false;
      if (!showArchived && liveSessionIds.has(s.id)) return false;
      if (!q) return true;
      return s.title.toLowerCase().includes(q) || s.projectLabel.toLowerCase().includes(q);
    });
  }, [sessions, query, showArchived, liveSessionIds]);

  function handleSetArchived(sessionId, archived) {
    // Optimistic — the row just needs to move out of the current view,
    // not wait on a round trip to find out it's allowed to.
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, archived } : s)));
    window.clanceApp.setSessionArchived(sessionId, archived);
  }

  function handleOpenAgent(agent) {
    // Goes through the same resolveOpenArgs lookup as any other row
    // (Shell.js's openChatTab) — it's already live, so that lookup just
    // finds it in the \`--all\` listing and returns \`attach\` args right
    // back out, no re-spawn.
    onOpenChat({ id: agent.sessionId, filePath: agent.sessionId, title: displayNameFor(agent) });
  }

  async function handleCloseAgent(agent) {
    if (!agent?.id) {
      // Seen live: `claude stop` invoked with an undefined id, meaning
      // this row's agent object had no id at click time — a stale
      // reference from a poll tick that already rotated it out, most
      // likely. Nothing sensible to close; don't shell out a garbage
      // command for it.
      console.warn("handleCloseAgent: agent has no id, skipping", agent);
      return;
    }
    // Optimistic — this is exactly what moves the row from Active to
    // Closed (see docs/background-agent-architecture.md req. 6); the next
    // poll would confirm it, but there's no reason to wait on that.
    setAgents((prev) => prev.filter((a) => a.id !== agent.id));
    await window.clanceApp.stopAgent(agent.id);
  }

  return html`
    <div class="section-page">
      <h1 class="page-title">Sessions</h1>
      <p class="page-subtitle">Browse your past work and active CLI sessions.</p>

      <div class="search-row">
        <div class="search-input">
          ${Icon.search(16)}
          <input
            type="text"
            placeholder="Search conversations…"
            value=${query}
            onInput=${(e) => setQuery(e.target.value)}
          />
        </div>
        <${NewSessionButton} onNewChat=${onNewChat} />
      </div>

      <div class="segmented">
        <button
          class="segmented-item ${!showArchived ? "segmented-item-active" : ""}"
          onClick=${() => setShowArchived(false)}
        >
          All
        </button>
        <button
          class="segmented-item ${showArchived ? "segmented-item-active" : ""}"
          onClick=${() => setShowArchived(true)}
        >
          Archived
        </button>
      </div>

      ${loading
        ? html`<p class="empty-note">Loading…</p>`
        : html`
            ${!showArchived &&
            html`
              <div class="list-group-label">Active</div>
              <${ActiveList}
                agents=${filteredAgents}
                displayNameFor=${displayNameFor}
                onOpen=${handleOpenAgent}
                onClose=${handleCloseAgent}
              />
              <div class="list-group-label">Closed</div>
            `}
            <${SessionList}
              sessions=${filteredSessions}
              emptyNote=${showArchived ? "No archived sessions." : "No closed sessions found."}
              showingArchived=${showArchived}
              onOpen=${onOpenChat}
              onSetArchived=${handleSetArchived}
            />
          `}
    </div>
  `;
}
