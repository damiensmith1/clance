import { html, useEffect, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { renderMarkdown } from "../../shared/markdown.js";

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

function SessionList({ sessions, loading, onSelect }) {
  if (loading) {
    return html`<p class="chat-history-empty">Loading…</p>`;
  }
  if (sessions.length === 0) {
    return html`<p class="chat-history-empty">No past sessions found.</p>`;
  }
  return html`
    <div class="chat-history-list">
      ${sessions.map(
        (session) => html`
          <button class="chat-history-item" onClick=${() => onSelect(session)}>
            <span class="chat-history-item-title">${session.title}</span>
            <span class="chat-history-item-meta">
              ${session.projectLabel} · ${relativeTime(session.lastModified)}
            </span>
          </button>
        `
      )}
    </div>
  `;
}

function TurnBlock({ block }) {
  if (block.type === "text") {
    return html`<div
      class="chat-turn-text"
      dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }}
    ></div>`;
  }
  if (block.type === "thinking") {
    return html`<div class="chat-turn-thinking">💭 Thinking…</div>`;
  }
  return html`<div class="chat-turn-tool">${block.label}</div>`;
}

function SessionDetailView({ detail, loading, onBack }) {
  return html`
    <div class="chat-history-detail">
      <button class="chat-history-back" onClick=${onBack}>&larr; Back</button>
      ${loading
        ? html`<p class="chat-history-empty">Loading…</p>`
        : !detail
        ? html`<p class="chat-history-empty">Couldn't load this session.</p>`
        : html`
            <h3 class="chat-history-detail-title">${detail.title}</h3>
            <p class="chat-history-detail-meta">${detail.projectLabel}</p>
            <div class="chat-history-transcript">
              ${detail.turns.map(
                (turn) => html`
                  <div class="chat-turn chat-turn-${turn.role}">
                    ${turn.blocks.map((block) => html`<${TurnBlock} block=${block} />`)}
                  </div>
                `
              )}
            </div>
          `}
    </div>
  `;
}

export function ChatsSection() {
  const [sessions, setSessions] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  function loadSessions() {
    setLoadingList(true);
    window.clanceApp.listChatSessions().then((result) => {
      setSessions(result);
      setLoadingList(false);
    });
  }

  useEffect(() => {
    loadSessions();
  }, []);

  function handleSelect(session) {
    setSelected(session);
    setDetail(null);
    setLoadingDetail(true);
    window.clanceApp.getChatSession(session.filePath).then((result) => {
      setDetail(result);
      setLoadingDetail(false);
    });
  }

  function handleBack() {
    setSelected(null);
    setDetail(null);
    loadSessions();
  }

  if (selected) {
    return html`<${SessionDetailView} detail=${detail} loading=${loadingDetail} onBack=${handleBack} />`;
  }

  return html`
    <div class="section-chats">
      <h2>Chats</h2>
      <${SessionList} sessions=${sessions} loading=${loadingList} onSelect=${handleSelect} />
    </div>
  `;
}
