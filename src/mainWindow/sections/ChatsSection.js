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
          ${Icon.chevronRight(11)}
        </span>
        <span>${items.length} ${items.length === 1 ? "action" : "actions"}</span>
      </button>
      ${open &&
      html`<div class="tool-group-body">
        ${items.map(
          (item) => html`<div class="tool-group-item">
            ${item.type === "thinking" ? "✻ Thinking…" : `⏺ ${item.label}`}
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

// While a response streams in, text chunks land on the same in-progress
// assistant turn (marked __streaming) rather than each starting a new one.
function appendAssistantChunk(turns, text) {
  const last = turns[turns.length - 1];
  if (last && last.role === "assistant" && last.__streaming) {
    const blocks = last.blocks.slice();
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock && lastBlock.type === "text") {
      blocks[blocks.length - 1] = { type: "text", text: lastBlock.text + text };
    } else {
      blocks.push({ type: "text", text });
    }
    return [...turns.slice(0, -1), { ...last, blocks }];
  }
  return [...turns, { role: "assistant", blocks: [{ type: "text", text }], __streaming: true }];
}

export function ChatDetailSection({ session }) {
  const [turns, setTurns] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  function autoResizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = window.innerHeight * (2 / 3);
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  useEffect(() => {
    autoResizeTextarea();
  }, [input]);

  useEffect(() => {
    window.addEventListener("resize", autoResizeTextarea);
    // The vendored webfont can still be loading at mount, which measures
    // the wrong scrollHeight (fallback font metrics) and locks in a stale
    // size until the next keystroke — re-measure once it's actually ready,
    // and once more after the browser's settled the initial layout.
    document.fonts?.ready.then(autoResizeTextarea);
    requestAnimationFrame(autoResizeTextarea);
    return () => window.removeEventListener("resize", autoResizeTextarea);
  }, []);

  useEffect(() => {
    window.clanceApp.getChatSession(session.filePath).then((result) => {
      if (!result) {
        setLoadError(true);
        setTurns([]);
      } else {
        setTurns(result.turns);
      }
    });
  }, [session.filePath]);

  useEffect(() => {
    if (scrollRef.current) attachCopyHandler(scrollRef.current);
  }, []);

  // Auto-scroll to the newest message whenever the transcript grows.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

  useEffect(() => {
    const offChunk = window.clanceApp.onChatChunk(({ sessionId, text }) => {
      if (sessionId !== session.id) return;
      setTurns((current) => appendAssistantChunk(current ?? [], text));
    });
    const offDone = window.clanceApp.onChatDone(({ sessionId }) => {
      if (sessionId !== session.id) return;
      setSending(false);
      // Re-read the transcript from disk so any tool calls the model made
      // mid-turn (not surfaced by the live text stream) show up correctly.
      window.clanceApp.getChatSession(session.filePath).then((result) => {
        if (result) setTurns(result.turns);
      });
    });
    const offError = window.clanceApp.onChatError(({ sessionId, message }) => {
      if (sessionId !== session.id) return;
      setSending(false);
      setTurns((current) => [
        ...(current ?? []),
        { role: "assistant", blocks: [{ type: "text", text: `⚠ ${message}` }] },
      ]);
    });
    return () => {
      offChunk();
      offDone();
      offError();
    };
  }, [session.id, session.filePath]);

  function handleSend() {
    const goal = input.trim();
    if (!goal || sending) return;
    setTurns((current) => [...(current ?? []), { role: "user", blocks: [{ type: "text", text: goal }] }]);
    setInput("");
    setSending(true);
    window.clanceApp.sendChatMessage(session.id, goal);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return html`
    <div class="chat-live">
      <div class="chat-transcript" ref=${scrollRef}>
        ${turns === null
          ? html`<p class="empty-note">Loading…</p>`
          : loadError
          ? html`<p class="empty-note">Couldn't load this session.</p>`
          : turns.length === 0
          ? html`<p class="empty-note">No messages yet.</p>`
          : html`<div class="turn-list">
              ${turns.map((turn) => html`<${TurnView} turn=${turn} />`)}
            </div>`}
      </div>
      <div class="chat-composer">
        <div class="chat-composer-box">
          <button class="composer-icon-btn" title="Attachments (coming soon)">
            ${Icon.addServer(16)}
          </button>
          <textarea
            class="chat-composer-input"
            rows="1"
            ref=${textareaRef}
            placeholder="Message Clance…"
            value=${input}
            disabled=${sending}
            onInput=${(e) => setInput(e.target.value)}
            onKeyDown=${handleKeyDown}
          ></textarea>
          <span class="composer-model-label">Haiku 4.5</span>
          ${input.trim()
            ? html`<button
                class="composer-send-btn"
                title="Send"
                disabled=${sending}
                onClick=${handleSend}
              >
                ${Icon.arrowUp(15)}
              </button>`
            : html`<button class="composer-icon-btn" title="Voice input (coming soon)">
                ${Icon.mic(16)}
              </button>`}
        </div>
      </div>
    </div>
  `;
}
