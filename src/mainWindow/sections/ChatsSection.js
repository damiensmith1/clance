import { html, useEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { renderMarkdown, attachCopyHandler } from "../../shared/markdown.js";
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

// Clance's own sessions live under one fixed bucket labeled "Clance" by
// chatHistory.ts; anything else came from a real Claude Code CLI project.
function isCliSession(session) {
  return session.projectLabel !== "Clance";
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

export function ChatsListSection({ onOpenChat }) {
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
      </div>

      <${SessionList} sessions=${filtered} loading=${loading} onOpen=${onOpenChat} />
    </div>
  `;
}

function ToolGroup({ items }) {
  const [open, setOpen] = useState(false);
  return html`
    <div class="tool-group">
      <button class="tool-group-header" onClick=${() => setOpen(!open)}>
        <span class="tool-group-chevron ${open ? "tool-group-chevron-open" : ""}">
          ${Icon.chevronRight(14)}
        </span>
        ${Icon.search(14)}
        <span>THOUGHT & TOOL EXECUTION</span>
      </button>
      ${open &&
      html`<div class="tool-group-body">
        ${items.map(
          (item) => html`<div class="tool-group-item">
            ${item.type === "thinking" ? "💭 Thinking…" : item.label}
          </div>`
        )}
      </div>`}
    </div>
  `;
}

// Consecutive tool/thinking blocks within a turn collapse into one
// disclosure group; text blocks render as markdown in between.
function groupBlocks(blocks) {
  const groups = [];
  for (const block of blocks) {
    if (block.type === "text") {
      groups.push({ kind: "text", block });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.kind === "tools") last.items.push(block);
      else groups.push({ kind: "tools", items: [block] });
    }
  }
  return groups;
}

function TurnView({ turn }) {
  const groups = groupBlocks(turn.blocks);
  const isUser = turn.role === "user";
  return html`
    <div class="turn-row">
      <span class="avatar ${isUser ? "avatar-user" : "avatar-assistant"}">
        ${isUser ? Icon.person(15) : Icon.robot(15)}
      </span>
      <div class="turn-body">
        <div class="turn-label">${isUser ? "YOU" : "CLANCE"}</div>
        ${groups.map((group) =>
          group.kind === "text"
            ? html`<div
                class="turn-text"
                dangerouslySetInnerHTML=${{ __html: renderMarkdown(group.block.text) }}
              ></div>`
            : html`<${ToolGroup} items=${group.items} />`
        )}
      </div>
    </div>
  `;
}

export function ChatDetailSection({ session }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef(null);

  useEffect(() => {
    window.clanceApp.getChatSession(session.filePath).then((result) => {
      setDetail(result);
      setLoading(false);
    });
  }, [session.filePath]);

  useEffect(() => {
    if (containerRef.current) attachCopyHandler(containerRef.current);
  }, []);

  const cli = isCliSession(session);

  return html`
    <div class="section-page" ref=${containerRef}>
      ${loading
        ? html`<p class="empty-note">Loading…</p>`
        : !detail
        ? html`<p class="empty-note">Couldn't load this session.</p>`
        : html`
            <div class="detail-meta-row">
              <span class="pill pill-strong">${cli ? "CLI SESSION" : "CLANCE SESSION"}</span>
              ${cli && html`<span class="detail-meta-text">project: ${detail.projectLabel}</span>`}
            </div>
            <div class="detail-title-row">
              <h1 class="page-title">${detail.title}</h1>
              <button
                class="btn-secondary"
                onClick=${() =>
                  window.clanceApp.continueSessionInPopup({
                    id: session.id,
                    filePath: session.filePath,
                    title: detail.title,
                  })}
              >
                Continue in Popup
              </button>
            </div>
            <div class="turn-list">
              ${detail.turns.map((turn) => html`<${TurnView} turn=${turn} />`)}
            </div>
          `}
    </div>
  `;
}
