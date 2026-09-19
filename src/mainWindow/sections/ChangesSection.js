import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../../shared/vendor/preact-htm-standalone.module.js";
import { Icon } from "../../shared/icons.js";

// The Changes pane: a monitor, not a reader. It lives in a narrow pane on the
// right and says what is moving in a repository right now — which, while a
// session is writing code, is what Claude is doing. Reading a file is a file
// tab's job (FileSection.js); this pane opens them.
//
// It reads git through the main process (src/main/git.ts); nothing here shells
// out or touches the filesystem.

/** How often the pane re-asks which agents are running, to spot one working here. */
const AGENT_POLL_MS = 5000;

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

/** Lines an inline peek draws before it defers to the file tab. */
const PEEK_LINES = 120;

/** A compact diff under a row — a peek, for when opening a tab is more than the question deserves. */
function InlinePeek({ repoRoot, path }) {
  const [diff, setDiff] = useState(null);

  useEffect(() => {
    let cancelled = false;
    window.clanceApp.gitFileDiff(repoRoot, path).then((next) => {
      if (!cancelled) setDiff(next);
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, path]);

  if (!diff) return html`<div class="peek-diff peek-diff-empty">Reading…</div>`;
  if (diff.omitted) return html`<div class="peek-diff peek-diff-empty">${diff.omitted}</div>`;

  // A peek is a glance, not a read: a 900-line diff in a narrow pane is
  // neither, and putting that many rows in the DOM for something behind a
  // chevron is waste. The file tab is one click away.
  const shown = diff.lines.slice(0, PEEK_LINES);
  const more = diff.truncated || diff.lines.length > PEEK_LINES;

  return html`
    <div class="peek-diff">
      ${shown.map(
        (line, index) => html`
          <div class="peek-diff-line peek-diff-${line.kind}" key=${index}>
            <span class="peek-diff-mark">${line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span
            ><span class="peek-diff-text">${line.kind === "hunk" ? "⋯" : line.text}</span>
          </div>
        `
      )}
      ${more && html`<div class="peek-diff-empty">…the rest is in the file tab</div>`}
    </div>
  `;
}

// Short and mono, the way the Sessions table and Dictation print times.
function relativeTime(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
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
 * The last few commits. Status rather than a history browser: it answers "did
 * that land" and "what just happened here", and it's what keeps the pane worth
 * looking at in its most common state — a clean tree with nothing staged.
 */
function History({ commits, remote, onOpenRemote }) {
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
  // too — a "recent" heading over nothing is worse than no heading. The list
  // element itself stays mounted either way, because it's what gets measured;
  // unmounting it would leave nothing to re-measure when the pane grows again.
  const roomForAny = capacity >= 1;

  return html`
    <section class="changes-history">
      ${(commits === null || commits.length === 0 || roomForAny) &&
      html`<div class="changes-history-head">recent</div>`}
      ${commits === null
        ? html`<p class="changes-history-empty">Reading…</p>`
        : commits.length === 0
          ? html`<p class="changes-history-empty">No commits yet. The first one will show up here.</p>`
          : html`
              <div class="changes-history-list" ref=${listRef}>
                ${shown.map(
                  (commit) => html`
                    <div class="commit-row" key=${commit.short} title=${`${commit.subject}\n${commit.author}`}>
                      <span class="commit-subject">${commit.subject}</span>
                      <span class="commit-when">${relativeTime(commit.date)}</span>
                      <span class="commit-sha">${commit.short}</span>
                    </div>
                  `
                )}
              </div>
            `}
      ${remote &&
      html`<button class="btn-quiet btn-small changes-remote" onClick=${onOpenRemote}>
        Open on ${remote.host} ↗
      </button>`}
    </section>
  `;
}

/**
 * Branches, read-only. It says where they are — ahead and behind their
 * upstream, and when each was last committed to — and leaves checking one out
 * to a terminal or the session next door: a checkout with a dirty tree either
 * refuses or carries the changes across, which is a decision rather than a
 * button. What a row *can* usefully do is hand over the name.
 */
function BranchMenu({ branches, copied, onCopy }) {
  return html`
    <div class="menu changes-branches">
      <div class="menu-label">branches</div>
      ${branches === null
        ? html`<div class="branch-note">Reading…</div>`
        : branches.length === 0
          ? html`<div class="branch-note">No branches yet.</div>`
          : html`
              <div class="branch-list">
                ${branches.map(
                  (branch) => html`
                    <button
                      class="menu-item branch-row ${branch.current ? "menu-item-active" : ""}"
                      key=${branch.name}
                      title=${`${branch.subject}\n${branch.upstream ? `tracks ${branch.upstream}` : "no upstream"}`}
                      onClick=${() => onCopy(branch.name)}
                    >
                      <span class="branch-dot">${branch.current ? "●" : ""}</span>
                      <span class="branch-name">${branch.name}</span>
                      <span class="branch-track">
                        ${branch.ahead > 0 && html`<span class="change-ins">↑${branch.ahead}</span>`}
                        ${branch.behind > 0 && html`<span class="change-del">↓${branch.behind}</span>`}
                        ${!branch.upstream && html`<span class="branch-local">local</span>`}
                      </span>
                      <span class="branch-when">
                        ${copied === branch.name ? "copied" : relativeTime(branch.date)}
                      </span>
                    </button>
                  `
                )}
              </div>
            `}
      <div class="branch-note">Click a name to copy it. Switch branches in a terminal.</div>
    </div>
  `;
}

function FileRow({ file, isNew, expanded, repoRoot, onOpen, onToggleStage, onToggleExpand, onDiscard }) {
  const [confirming, setConfirming] = useState(false);
  const { dir, name } = splitPath(file.path);

  return html`
    <div class="change-item ${expanded ? "change-item-open" : ""}">
      <div class="change-row ${confirming ? "change-row-confirming" : ""}" onClick=${() => onOpen(file.path)}>
        <button
          class="change-check ${file.staged ? "change-check-on" : ""}"
          title=${file.staged ? "Staged — click to unstage" : "Not staged — click to stage"}
          aria-pressed=${file.staged}
          onClick=${(event) => {
            event.stopPropagation();
            onToggleStage(file);
          }}
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
        <button
          class="change-expand ${expanded ? "change-expand-on" : ""}"
          title=${expanded ? "Hide the diff" : "Peek at the diff"}
          onClick=${(event) => {
            event.stopPropagation();
            onToggleExpand(file.path);
          }}
        >
          ${Icon.chevronRight(12)}
        </button>
      </div>
      ${confirming &&
      html`
        <div class="change-confirm">
          <span class="change-confirm-text">Throw away the changes to ${name}?</span>
          <button class="btn-danger btn-small" onClick=${() => { setConfirming(false); onDiscard(file.path); }}>
            Discard
          </button>
          <button class="btn-quiet btn-small" onClick=${() => setConfirming(false)}>Cancel</button>
        </div>
      `}
      ${expanded && html`<${InlinePeek} repoRoot=${repoRoot} path=${file.path} />`}
      ${expanded &&
      !confirming &&
      html`
        <div class="change-item-actions">
          <button class="btn-quiet btn-small" onClick=${() => onOpen(file.path)}>Open file</button>
          <button class="btn-quiet btn-small change-discard" onClick=${() => setConfirming(true)}>Discard</button>
        </div>
      `}
    </div>
  `;
}

export function ChangesSection({ onOpenFile }) {
  const [repos, setRepos] = useState([]);
  const [root, setRoot] = useState(null);
  const [status, setStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [newPaths, setNewPaths] = useState(() => new Set());
  // Which header menu is open, if any: "repo" or "branch". One at a time, so
  // opening one closes the other without a second piece of state to keep in
  // step with the first.
  const [menu, setMenu] = useState(null);
  const [branches, setBranches] = useState(null);
  const [copied, setCopied] = useState(null);
  const [agentWorking, setAgentWorking] = useState(false);
  const [commits, setCommits] = useState(null);
  const [remote, setRemote] = useState(null);

  // path → signature at the moment the user last had eyes on that file. A ref
  // rather than state: it's a baseline for comparison, and writing it should
  // never itself cause a render.
  const seenRef = useRef(new Map());
  const rootRef = useRef(null);
  const repoRef = useRef(null);

  async function refresh(targetRoot = rootRef.current) {
    if (!targetRoot) return;
    const next = await window.clanceApp.gitStatus(targetRoot);
    // A switch that happened while this was in flight wins — otherwise the
    // old repo's listing lands on top of the new one's.
    if (rootRef.current !== targetRoot) return;
    setStatus(next);
    setLoaded(true);
    // The same watcher tick that moved the working tree may have been a
    // commit, so the history is re-read with it rather than on its own timer.
    const [log, refs] = await Promise.all([
      window.clanceApp.gitLog(targetRoot, HISTORY_FETCH),
      window.clanceApp.gitBranches(targetRoot),
    ]);
    if (rootRef.current !== targetRoot) return;
    setCommits(log);
    setBranches(refs);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, last] = await Promise.all([
        window.clanceApp.gitListRepos(),
        window.clanceApp.gitGetLastRepo(),
      ]);
      if (cancelled) return;
      setRepos(list);
      setRoot(last ?? list[0]?.root ?? null);
      if (!last && !list[0]) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // One watch at a time, following the chosen repo. The main process debounces
  // the filesystem events; this just re-reads status when one gets through.
  useEffect(() => {
    rootRef.current = root;
    seenRef.current = new Map();
    setNewPaths(new Set());
    setExpanded(null);
    setStatus(null);
    setLoaded(false);
    setError(null);
    if (!root) return;

    setCommits(null);
    setBranches(null);
    setRemote(null);
    setMenu(null);
    window.clanceApp.gitRemote(root).then((next) => {
      if (rootRef.current === root) setRemote(next);
    });
    window.clanceApp.gitSetLastRepo(root);
    window.clanceApp.gitWatch(root);
    refresh(root);
    const off = window.clanceApp.onGitChanged((changed) => {
      if (changed === rootRef.current) refresh(changed);
    });
    return () => {
      off();
      window.clanceApp.gitUnwatch();
    };
  }, [root]);

  // Whether an agent is working in this repo right now. The listing underneath
  // is a moving target while one is, and saying so is better than letting a
  // half-written file read as a finished change.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    async function poll() {
      const agents = await window.clanceApp.listAgents({}).catch(() => []);
      if (cancelled) return;
      setAgentWorking(
        agents.some(
          (agent) =>
            typeof agent.cwd === "string" &&
            (agent.cwd === root || agent.cwd.startsWith(`${root}/`)) &&
            agent.state === "working"
        )
      );
    }
    poll();
    const timer = setInterval(poll, AGENT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [root]);

  // A menu that only closes by pressing the thing that opened it is a trap.
  // Capture phase, so a click on a file row closes it instead of being eaten
  // by the row underneath.
  useEffect(() => {
    if (!menu) return;
    function onDown(event) {
      if (!repoRef.current?.contains(event.target)) setMenu(null);
    }
    function onKey(event) {
      if (event.key === "Escape") setMenu(null);
    }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  // What moved while the user was looking elsewhere. The first listing for a
  // repo is the baseline — otherwise opening the pane would light every row up
  // and the mark would mean nothing.
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

  const files = status?.files ?? [];
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, f) => ({ insertions: sum.insertions + f.insertions, deletions: sum.deletions + f.deletions }),
        { insertions: 0, deletions: 0 }
      ),
    [files]
  );

  // ---- actions ----

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

  function openFile(path) {
    markSeen(path);
    onOpenFile(root, path);
  }

  function toggleExpand(path) {
    markSeen(path);
    setExpanded((current) => (current === path ? null : path));
  }

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
      else if (onDone) onDone();
      return result;
    } finally {
      setBusy(null);
      refresh();
    }
  }

  function toggleStage(file) {
    const paths = [file.path];
    // A partly staged file's checkbox is already on, and the useful thing it
    // can do next is take the rest — so it stages, rather than unstaging what
    // is already there.
    if (file.staged && !file.partiallyStaged) run("unstage", () => window.clanceApp.gitUnstage(root, paths));
    else run("stage", () => window.clanceApp.gitStage(root, paths));
  }

  function discard(path) {
    run("discard", () => window.clanceApp.gitDiscard(root, [path]), () => {
      if (expanded === path) setExpanded(null);
    });
  }

  async function commit(thenPush) {
    const result = await run("commit", () => window.clanceApp.gitCommit(root, message), () => {
      setMessage("");
      setExpanded(null);
      setNote("Committed");
    });
    if (result?.ok && thenPush) {
      await run("push", () => window.clanceApp.gitPush(root), () => setNote("Committed and pushed"));
    }
  }

  // The picker is read-only, so the useful thing a row can do is hand you the
  // name to paste into a checkout.
  function copyBranchName(name) {
    navigator.clipboard.writeText(name).then(() => {
      setCopied(name);
      setTimeout(() => setCopied(null), 1200);
    });
  }

  function markAllSeen() {
    for (const file of files) seenRef.current.set(file.path, signature(file));
    setNewPaths(new Set());
  }

  async function browseForRepo() {
    setMenu(null);
    const dir = await window.clanceApp.pickDirectory();
    if (!dir) return;
    const resolved = await window.clanceApp.gitSetLastRepo(dir);
    if (!resolved) {
      setError("That folder isn't inside a git repository");
      return;
    }
    setRepos((current) =>
      current.some((repo) => repo.root === resolved)
        ? current
        : [...current, { root: resolved, name: resolved.split("/").filter(Boolean).pop() }]
    );
    setRoot(resolved);
  }

  // ---- render ----

  if (!root && loaded) {
    return html`
      <div class="changes-pane">
        <div class="changes-blank">
          <p>No repository yet.</p>
          <button class="btn-secondary btn-small" onClick=${browseForRepo}>Choose folder…</button>
        </div>
      </div>
    `;
  }

  const repoName = repos.find((repo) => repo.root === root)?.name ?? root?.split("/").filter(Boolean).pop() ?? "";
  // A detached HEAD used to render as a bare short sha, which reads exactly
  // like a branch named that — and quietly hid the fact that a commit here
  // wouldn't be on any branch.
  const detached = Boolean(status && !status.branch && status.head);
  const branchLabel = status?.branch ?? (detached ? `detached ${status.head}` : "…");
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  return html`
    <div class="changes-pane">
      <header class="changes-bar">
        <div class="changes-repo" ref=${repoRef}>
          <button
            class="changes-repo-button"
            title="Switch repository"
            onClick=${() => setMenu((open) => (open === "repo" ? null : "repo"))}
          >
            ${Icon.gitBranch(13)}
            <span class="changes-repo-name">${repoName}</span>
          </button>
          <button
            class="changes-branch ${detached ? "changes-branch-detached" : ""}"
            title=${detached ? `Detached at ${status.head} — not on a branch` : "Branches"}
            onClick=${() => setMenu((open) => (open === "branch" ? null : "branch"))}
          >
            ${branchLabel}
          </button>
          ${agentWorking && html`<span class="status-dot status-dot-live" title="claude is working here"></span>`}
          ${menu === "repo" &&
          html`
            <div class="menu changes-switcher">
              <div class="menu-label">repository</div>
              ${repos.map(
                (repo) => html`
                  <button
                    class="menu-item ${repo.root === root ? "menu-item-active" : ""}"
                    onClick=${() => {
                      setMenu(null);
                      if (repo.root !== root) setRoot(repo.root);
                    }}
                  >
                    <span class="menu-item-title">${repo.name}</span>
                    <span class="menu-item-detail">${repo.root.replace(/^\/Users\/[^/]+/, "~")}</span>
                  </button>
                `
              )}
              <button class="menu-item" onClick=${browseForRepo}>Choose folder…</button>
            </div>
          `}
          ${menu === "branch" &&
          html`<${BranchMenu} branches=${branches} copied=${copied} onCopy=${copyBranchName} />`}
        </div>
        <div class="changes-sync">
          ${behind > 0 &&
          html`<button class="btn-quiet btn-small" title="Pull" disabled=${busy !== null} onClick=${() => run("pull", () => window.clanceApp.gitPull(root))}>↓${behind}</button>`}
          ${ahead > 0 &&
          html`<button class="btn-quiet btn-small" title="Push" disabled=${busy !== null} onClick=${() => run("push", () => window.clanceApp.gitPush(root), () => setNote("Pushed"))}>↑${ahead}</button>`}
          <button class="btn-quiet btn-small" disabled=${busy !== null} title="Fetch" onClick=${() => run("fetch", () => window.clanceApp.gitFetch(root))}>
            ${busy === "fetch" ? "…" : "Fetch"}
          </button>
        </div>
      </header>

      ${status?.operation && html`<div class="changes-note changes-note-warn">${status.operation} in progress</div>`}
      ${(error || note) &&
      html`<div
        class="changes-note ${error ? "changes-note-warn" : ""}"
        title="Dismiss"
        onClick=${() => {
          setError(null);
          setNote(null);
        }}
      >
        ${error ?? note}
      </div>`}

      <div class="changes-summary">
        <span class="changes-count">
          ${!loaded
            ? "Reading…"
            : files.length === 0
              ? "No changes"
              : `${files.length} file${files.length === 1 ? "" : "s"}`}
        </span>
        ${files.length > 0 &&
        html`<span class="changes-totals">
          ${totals.insertions > 0 && html`<span class="change-ins">+${totals.insertions}</span>`}
          ${totals.deletions > 0 && html`<span class="change-del">−${totals.deletions}</span>`}
        </span>`}
        ${newPaths.size > 0 &&
        html`<button class="changes-new-count" title="Clear the marks" onClick=${markAllSeen}>
          ${newPaths.size} new
        </button>`}
        ${files.length > 0 &&
        html`<button
          class="btn-quiet btn-small"
          title=${staged.length === files.length ? "Unstage everything" : "Stage everything"}
          onClick=${() =>
            staged.length === files.length
              ? run("unstage", () => window.clanceApp.gitUnstage(root, staged.map((f) => f.path)))
              : run("stage", () => window.clanceApp.gitStage(root, files.map((f) => f.path)))}
        >
          ${staged.length === files.length ? "None" : "All"}
        </button>`}
      </div>

      <div class="changes-list">
        ${loaded && files.length === 0
          ? html`<p class="changes-clean">Working tree clean.</p>`
          : files.map(
              (file) => html`
                <${FileRow}
                  key=${file.path}
                  file=${file}
                  repoRoot=${root}
                  isNew=${newPaths.has(file.path)}
                  expanded=${expanded === file.path}
                  onOpen=${openFile}
                  onToggleStage=${toggleStage}
                  onToggleExpand=${toggleExpand}
                  onDiscard=${discard}
                />
              `
            )}
      </div>

      ${files.length > 0 &&
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
            <button
              class="btn-primary btn-small"
              disabled=${staged.length === 0 || !message.trim() || busy !== null}
              onClick=${() => commit(false)}
            >
              ${busy === "commit" ? "Committing…" : "Commit"}
            </button>
            <button
              class="btn-quiet btn-small"
              disabled=${staged.length === 0 || !message.trim() || busy !== null}
              onClick=${() => commit(true)}
            >
              ${busy === "push" ? "Pushing…" : "& push"}
            </button>
          </div>
        </footer>
      `}

      <${History}
        commits=${commits}
        remote=${remote}
        onOpenRemote=${() => run("remote", () => window.clanceApp.gitOpenRemote(root))}
      />
    </div>
  `;
}
