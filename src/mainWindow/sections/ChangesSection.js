import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { useTabState, useTabScroll } from "../state/tabState.js";
import { useWorkSnapshot, useFocus, setFocus, getFocus } from "../state/workStore.js";
import { Icon } from "../../shared/icons.js";

// The Changes pane: a monitor, not a reader. It lives in a narrow pane on the
// right and says what is moving in one place — a checkout (the repository's
// own folder or one of its worktrees), a branch checked out nowhere, or what a
// past session did — and hands the reading to a tab: a file's diff opens in a
// diff tab, its text in a file tab. What it shows is picked in the Work tab,
// or here from the repository and branch menus. See docs/design.md's "Work".
//
// It reads git through the main process (src/main/git.ts, work.ts); nothing
// here shells out or touches the filesystem.

/** Commits read per refresh. More than any pane shows; the rest are spare capacity. */
const HISTORY_FETCH = 60;
/** Must match .commit-row's height — the fit-to-space maths below counts in rows. */
const COMMIT_ROW_HEIGHT = 26;

const STATUS_LABEL = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
  unchanged: "·",
};

/**
 * What makes a file "the same as when you last looked". The staged/unstaged
 * codes as well as the counts, so staging a file already seen doesn't re-flag
 * it but a fresh edit to it does.
 */
function signature(file) {
  return `${file.index}${file.worktree}:${file.insertions}:${file.deletions}`;
}

