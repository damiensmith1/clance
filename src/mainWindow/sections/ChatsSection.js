import { html, useEffect, useMemo, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";

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

function SessionList({ sessions, loading, onOpen }) {
  if (loading) {
    return html`<p class="empty-note">Loading…</p>`;
  }
  if (sessions.length === 0) {
    return html`<p class="empty-note">No past sessions found.</p>`;
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
          <div class="list-group-label">${group.label}</div>
          ${group.items.map(
            (session) => html`
              <button class="session-row" onClick=${() => onOpen(session)}>
                <span class="session-headline">${session.title}</span>
                <span class="session-byline">${session.projectLabel} · ${relativeTime(session.lastModified)}</span>
              </button>
            `
          )}
        </div>
      `
    )}
  `;
}

export function ChatsListSection({ onOpenChat, onNewChat }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    window.clanceApp.listChatSessions().then((result) => {
      setSessions(result);
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.title.toLowerCase().includes(q) || s.projectLabel.toLowerCase().includes(q)
    );
  }, [sessions, query]);

  return html`
    <div class="section-page">
      <h1 class="page-title">Conversation History</h1>
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
        <button class="btn-primary" onClick=${onNewChat}>New Chat</button>
      </div>

      <${SessionList} sessions=${filtered} loading=${loading} onOpen=${onOpenChat} />
    </div>
  `;
}
