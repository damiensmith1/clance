import { html, useEffect, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";
import { renderMarkdown, attachCopyHandler } from "../../shared/markdown.js";

// Quick Look for a session: what was said, without attaching a terminal to
// it. Reads the parsed transcript from chatHistory.ts's peekSession — a
// bounded, already-summarised payload, so there's nothing to page or
// virtualise here. Read-only by design: everything that changes a session
// stays in the row's own menu.

// Compact by default (see docs/design.md, "Peeking at a session"): tool
// calls are one line each, and their output is behind the footer's toggle.
const ROLE_LABEL = { user: "You", assistant: "Claude" };

// How far one press of ↑/↓ moves the conversation. A little more than
// Chromium's own 40px step, which is short for text this size.
const SCROLL_STEP_PX = 48;

// "claude-sonnet-5" reads as "sonnet-5" once you know every session here is
// Claude's; the vendor prefix is the only part that's never news.
function shortModel(model) {
  return model ? model.replace(/^claude-/, "") : null;
}

function relativeWhen(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// How long the conversation itself ran, first message to last — the one
// number that separates "asked a quick question" from "worked all evening".
// Omitted under a minute, where it says nothing.
function spanLabel(startedAt, lastMessageAt) {
  if (!startedAt || !lastMessageAt) return null;
  const minutes = Math.round((new Date(lastMessageAt).getTime() - new Date(startedAt).getTime()) / 60000);
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes}m long`;
  return `${Math.round(minutes / 6) / 10}h long`;
}

function ToolBlock({ block, details }) {
  return html`
    <div class="peek-tool ${block.failed ? "peek-tool-failed" : ""}">
      <span class="peek-tool-name">${block.name}</span>
      ${block.target && html`<span class="peek-tool-target">${block.target}</span>`}
    </div>
    ${details && block.result && html`<div class="peek-tool-result">${block.result}</div>`}
  `;
}

// Consecutive tool calls are one run of work, not several things said, so
// they're drawn as a single indented cluster between the sentences around
// them rather than as separate lines spaced like prose.
function groupBlocks(blocks) {
  const groups = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (block.type === "tool" && last?.kind === "tools") last.blocks.push(block);
    else if (block.type === "tool") groups.push({ kind: "tools", blocks: [block] });
    else groups.push({ kind: "block", block });
  }
  return groups;
}

// Claude's replies are markdown; the user's own messages are shown as
// typed, since a person's prompt is plain text they wrote, not a document
// to re-format.
//
// renderMarkdown HTML-escapes every character of its input before it
// introduces a single tag of its own (see markdown.js), so a transcript
// that happens to contain markup renders as the text it is rather than as
// DOM — which is what makes setting this innerHTML safe.
function TextBlock({ text, role }) {
  const ref = useRef(null);
  useEffect(() => {
    if (role === "assistant" && ref.current) attachCopyHandler(ref.current);
  }, [role]);
  if (role === "user") return html`<div class="peek-text peek-text-plain">${text}</div>`;
  return html`<div
    class="peek-text peek-md"
    ref=${ref}
    dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}
  ></div>`;
}

function Turn({ turn, details }) {
  return html`
    <div class="peek-turn peek-turn-${turn.role}">
      <div class="peek-role">${ROLE_LABEL[turn.role]}</div>
      <div class="peek-blocks">
        ${groupBlocks(turn.blocks).map((group, index) => {
          if (group.kind === "tools")
            return html`<div key=${index} class="peek-tools">
              ${group.blocks.map((block, i) => html`<${ToolBlock} key=${i} block=${block} details=${details} />`)}
            </div>`;
          const block = group.block;
          if (block.type === "text") return html`<${TextBlock} key=${index} text=${block.text} role=${turn.role} />`;
          if (block.type === "command") return html`<div key=${index} class="peek-command">/${block.name}</div>`;
          return null;
        })}
      </div>
    </div>
  `;
}

export function SessionPeek({ sessionId, onClose, onOpen, onPopOut }) {
  const [peek, setPeek] = useState(null);
  const [failed, setFailed] = useState(false);
  const [details, setDetails] = useState(false);
  const bodyRef = useRef(null);
  // Whether the reader was at the end when they asked for tool output, so
  // expanding it can keep them there (see toggleDetails).
  const atEndRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    window.clanceApp
      .peekSession(sessionId)
      .then((result) => {
        if (cancelled) return;
        if (result) setPeek(result);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Focus lands on the scrolling region itself, not the panel around it, so
  // the keys this doesn't handle below — Page Up/Down, Home, End — still
  // scroll the conversation natively. Either way it's off the table behind.
  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  // Opens at the end of the conversation — where a session got to is the
  // thing you peek for, and it's also the end that `peekSession` keeps when
  // a transcript is too long to send whole. Scrolling up walks back in time.
  useEffect(() => {
    if (!peek || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [peek]);

  // Showing tool output grows every turn at once, which would otherwise
  // slide the page out from under whatever was being read. Someone at the
  // end stays at the end; someone who had scrolled up to a particular call
  // keeps their place, which is the whole reason they opened the output.
  function toggleDetails() {
    const body = bodyRef.current;
    atEndRef.current = body ? body.scrollHeight - body.clientHeight - body.scrollTop < 8 : true;
    setDetails(!details);
  }

  useEffect(() => {
    if (!bodyRef.current || !atEndRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [details]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Space closes it the same way it opened it. Not while a control has
      // focus, where Space is that button's own key, and never without
      // preventDefault — Space would otherwise page the body as it left.
      if (e.key === " " && !e.target?.closest?.("button, input, textarea, [contenteditable]")) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // ↑/↓ read the conversation. Handled rather than left to the browser
      // so they work wherever focus sits — the footer's buttons included —
      // and so they can't reach the table underneath and move its selection.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        bodyRef.current?.scrollBy({ top: e.key === "ArrowDown" ? SCROLL_STEP_PX : -SCROLL_STEP_PX });
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const meta = peek
    ? [
        peek.projectLabel,
        peek.gitBranch,
        shortModel(peek.model),
        `${peek.messageCount} message${peek.messageCount === 1 ? "" : "s"}`,
        spanLabel(peek.startedAt, peek.lastMessageAt),
        peek.lastMessageAt ? relativeWhen(peek.lastMessageAt) : null,
      ].filter(Boolean)
    : [];

  return html`
    <div class="peek-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="peek-panel" role="dialog" aria-modal="true" aria-label="Session preview">
        <div class="peek-header">
          <div class="peek-header-text">
            <span class="peek-title">${peek ? peek.title : failed ? "Session unavailable" : "Loading…"}</span>
            ${meta.length > 0 && html`<span class="peek-meta">${meta.join(" · ")}</span>`}
          </div>
          <button class="icon-button" title="Close" aria-label="Close" onClick=${onClose}>${Icon.close(14)}</button>
        </div>

        <div class="peek-body" tabindex="-1" ref=${bodyRef}>
          ${failed
            ? html`<p class="empty-note">
                This session's transcript isn't on this machine any more — it may have been cleared by the
                Claude Code CLI.
              </p>`
            : !peek
              ? html`<div class="peek-loading" aria-busy="true">
                  ${[280, 180, 320, 240].map(
                    (width) => html`<span class="skeleton" style=${{ width: `${width}px` }}></span>`
                  )}
                </div>`
              : peek.turns.length === 0
                ? html`<p class="empty-note">Nothing was said in this session yet.</p>`
                : html`
                    ${peek.truncated &&
                    html`<p class="peek-truncated">
                      Long session — this is how it ended. Open it to read the earlier messages.
                    </p>`}
                    ${peek.turns.map((turn, index) => html`<${Turn} key=${index} turn=${turn} details=${details} />`)}
                  `}
        </div>

        <div class="peek-footer">
          <button
            class="btn-quiet btn-small"
            aria-pressed=${details}
            onClick=${toggleDetails}
            disabled=${!peek}
          >
            ${details ? "Hide tool output" : "Show tool output"}
          </button>
          <span class="peek-footer-spacer"></span>
          <button
            class="icon-button"
            title="Open in floating window"
            aria-label="Open in floating window"
            onClick=${onPopOut}
          >
            ${Icon.popOut(15)}
          </button>
          <button class="btn-primary" onClick=${onOpen}>Open</button>
        </div>
      </div>
    </div>
  `;
}