/** Splits a repo-relative path so the name can carry the weight and the rest can recede. */
function splitPath(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

function baseName(path) {
  return (path ?? "").split("/").filter(Boolean).pop() ?? path;
}

function tildePath(dir) {
  return (dir ?? "").replace(/^\/Users\/[^/]+/, "~");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- surviving a remount ----
//
// Moving the pane, splitting, or switching away from its tab and back all
// unmount this section. Everything it knew about what it was showing — the
// status, commits, remote, file lists, the draft commit message, what's been
// seen — is the tab's state (state/tabState.js), so it comes back drawn at
// once and then refreshes quietly, instead of starting over behind
// "Reading…". The list's scroll is the tab's too. All of it goes when the
// tab closes.

function emptyMemory() {
  return { status: null, commits: null, remote: null, message: "", seen: new Map(), newPaths: new Set(), files: new Map() };
}

// Short and mono, the way the Work table and Dictation print times.
function relativeTime(iso) {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
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

/**
 * Commits under the files: the ones this work is made of (not on the base
 * yet, or not pushed), else the last few, so a commit can be seen to land and
 * the pane still says something when the tree is clean. Clicking one shows
 * its files above; clicking it again goes back. It fits the space it's given
 * and never scrolls.
 */
function History({ label, commits, selected, onSelect, onContextMenu, remote, onOpenRemote }) {
  const listRef = useRef(null);
  // As many as the space holds, rather than a fixed ten that either scrolls or
  // leaves a gap. The list itself never scrolls: it fills the room between the
  // commit box and the remote button exactly, and re-measures when the pane is
  // resized. Layout effect, so the count is right on the first paint.
  const [capacity, setCapacity] = useState(0);
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = () => setCapacity(Math.floor(element.clientHeight / COMMIT_ROW_HEIGHT));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [commits === null, commits?.length === 0]);

  const shown = commits ? commits.slice(0, Math.max(capacity, 0)) : [];
  // With no room for even one row the strip says nothing, so its label goes
  // too. The list element itself stays mounted either way, because it's what
  // gets measured.
  const roomForAny = capacity >= 1;

  return html`
    <section class="changes-history">
      ${(commits === null || commits.length === 0 || roomForAny) && html`<div class="changes-history-head">${label}</div>`}
      ${commits === null
        ? html`<p class="changes-history-empty">Reading…</p>`
        : commits.length === 0
          ? html`<p class="changes-history-empty">No commits yet.</p>`
          : html`
              <div class="changes-history-list" ref=${listRef}>
                ${shown.map(
                  (commit) => html`
                    <button
                      class="commit-row ${selected === commit.sha ? "commit-row-on" : ""}"
                      key=${commit.sha}
                      title=${`${commit.subject}\n${commit.author ?? ""}`}
                      aria-pressed=${selected === commit.sha}
                      onClick=${() => onSelect(commit)}
                      onContextMenu=${(e) => onContextMenu?.(e, commit)}
                    >
                      <span class="commit-subject">${commit.subject}</span>
                      <span class="commit-when">${relativeTime(commit.date)}</span>
                      <span class="commit-sha">${commit.short}</span>
                    </button>
                  `
                )}
              </div>
            `}
      ${remote &&
      html`<button class="btn-quiet btn-small changes-remote" onClick=${onOpenRemote}>Open on ${remote.host} ↗</button>`}
    </section>
  `;
}

/**
 * Every checkout of the repository and every branch checked out nowhere.
 * Picking one shows it here; nothing on disk moves. A branch looked at this
 * way can be opened as a worktree, from the line under the header.
 */
function BranchMenu({ repo, items, sessions, focus, onPick }) {
  const checkouts = items.filter((item) => item.root === repo?.root && item.kind === "checkout");
  const branches = items.filter((item) => item.root === repo?.root && item.kind === "branch");
  const isCurrent = (item) =>
    (focus?.kind === "checkout" && item.checkout === focus.dir) || (focus?.kind === "branch" && item.branch === focus.branch);
  const live = (item) => sessions.some((s) => s.checkouts.includes(item.checkout) && (s.state === "working" || s.state === "needs"));
  return html`
    <div class="menu changes-branches">
      ${!repo
        ? html`<div class="branch-note">Reading…</div>`
        : html`
            <div class="menu-label">checked out</div>
            <div class="branch-list">
              ${checkouts.map(
                (item) => html`
                  <button class="menu-item branch-row ${isCurrent(item) ? "menu-item-active" : ""}" key=${item.id} title=${tildePath(item.checkout)} onClick=${() => onPick(item)}>
                    <span class="branch-dot">${live(item) ? html`<span class="status-dot status-dot-live"></span>` : isCurrent(item) ? "●" : ""}</span>
                    <span class="branch-name">${item.branch ?? "detached"}</span>
                    <span class="branch-track">
                      ${item.uncommitted?.files > 0 && html`<span>${item.uncommitted.files} changed</span>`}
                      <span class="branch-local">${item.main ? "folder" : "worktree"}</span>
                    </span>
                  </button>
                `
              )}
            </div>
            ${branches.length > 0 &&
            html`
              <div class="menu-separator"></div>
              <div class="menu-label">not checked out</div>
              <div class="branch-list">
                ${branches.map((item) => {
                  const b = item.branchState;
                  return html`
                    <button class="menu-item branch-row ${isCurrent(item) ? "menu-item-active" : ""}" key=${item.id} title=${b.subject} onClick=${() => onPick(item)}>
                      <span class="branch-dot">${isCurrent(item) ? "●" : ""}</span>
                      <span class="branch-name">${item.branch}</span>
                      <span class="branch-track">
                        ${b.ahead === 0 && !b.isBase
                          ? html`<span class="branch-local">merged</span>`
                          : html`${b.ahead > 0 && html`<span class="change-ins">↑${b.ahead}</span>`}${b.behind > 0 && html`<span class="change-del">↓${b.behind}</span>`}`}
                      </span>
                      <span class="branch-when">${relativeTime(b.date)}</span>
                    </button>
                  `;
                })}
              </div>
            `}
            <div class="branch-note">Shows it here. Nothing on disk moves.</div>
          `}
    </div>
  `;
}

/** One changed file in the working tree: stage it, open its diff, or (from its menu) discard it. */
function FileRow({ file, isNew, onOpen, onKeep, onToggleStage, onContextMenu, confirming, onConfirmDiscard, onCancelDiscard }) {
  const { dir, name } = splitPath(file.path);
  return html`
    <div class="change-item">
      <div class="change-row ${confirming ? "change-row-confirming" : ""}" onClick=${onOpen} onDblClick=${onKeep} onContextMenu=${onContextMenu}>
        <button
          class="change-check ${file.staged ? "change-check-on" : ""}"
          title=${file.staged ? "Staged — click to unstage" : "Not staged — click to stage"}
          aria-pressed=${file.staged}
          onClick=${(event) => {
            event.stopPropagation();
            onToggleStage(file);
          }}
          onDblClick=${(event) => event.stopPropagation()}
        >
          ${file.staged ? Icon.check(10) : null}
        </button>
        <span class="change-status change-status-${file.status}">${STATUS_LABEL[file.status] ?? "M"}</span>
        <span class="change-path" title=${file.from ? `${file.from} → ${file.path}` : file.path}>
          <span class="change-dir">${dir}</span><span class="change-name">${name}</span>
        </span>
        ${isNew && html`<span class="change-new" title="Changed since you last looked"></span>`}
        <span class="change-counts">
          ${file.insertions > 0 && html`<span class="change-ins">+${file.insertions}</span>`}
          ${file.deletions > 0 && html`<span class="change-del">−${file.deletions}</span>`}
          ${file.binary && html`<span class="change-binary">bin</span>`}
        </span>
      </div>
      ${confirming &&
      html`
        <div class="change-confirm">
          <span class="change-confirm-text">Throw away the changes to ${name}?</span>
          <button class="btn-danger btn-small" onClick=${onConfirmDiscard}>Discard</button>
          <button class="btn-quiet btn-small" onClick=${onCancelDiscard}>Cancel</button>
        </div>
      `}
    </div>
  `;
}

/** A file in a commit or across a branch: what happened to it and its counts. Opens its diff. */
function RangeRow({ file, onOpen, onKeep, note }) {
  const { dir, name } = splitPath(file.path);
  return html`
    <div class="change-item">
      <div class="change-row change-row-range" onClick=${onOpen} onDblClick=${onKeep}>
        <span class="change-status change-status-${file.status}">${STATUS_LABEL[file.status] ?? "M"}</span>
        <span class="change-path" title=${file.from ? `${file.from} → ${file.path}` : file.path}>
          <span class="change-dir">${dir}</span><span class="change-name">${name}</span>
        </span>
        <span class="change-counts">
          ${file.insertions > 0 && html`<span class="change-ins">+${file.insertions}</span>`}
          ${file.deletions > 0 && html`<span class="change-del">−${file.deletions}</span>`}
          ${file.binary && html`<span class="change-binary">bin</span>`}
          ${note && html`<span class="change-binary">${note}</span>`}
        </span>
      </div>
    </div>
  `;
}

/** A question before anything that removes or rewrites: what will happen, and what was checked. In the pane, not over it. */
function Confirm({ confirm, onCancel }) {
  return html`
    <div class="changes-confirm" role="alertdialog" aria-label=${confirm.title}>
      <span class="changes-confirm-title">${confirm.title}</span>
      ${confirm.checks?.map(([ok, text]) => html`<span class="changes-check ${ok ? "changes-check-ok" : "changes-check-warn"}">${ok ? "✓" : "!"} ${text}</span>`)}
      ${confirm.body && html`<span class="changes-confirm-body">${confirm.body}</span>`}
      <span class="changes-confirm-actions">
        <button class="btn-quiet btn-small" onClick=${onCancel}>Cancel</button>
        <button class="${confirm.danger ? "btn-danger" : "btn-secondary"} btn-small" disabled=${confirm.blocked} onClick=${confirm.onConfirm}>${confirm.action}</button>
      </span>
    </div>
  `;
}

/** The sessions working in this checkout: what they're doing, and a way in. */
function SessionLines({ sessions, onOpen, onReply }) {
  const [replying, setReplying] = useState(null);
  const [text, setText] = useState("");
  return html`
    <div class="changes-sessions">
      ${sessions.map(
        (session) => html`
          <div class="changes-session" key=${session.sessionId}>
            <span class="status-dot ${session.state === "working" ? "status-dot-live" : session.state === "needs" || session.state === "failed" ? "session-dot-attention" : ""}"></span>
            <span class="changes-session-title" title=${session.lastReport ?? ""}>${session.title}</span>
            <span class="changes-session-state ${session.state === "needs" ? "changes-session-state-attention" : ""}">${session.state === "needs" ? "needs you" : session.state}</span>
            <button class="btn-quiet btn-small" onClick=${() => onOpen(session)}>Open</button>
            <button class="btn-quiet btn-small" onClick=${() => { setReplying(session.sessionId); setText(""); }}>Reply</button>
          </div>
          ${replying === session.sessionId &&
          html`
            <div class="changes-reply">
              <input
                class="text-field"
                placeholder=${`Reply to ${session.title}`}
                aria-label="Reply to the session"
                value=${text}
                ref=${(el) => el && !el.dataset.focused && ((el.dataset.focused = "1"), el.focus())}
                onInput=${(e) => setText(e.target.value)}
                onKeyDown=${(e) => {
                  if (e.key === "Enter" && text.trim()) {
                    onReply(session, text.trim());
                    setReplying(null);
                  } else if (e.key === "Escape") setReplying(null);
                }}
              />
            </div>
          `}
        `
      )}
    </div>
  `;
}

export function ChangesSection({ onOpenDiff, onOpenFile, onOpenInLode, onOpenSession, onNewSession, onOpenTerminal, onReply }) {
  const snapshot = useWorkSnapshot();
  const focus = useFocus();
  const [memory] = useTabState("changes.memory", () => new Map());
  const [scopes, setScopes] = useTabState("changes.scopes", () => new Map());
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [discarding, setDiscarding] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const repoRef = useRef(null);
  const listRef = useRef(null);

  // Nothing picked yet: the repository the pane was last pointed at.
  useEffect(() => {
    if (getFocus()) return;
    window.clanceApp.gitGetLastRepo().then((root) => {
      if (root && !getFocus()) setFocus({ kind: "checkout", root, dir: root });
    });
  }, []);

  const focusKey = !focus ? "" : focus.kind === "checkout" ? `co:${focus.dir}` : focus.kind === "branch" ? `br:${focus.root}:${focus.branch}` : `s:${focus.sessionId}`;
  const items = snapshot?.items ?? [];
  const sessions = snapshot?.sessions ?? [];
  const item = items.find((candidate) => candidate.id === focusKey) ?? null;
  const repoRoot = focus?.kind === "checkout" ? item?.root ?? focus.root : focus?.root ?? null;
  const repo = (snapshot?.repos ?? []).find((candidate) => candidate.root === repoRoot) ?? null;
  const dir = focus?.kind === "checkout" ? focus.dir : focus?.kind === "branch" ? repo?.root ?? focus.root : null;
  const here = focus?.kind === "checkout" ? sessions.filter((s) => s.checkouts.includes(focus.dir)) : [];
  const b = item?.branchState ?? null;

  // ---- what's remembered for what's shown ----

  if (dir && !memory.has(focusKey)) memory.set(focusKey, emptyMemory());
  const mem = dir ? memory.get(focusKey) : null;
  const [status, setStatus] = useState(mem?.status ?? null);
  const [commits, setCommits] = useState(mem?.commits ?? null);
  const [remote, setRemote] = useState(mem?.remote ?? null);
  const [message, setMessage] = useState(mem?.message ?? "");
  const [newPaths, setNewPaths] = useState(() => mem?.newPaths ?? new Set());
  const seenRef = useRef(mem?.seen ?? new Map());
  const focusRef = useRef(focusKey);

  // Saved back as it changes — but not on the render where the focus has
  // just moved: the state then still holds what the last checkout showed,
  // and saving it would hand that checkout's files (and "seen" marks) to
  // this one.
  useEffect(() => {
    if (mem && focusRef.current === focusKey) Object.assign(mem, { status, commits, remote, message, newPaths, seen: seenRef.current });
  }, [focusKey, status, commits, remote, message, newPaths]);

  useTabScroll(listRef, focus ? "changes.list" : null, { version: focusKey });

  // What the commit strip lists: the commits this work is made of, else the
  // last few.
  const commitRange = item?.commits ?? null;
  async function readCommits(key = focusRef.current) {
    if (!dir) return;
    const next = await window.clanceApp.workCommits(dir, commitRange?.from ?? null, commitRange?.to ?? "HEAD", HISTORY_FETCH);
    if (focusRef.current === key) setCommits(next ?? []);
  }

  async function refresh(key = focusRef.current) {
    if (focus?.kind !== "checkout") return readCommits(key);
    const next = await window.clanceApp.gitStatus(focus.dir);
    // A switch that happened while this was in flight wins.
    if (focusRef.current !== key) return;
    setStatus(next);
    await readCommits(key);
  }

  useEffect(() => {
    focusRef.current = focusKey;
    seenRef.current = mem?.seen ?? new Map();
    setStatus(mem?.status ?? null);
    setCommits(mem?.commits ?? null);
    setRemote(mem?.remote ?? null);
    setMessage(mem?.message ?? "");
    setNewPaths(mem?.newPaths ?? new Set());
    setError(null);
    setNote(null);
    setConfirm(null);
    setMenu(null);
    if (!focus || focus.kind === "session") return;
    if (repoRoot) {
      window.clanceApp.gitRemote(repoRoot).then((next) => focusRef.current === focusKey && setRemote(next));
      window.clanceApp.gitSetLastRepo(repoRoot);
    }
    refresh(focusKey);
    if (focus.kind !== "checkout") return;
    // One watch at a time, following the checkout shown. The main process
    // debounces the filesystem events; this just re-reads when one gets
    // through.
    window.clanceApp.gitWatch(focus.dir);
    const off = window.clanceApp.onGitChanged(() => {
      if (focusRef.current === focusKey) refresh(focusKey);
    });
    return () => {
      off();
      window.clanceApp.gitUnwatch();
    };
  }, [focusKey]);

  // The commits this work is made of can change without a file changing
  // here (a merge elsewhere moves the base): re-read when the model says so.
  const commitSignature = `${commitRange?.from}:${commitRange?.to}:${b?.sha}`;
  useEffect(() => {
    if (dir && focus?.kind !== "session") readCommits(focusKey);
  }, [commitSignature]);

  // Menus that only close by pressing the thing that opened them are traps.
  useEffect(() => {
    if (!menu && !contextMenu) return;
    function onDown(event) {
      if (event.target.closest?.(".menu")) return;
      if (menu && repoRef.current?.contains(event.target)) return;
      setMenu(null);
      setContextMenu(null);
    }
    function onKey(event) {
      if (event.key === "Escape") {
        setMenu(null);
        setContextMenu(null);
      }
    }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu, contextMenu]);

  // What moved while the user was looking elsewhere. The first listing for a
  // checkout is the baseline — otherwise opening the pane would light every
  // row up and the mark would mean nothing.
  useEffect(() => {
    if (!status) return;
    const seen = seenRef.current;
    const first = seen.size === 0;
    const next = new Set();
    for (const file of status.files) {
      const sig = signature(file);
      if (first) seen.set(file.path, sig);
      else if (seen.get(file.path) !== sig) next.add(file.path);
    }
    setNewPaths(next);
  }, [status]);

  // ---- which files: the scope ----
  //
  // A checkout shows what's uncommitted, or everything its branch changed
  // (against the base, or for the base itself what isn't pushed); a branch
  // checked out nowhere, everything it changed. A commit picked in the strip
  // shows that commit's files instead.

  const committed = b ? (b.isBase ? b.unpushed : b.ahead) : 0;
  const branchScope =
    item?.range && (committed > 0 || focus?.kind === "branch")
      ? { id: "branch", label: b?.isBase ? "Unpushed" : focus?.kind === "branch" ? `vs ${item.base}` : "Whole branch", range: item.range }
      : null;
  const scopeOptions = focus?.kind === "checkout" ? [{ id: "uncommitted", label: "Uncommitted" }, ...(branchScope ? [branchScope] : [])] : branchScope ? [branchScope] : [];
  const scopeId = scopes.get(focusKey) ?? scopeOptions[0]?.id ?? null;
  const pickedCommit = commits?.find((commit) => commit.sha === scopeId) ?? null;
  const scope = pickedCommit
    ? { id: pickedCommit.sha, range: { from: pickedCommit.parent, to: pickedCommit.sha }, commit: pickedCommit }
    : scopeOptions.find((option) => option.id === scopeId) ?? scopeOptions[0] ?? null;
  function setScope(id) {
    setScopes((current) => new Map(current).set(focusKey, id));
  }

  // A range's files, read when the scope or the repository changes. The last
  // list stays on screen while the next is read, so nothing blinks.
  const [rangeFiles, setRangeFiles] = useState(null);
  const rangeKey = scope?.range ? `${dir}:${scope.range.from}:${scope.range.to}` : null;
  const rangeSignature = `${rangeKey}:${item?.total?.files}:${item?.total?.insertions}:${item?.total?.deletions}`;
  useEffect(() => {
    if (!rangeKey || !dir) return;
    let cancelled = false;
    const remembered = mem?.files.get(rangeKey);
    setRangeFiles(remembered ?? null);
    window.clanceApp.workFiles(dir, scope.range).then((next) => {
      if (cancelled) return;
      mem?.files.set(rangeKey, next ?? []);
      setRangeFiles(next ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [rangeSignature]);

  // A past session's edits and commits.
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (focus?.kind !== "session") return;
    let cancelled = false;
    setDetail(null);
    window.clanceApp.workSession(focus.sessionId).then((next) => !cancelled && setDetail(next ?? { repos: [], elsewhere: 0 }));
    return () => {
      cancelled = true;
    };
  }, [focusKey]);

  const files = status?.files ?? [];
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const totals = useMemo(
    () => files.reduce((sum, f) => ({ insertions: sum.insertions + f.insertions, deletions: sum.deletions + f.deletions }), { insertions: 0, deletions: 0 }),
    [files]
  );

  // ---- actions ----

  // Every action reports what git said rather than assuming it worked — a
  // push that was refused, a commit blocked by a hook, a discard that hit a
  // permission error all have to reach the user.
  async function run(label, fn, onDone) {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      const result = await fn();
      if (result && result.ok === false) setError(result.error ?? "Something went wrong");
      else onDone?.(result);
      return result;
    } finally {
      setBusy(null);
      refresh();
    }
  }

  function markSeen(path) {
    const file = files.find((f) => f.path === path);
    if (file) seenRef.current.set(path, signature(file));
    setNewPaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  }

  function markAllSeen() {
    for (const file of files) seenRef.current.set(file.path, signature(file));
    setNewPaths(new Set());
  }

  function rangeLabelFor(s) {
    if (s.commit) return `${s.commit.short} · ${s.commit.subject}`;
    return `${b?.isBase ? b.upstream : item?.base} → ${item?.checkout ? "now" : item?.branch}`;
  }

  function openDiff(path, range, label, keep = false) {
    onOpenDiff({ root: dir, path, from: range.from, to: range.to, rangeLabel: label }, { keep });
  }

  function openWorkingDiff(file, keep = false) {
    markSeen(file.path);
    openDiff(file.path, { from: "HEAD", to: null }, "uncommitted", keep);
  }

  function toggleStage(file) {
    const paths = [file.path];
    // A partly staged file's checkbox is already on, and the useful thing it
    // can do next is take the rest — so it stages, rather than unstaging what
    // is already there.
    if (file.staged && !file.partiallyStaged) run("unstage", () => window.clanceApp.gitUnstage(focus.dir, paths));
    else run("stage", () => window.clanceApp.gitStage(focus.dir, paths));
  }

  async function commit(thenPush) {
    const result = await run("commit", () => window.clanceApp.gitCommit(focus.dir, message), () => {
      setMessage("");
      setNote("Committed");
    });
    if (result?.ok && thenPush) await run("push", () => window.clanceApp.gitPush(focus.dir), () => setNote("Committed and pushed"));
  }

  function pick(next) {
    setMenu(null);
    if (next.kind === "checkout") setFocus({ kind: "checkout", root: next.root, dir: next.checkout });
    else setFocus({ kind: "branch", root: next.root, branch: next.branch });
  }

  async function browseForRepo() {
    setMenu(null);
    const picked = await window.clanceApp.pickDirectory();
    if (!picked) return;
    const root = await window.clanceApp.gitSetLastRepo(picked);
    if (!root) return setError("That folder isn't inside a git repository");
    setFocus({ kind: "checkout", root, dir: root });
  }

  // ---- what can be done here, and the questions before the risky ones ----

  const base = item?.base;
  const sessionsOn = (checkout) => sessions.filter((s) => s.checkouts.includes(checkout));
  const home = items.find((other) => other.root === repoRoot && other.kind === "checkout" && other.main) ?? null;
  const baseCheckout = items.find((other) => other.root === repoRoot && other.kind === "checkout" && other.branch === base) ?? null;
  const merged = Boolean(b && !b.isBase && b.ahead === 0);
  // Nothing ahead and nothing behind: a branch with no commits of its own
  // yet, which is "merged" only in the sense that it has nothing to merge.
  const fresh = merged && b.behind === 0;

  function askCleanUp() {
    const clear = merged && !item.uncommitted?.files && here.length === 0;
    setConfirm({
      title: `Clean up ${item.branch}?`,
      checks: [
        [merged, fresh ? `Nothing on it that isn't on ${base}` : `Merged into ${base}`],
        [!item.uncommitted?.files, "No uncommitted changes"],
        [!b.unpushed || b.upstreamGone, "Nothing unpushed"],
        [here.length === 0, "No session working there"],
      ],
      body: `Removes ${tildePath(item.checkout)} and deletes the branch.`,
      action: "Clean up",
      danger: true,
      blocked: !clear,
      onConfirm: async () => {
        setConfirm(null);
        const removed = await run("clean", () => window.clanceApp.workRemoveWorktree(repoRoot, item.checkout));
        if (removed?.ok === false) return;
        await run("clean", () => window.clanceApp.workDeleteBranch(repoRoot, item.branch), () => {
          setNote(`Cleaned up ${item.branch}`);
          if (home) setFocus({ kind: "checkout", root: repoRoot, dir: home.checkout });
        });
      },
    });
  }

  function askMerge() {
    const busyThere = baseCheckout ? sessionsOn(baseCheckout.checkout).some((s) => s.state === "working") : false;
    setConfirm({
      title: `Merge ${item.branch} into ${base}?`,
      checks: [
        [Boolean(baseCheckout), baseCheckout ? `${base} is checked out in ${baseCheckout.main ? "the repository's folder" : tildePath(baseCheckout.checkout)}` : `${base} isn't checked out anywhere`],
        [!baseCheckout?.uncommitted?.files, `${base} has no uncommitted changes`],
        [!busyThere, busyThere ? `A session is working on ${base}` : `No session working on ${base}`],
      ],
      body: "A merge commit there. If it conflicts it's undone, and resolving it is a job for a session.",
      action: "Merge",
      blocked: !baseCheckout || Boolean(baseCheckout?.uncommitted?.files),
      onConfirm: () => {
        setConfirm(null);
        run("merge", () => window.clanceApp.workMerge(repoRoot, item.branch), () => setNote(`Merged into ${base}`));
      },
    });
  }

  function askCheckout() {
    const there = home ? sessionsOn(home.checkout) : [];
    setConfirm({
      title: `Check ${item.branch} out in the repository's folder?`,
      checks: [
        [!home?.uncommitted?.files, home?.uncommitted?.files ? `It has ${plural(home.uncommitted.files, "uncommitted file")}` : "It has no uncommitted changes"],
        [there.length === 0, there.length ? `${there.map((s) => s.title).join(", ")} ${there.length === 1 ? "works" : "work"} there and would be switched too` : "No session working there"],
      ],
      body: `It moves off ${home?.branch ?? "its branch"}. Open as worktree moves nothing.`,
      action: "Check out",
      blocked: !home || Boolean(home?.uncommitted?.files),
      onConfirm: () => {
        setConfirm(null);
        run("switch", () => window.clanceApp.workSwitch(home.checkout, item.branch), () => setFocus({ kind: "checkout", root: repoRoot, dir: home.checkout }));
      },
    });
  }

  function askDelete() {
    setConfirm({
      title: `Delete ${item.branch}?`,
      checks: [[merged, `Everything on it is on ${base}`]],
      body: "git refuses if anything on it isn't merged, so nothing is lost.",
      action: "Delete",
      danger: true,
      onConfirm: () => {
        setConfirm(null);
        run("delete", () => window.clanceApp.workDeleteBranch(repoRoot, item.branch), () => {
          setNote(`Deleted ${item.branch}`);
          if (home) setFocus({ kind: "checkout", root: repoRoot, dir: home.checkout });
        });
      },
    });
  }

  function askRevert(commitToRevert) {
    setConfirm({
      title: `Revert ${commitToRevert.short}?`,
      body: `A new commit that undoes “${commitToRevert.subject}”. Nothing is rewritten. If it conflicts, it's undone.`,
      action: "Revert",
      onConfirm: () => {
        setConfirm(null);
        run("revert", () => window.clanceApp.workRevert(focus.dir, commitToRevert.sha), () => setNote(`Reverted ${commitToRevert.short}`));
      },
    });
  }

  function openAsWorktree() {
    run("worktree", () => window.clanceApp.workAddWorktree(repoRoot, item.branch), (result) => {
      if (result?.path) setFocus({ kind: "checkout", root: repoRoot, dir: result.path });
    });
  }

  // The quiet line of actions under the header: only what applies here.
  const actions = [];
  if (focus?.kind === "branch" && item) {
    actions.push(["Open as worktree", openAsWorktree]);
    actions.push(["Check out…", askCheckout]);
    if (b?.ahead > 0) actions.push([`Merge…`, askMerge]);
    if (merged) actions.push(["Delete…", askDelete]);
  } else if (focus?.kind === "checkout" && item) {
    if (!item.main && merged && !item.uncommitted?.files && !here.length) actions.push(["Clean up…", askCleanUp]);
    if (b && !b.isBase && b.ahead > 0 && !item.uncommitted?.files) actions.push([`Merge…`, askMerge]);
    actions.push(["Terminal", () => onOpenTerminal(focus.dir)]);
    if (!here.length) actions.push(["New session", () => onNewSession(focus.dir)]);
  }
  const actionsNote =
    b && !b.isBase && base && (focus?.kind === "branch" || focus?.kind === "checkout")
      ? fresh
        ? `no commits of its own yet`
        : merged
          ? `merged into ${base}`
          : `↑${b.ahead} ↓${b.behind} vs ${base}`
      : null;

  function openFileMenu(event, file) {
    event.preventDefault();
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 160), file });
  }

  function openCommitMenu(event, commitForMenu) {
    event.preventDefault();
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 120), commit: commitForMenu });
  }

  // ---- render ----

  if (!focus) {
    return html`
      <div class="changes-pane">
        <div class="changes-blank">
          <p>Pick something in Work, or a repository here.</p>
          <button class="btn-secondary btn-small" onClick=${browseForRepo}>Choose folder…</button>
        </div>
      </div>
    `;
  }

  if (focus.kind === "session") {
    return html`<${SessionChanges} focus=${focus} detail=${detail} onOpenDiff=${onOpenDiff} onOpenFile=${onOpenFile} onOpenSession=${onOpenSession} />`;
  }

  const detached = focus.kind === "checkout" && Boolean(status && !status.branch && status.head);
  const branchLabel = focus.kind === "branch" ? focus.branch : status?.branch ?? (detached ? `detached ${status.head}` : item?.branch ?? "…");
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const working = here.some((s) => s.state === "working");
  const gone = snapshot && focus.kind === "checkout" && !item && status === null;
  const showUncommitted = focus.kind === "checkout" && scope?.id === "uncommitted";
  const listed = showUncommitted ? files : rangeFiles ?? [];
  const listedTotals = showUncommitted
    ? totals
    : listed.reduce((sum, f) => ({ insertions: sum.insertions + f.insertions, deletions: sum.deletions + f.deletions }), { insertions: 0, deletions: 0 });
  const unpublished = Boolean(status?.branch && !status.upstream && b && !b.isBase && b.ahead > 0);

  return html`
    <div class="changes-pane">
      <header class="changes-bar">
        <div class="changes-repo" ref=${repoRef}>
          <button class="changes-repo-button" title="Switch repository" onClick=${() => setMenu((open) => (open === "repo" ? null : "repo"))}>
            ${Icon.gitBranch(13)}
            <span class="changes-repo-name">${repo?.name ?? baseName(repoRoot)}</span>
          </button>
          <button
            class="changes-branch ${detached ? "changes-branch-detached" : ""}"
            title=${focus.kind === "branch" ? "Not checked out anywhere — pick another checkout or branch" : `${tildePath(focus.dir)} — pick another checkout or branch`}
            onClick=${() => setMenu((open) => (open === "branch" ? null : "branch"))}
          >
            ${branchLabel}
          </button>
          ${focus.kind === "checkout" && item && !item.main && html`<span class="changes-where">worktree</span>`}
          ${focus.kind === "branch" && html`<span class="changes-where">not checked out</span>`}
          ${working && html`<span class="status-dot status-dot-live" title="A session is working here"></span>`}
          ${menu === "repo" &&
          html`
            <div class="menu changes-switcher">
              <div class="menu-label">repository</div>
              ${(snapshot?.repos ?? []).map(
                (candidate) => html`
                  <button
                    class="menu-item ${candidate.root === repoRoot ? "menu-item-active" : ""}"
                    onClick=${() => {
                      setMenu(null);
                      if (candidate.root !== repoRoot) setFocus({ kind: "checkout", root: candidate.root, dir: candidate.root });
                    }}
                  >
                    <span class="menu-item-title">${candidate.name}</span>
                    <span class="menu-item-detail">${tildePath(candidate.root)}</span>
                  </button>
                `
              )}
              <button class="menu-item" onClick=${browseForRepo}>Choose folder…</button>
            </div>
          `}
          ${menu === "branch" && html`<${BranchMenu} repo=${repo} items=${items} sessions=${sessions} focus=${focus} onPick=${pick} />`}
        </div>
        ${focus.kind === "checkout" &&
        html`
          <div class="changes-sync">
            ${behind > 0 &&
            html`<button class="btn-quiet btn-small" title="Pull" disabled=${busy !== null} onClick=${() => run("pull", () => window.clanceApp.gitPull(focus.dir))}>↓${behind}</button>`}
            ${(ahead > 0 || unpublished) &&
            html`<button class="btn-quiet btn-small" title=${unpublished ? "Push, and set its upstream" : "Push"} disabled=${busy !== null} onClick=${() => run("push", () => window.clanceApp.gitPush(focus.dir), () => setNote("Pushed"))}>${unpublished ? "Publish" : `↑${ahead}`}</button>`}
            <button class="btn-quiet btn-small" disabled=${busy !== null} title="Fetch" onClick=${() => run("fetch", () => window.clanceApp.gitFetch(focus.dir))}>
              ${busy === "fetch" ? "…" : "Fetch"}
            </button>
          </div>
        `}
      </header>

      ${here.length > 0 &&
      html`<${SessionLines}
        sessions=${here}
        onOpen=${(s) => onOpenSession({ id: s.sessionId, title: s.title })}
        onReply=${(s, text) => onReply({ id: s.sessionId, title: s.title, agentId: s.agentId }, text)}
      />`}

      ${(actions.length > 0 || actionsNote) &&
      html`<div class="changes-actions">
        ${actionsNote && html`<span class="changes-actions-note">${actionsNote}</span>`}
        ${actions.map(([label, fn]) => html`<button class="btn-quiet btn-small" disabled=${busy !== null} onClick=${fn}>${label}</button>`)}
      </div>`}

      ${confirm && html`<${Confirm} confirm=${confirm} onCancel=${() => setConfirm(null)} />`}
      ${gone && html`<div class="changes-note changes-note-warn">This folder isn't a checkout any more.</div>`}
      ${status?.operation && html`<div class="changes-note changes-note-warn">${status.operation} in progress</div>`}
      ${(error || note) &&
      html`<div class="changes-note ${error ? "changes-note-warn" : ""}" title="Dismiss" onClick=${() => { setError(null); setNote(null); }}>${error ?? note}</div>`}

      ${(pickedCommit || scopeOptions.length > 1) &&
      html`<div class="changes-scope-row">
        ${pickedCommit
          ? html`<button class="btn-quiet btn-small changes-commit-back" title="Back to the changes" onClick=${() => setScope(scopeOptions[0]?.id ?? null)}>← ${pickedCommit.short}</button>
              <span class="changes-commit-subject" title=${pickedCommit.subject}>${pickedCommit.subject}</span>`
          : html`<span class="segmented changes-scope" role="tablist">
              ${scopeOptions.map(
                (option) => html`<button class="segmented-item ${scope?.id === option.id ? "segmented-item-active" : ""}" role="tab" aria-selected=${scope?.id === option.id} onClick=${() => setScope(option.id)}>${option.label}</button>`
              )}
            </span>`}
      </div>`}

      <div class="changes-summary">
        <span class="changes-count">
          ${(showUncommitted ? !status : rangeFiles === null)
            ? "Reading…"
            : listed.length === 0
              ? "No changes"
              : plural(listed.length, "file")}
        </span>
        <span class="changes-totals">
          ${listedTotals.insertions > 0 && html`<span class="change-ins">+${listedTotals.insertions}</span>`}
          ${listedTotals.deletions > 0 && html`<span class="change-del">−${listedTotals.deletions}</span>`}
        </span>
        ${showUncommitted &&
        files.length > 0 &&
        onOpenInLode &&
        html`<button class="btn-quiet btn-small changes-lode" title="Open every changed function as cards in a lode tab, with the changes marked" onClick=${() => onOpenInLode(focus.dir)}>Open in lode</button>`}
        ${showUncommitted && newPaths.size > 0 && html`<button class="changes-new-count" title="Clear the marks" onClick=${markAllSeen}>${newPaths.size} new</button>`}
        ${showUncommitted &&
        files.length > 0 &&
        html`<button
          class="btn-quiet btn-small"
          title=${staged.length === files.length ? "Unstage everything" : "Stage everything"}
          onClick=${() =>
            staged.length === files.length
              ? run("unstage", () => window.clanceApp.gitUnstage(focus.dir, staged.map((f) => f.path)))
              : run("stage", () => window.clanceApp.gitStage(focus.dir, files.map((f) => f.path)))}
        >
          ${staged.length === files.length ? "None" : "All"}
        </button>`}
      </div>

      <div class="changes-list" ref=${listRef}>
        ${showUncommitted
          ? status && files.length === 0
            ? html`<p class="changes-clean">Working tree clean.</p>`
            : files.map(
                (file) => html`
                  <${FileRow}
                    key=${file.path}
                    file=${file}
                    isNew=${newPaths.has(file.path)}
                    onOpen=${() => openWorkingDiff(file)}
                    onKeep=${() => openWorkingDiff(file, true)}
                    onToggleStage=${toggleStage}
                    onContextMenu=${(e) => openFileMenu(e, file)}
                    confirming=${discarding === file.path}
                    onConfirmDiscard=${() => {
                      setDiscarding(null);
                      run("discard", () => window.clanceApp.gitDiscard(focus.dir, [file.path]));
                    }}
                    onCancelDiscard=${() => setDiscarding(null)}
                  />
                `
              )
          : rangeFiles !== null && listed.length === 0
            ? html`<p class="changes-clean">${merged ? `Everything here is on ${base}.` : "Nothing changed."}</p>`
            : listed.map(
                (file) => html`<${RangeRow}
                  key=${file.path}
                  file=${file}
                  onOpen=${() => openDiff(file.path, scope.range, rangeLabelFor(scope))}
                  onKeep=${() => openDiff(file.path, scope.range, rangeLabelFor(scope), true)}
                />`
              )}
      </div>

      ${showUncommitted &&
      files.length > 0 &&
      html`
        <footer class="changes-commit">
          <textarea
            class="changes-message"
            rows="2"
            placeholder=${staged.length > 0 ? `Message for ${staged.length} staged` : "Stage a file to commit"}
            value=${message}
            onInput=${(event) => setMessage(event.target.value)}
            onKeyDown=${(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && staged.length > 0 && message.trim()) {
                event.preventDefault();
                commit(false);
              }
            }}
          ></textarea>
          <div class="changes-commit-actions">
            <button class="btn-primary btn-small" disabled=${staged.length === 0 || !message.trim() || busy !== null} onClick=${() => commit(false)}>
              ${busy === "commit" ? "Committing…" : "Commit"}
            </button>
            <button class="btn-quiet btn-small" disabled=${staged.length === 0 || !message.trim() || busy !== null} onClick=${() => commit(true)}>
              ${busy === "push" ? "Pushing…" : "& push"}
            </button>
          </div>
        </footer>
      `}

      <${History}
        label=${commitRange?.from ? (b?.isBase ? `not on ${b.upstream} yet` : `on ${branchLabel}, not on ${base}`) : "recent"}
        commits=${commits}
        selected=${pickedCommit?.sha}
        onSelect=${(picked) => setScope(pickedCommit?.sha === picked.sha ? scopeOptions[0]?.id ?? null : picked.sha)}
        onContextMenu=${focus.kind === "checkout" ? openCommitMenu : null}
        remote=${remote}
        onOpenRemote=${() => run("remote", () => window.clanceApp.gitOpenRemote(repoRoot))}
      />

      ${contextMenu &&
      html`
        <div class="menu context-menu" role="menu" style=${{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}>
          ${contextMenu.file
            ? html`
                <button class="menu-item" onClick=${() => { setContextMenu(null); openWorkingDiff(contextMenu.file, true); }}><span class="menu-item-title">Open diff in its own tab</span></button>
                ${contextMenu.file.status !== "deleted" &&
                html`<button class="menu-item" onClick=${() => { setContextMenu(null); markSeen(contextMenu.file.path); onOpenFile(focus.dir, contextMenu.file.path); }}><span class="menu-item-title">Open file</span></button>`}
                <div class="menu-separator"></div>
                <button class="menu-item menu-item-danger" onClick=${() => { setDiscarding(contextMenu.file.path); setContextMenu(null); }}><span class="menu-item-title">Discard changes…</span></button>
              `
            : html`
                <button class="menu-item" onClick=${() => { setContextMenu(null); navigator.clipboard.writeText(contextMenu.commit.sha); setNote("Commit id copied"); }}><span class="menu-item-title">Copy commit id</span></button>
                <button class="menu-item" onClick=${() => { setContextMenu(null); askRevert(contextMenu.commit); }}><span class="menu-item-title">Revert…</span></button>
              `}
        </div>
      `}
    </div>
  `;
}

/** What a past session did: the files it edited, per checkout, and the commits it made. */
function SessionChanges({ focus, detail, onOpenDiff, onOpenFile, onOpenSession }) {
  const [picked, setPicked] = useState(null);
  const [rangeFiles, setRangeFiles] = useState(null);
  const repos = detail?.repos ?? [];
  const allCommits = repos.flatMap((repo) => repo.commits.map((commit) => ({ ...commit, root: repo.root, repo: repo.name })));
  const commit = allCommits.find((candidate) => candidate.sha === picked) ?? null;

  useEffect(() => setPicked(null), [focus.sessionId]);
  useEffect(() => {
    if (!commit) return;
    let cancelled = false;
    window.clanceApp.workFiles(commit.root, { from: commit.parent, to: commit.sha }).then((next) => !cancelled && setRangeFiles(next ?? []));
    return () => {
      cancelled = true;
    };
  }, [picked]);

  const editedCount = repos.reduce((n, repo) => n + repo.files.length, 0);
  const commitDiff = (file, keep) =>
    onOpenDiff({ root: commit.root, path: file.path, from: commit.parent, to: commit.sha, rangeLabel: `${commit.short} · ${commit.subject}` }, { keep });
  const editDiff = (repo, file, keep) =>
    file.uncommitted ? onOpenDiff({ root: repo.root, path: file.path, from: "HEAD", to: null, rangeLabel: "uncommitted" }, { keep }) : onOpenFile(repo.root, file.path);

  return html`
    <div class="changes-pane">
      <header class="changes-bar">
        <div class="changes-repo">
          <span class="changes-repo-button changes-repo-static">${Icon.chat(13)}<span class="changes-repo-name">${focus.title}</span></span>
        </div>
        <div class="changes-sync">
          <button class="btn-quiet btn-small" onClick=${() => onOpenSession({ id: focus.sessionId, title: focus.title })}>Resume</button>
        </div>
      </header>
      <div class="changes-summary">
        ${commit
          ? html`<button class="btn-quiet btn-small changes-commit-back" title="Back to its edits" onClick=${() => setPicked(null)}>← ${commit.short}</button>`
          : html`<span class="changes-count">${detail === null ? "Reading its transcript…" : editedCount === 0 ? "Edited no files" : `Edited ${plural(editedCount, "file")}`}</span>`}
        ${!commit && detail?.elsewhere > 0 && html`<span class="changes-totals">${detail.elsewhere} outside a repo</span>`}
      </div>
      <div class="changes-list">
        ${commit
          ? (rangeFiles ?? []).map((file) => html`<${RangeRow} key=${file.path} file=${file} onOpen=${() => commitDiff(file, false)} onKeep=${() => commitDiff(file, true)} />`)
          : repos.map(
              (repo) => html`
                ${repos.length > 1 && repo.files.length > 0 && html`<div class="changes-group">${repo.name}</div>`}
                ${repo.files.map(
                  (file) => html`<${RangeRow}
                    key=${repo.root + file.path}
                    file=${{ path: file.path, status: file.uncommitted ? "modified" : "unchanged", insertions: 0, deletions: 0 }}
                    note=${file.uncommitted ? "uncommitted" : ""}
                    onOpen=${() => editDiff(repo, file, false)}
                    onKeep=${() => editDiff(repo, file, true)}
                  />`
                )}
              `
            )}
      </div>
      <${History}
        label="commits it made"
        commits=${detail === null ? null : allCommits}
        selected=${picked}
        onSelect=${(c) => setPicked(picked === c.sha ? null : c.sha)}
        remote=${null}
      />
    </div>
  `;
}
