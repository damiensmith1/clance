import { getState, listTabs, findPane, activateTab, activatePane } from "../state/layoutStore.js";
import { connectProject, flowOf, symbolAt, touchedRecently } from "./FlowSection.js";
import { readTabState } from "../state/tabState.js";

// The lode tools' view of the lode tabs (src/main/lodeTools.ts asks, through
// Shell.js's canvas handler): list them, read one's cards as context, or
// draw on one with lode's canvas actions (flow.apply). Cards are named by
// the model, so they're matched by key, symbol id or name.


function lodeTabs() {
  const state = getState();
  return listTabs(state.root)
    .filter((entry) => entry.tab.type === "flow")
    .map((entry) => {
      const pane = findPane(state.root, entry.paneId);
      const showing = pane?.activeTabId === entry.tab.id;
      return { ...entry, showing, focused: showing && state.activePaneId === entry.paneId };
    });
}

// A lode tab's canvas, showing it first if it hasn't been drawn yet.
async function canvasOf(canvas) {
  const entry = lodeTabs().find((e) => e.tab.id === canvas);
  if (!entry) throw new Error(`No lode tab ${canvas}.`);
  if (!flowOf(canvas) || !entry.showing) {
    const back = getState().activePaneId;
    activateTab(entry.paneId, canvas);
    if (back && back !== entry.paneId) activatePane(back);
    for (let i = 0; i < 40 && !flowOf(canvas); i++) await new Promise((r) => setTimeout(r, 50));
  }
  const flow = flowOf(canvas);
  if (!flow) throw new Error(`The lode tab ${canvas} couldn't be shown.`);
  return { flow, tab: entry.tab };
}

// A card on the canvas by key, symbol id or name.
function cardKey(flow, ref) {
  const cards = flow.cards();
  const r = String(ref).trim();
  return (
    cards.find((c) => c.key === r || c.node.id === r) ??
    cards.find((c) => c.node.name === r) ??
    cards.find((c) => c.node.name.toLowerCase() === r.toLowerCase() || c.key.endsWith(`#${r}`))
  )?.key;
}

// --- following a Claude session (src/main/lodeFollow.ts) ---

// What a followed session is told with each prompt: explain on the canvas.
const followContext = (tab) =>
  [
    `The user is watching Clance's lode canvas ${tab.id} ("${tab.label}") follow this session: the code you write appears there as cards as you go.`,
    `Explain your work on that canvas rather than in your reply (pass canvas "${tab.id}"): lode_note beside the cards you changed (what changed and why), lode_diagram when the structure helps, and lode_group / lode_arrange to organise what you touched so it reads well (lode_tidy closes up empty space).`,
    "Keep your written reply to a line or two that points at the canvas.",
  ].join(" ");

const followTurns = new Map(); // tab id → this turn's undo group
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKTREE = /\/\.claude\/worktrees\/([^/]+)$/;

// What the session wrote, as cards: the symbol at each edit's line, else
// the file. Code from another folder (a worktree, another repo) comes
// from that folder's lode, onto the same canvas, framed as a group named
// for it. No git: the view moves to the cards, the cursor to the line.
async function followEdit(entry, edits, report) {
  const { flow, tab } = await canvasOf(entry.tab.id);
  // lode re-reads a written file a moment after.
  await wait(600);
  const byFolder = new Map(); // folder (null: the canvas's own) → { ids, lines }
  for (const { file, line, folder } of edits) {
    const own = file.startsWith(`${tab.root}/`) && !WORKTREE.test(folder) ? null : folder;
    const root = own ?? tab.root;
    if (!file.startsWith(`${root}/`)) {
      report.skipped.push(file);
      continue;
    }
    if (own) connectProject(own, tab.id);
    const rel = file.slice(root.length + 1);
    const symbol = line ? await symbolAt(root, rel, line) : null;
    const at = byFolder.get(own) ?? { ids: [], lines: new Map() };
    const id = symbol?.id ?? rel;
    if (!at.ids.includes(id)) at.ids.push(id);
    if (line) at.lines.set(id, line);
    byFolder.set(own, at);
  }
  if (!byFolder.size) return;
  if (!followTurns.has(tab.id)) followTurns.set(tab.id, `follow-${Date.now()}`);
  const group = followTurns.get(tab.id);
  const shown = [];
  for (const [folder, { ids, lines }] of byFolder) {
    const add = { kind: "add", ids, ...(folder && { folder }) };
    await flow.apply([add], { undoGroup: group });
    const label = folder ? flow.folderList().find((f) => f.path === folder)?.label : "";
    if (label === undefined) continue;
    // Not read yet (a file just made, lode still re-reading): again, each
    // second, for a while.
    const keyOf = (id) => (label ? `${label}//${id}` : id);
    const missing = () => ids.filter((id) => !flow.cards().some((c) => c.key === keyOf(id)));
    for (let tries = 0; missing().length && tries < 8; tries++) {
      await wait(1000);
      await flow.apply([{ ...add, ids: missing() }], { undoGroup: group });
    }
    for (const id of missing()) report.missing.push(id);
    const keys = ids.map(keyOf).filter((k) => flow.cards().some((c) => c.key === k));
    report.shown.push(...keys);
    if (folder && keys.length) {
      const name = folder.match(WORKTREE)?.[1];
      await flow.apply([{ kind: "group", id: `folder:${label}`, title: name ? `worktree: ${name}` : folder.split("/").pop(), cards: keys, add: true, layout: "column" }], { undoGroup: group });
    }
    for (const [i, k] of keys.entries()) shown.push({ key: k, line: lines.get(ids[i]) });
  }
  if (!shown.length || touchedRecently(tab.id)) return;
  await flow.apply([{ kind: "focus", cards: shown.map((s) => s.key) }], { undoGroup: group });
  const last = shown.findLast((s) => s.line);
  if (last) flow.moveCursor(last.key, last.line);
}

// A session in this canvas's project (or one of its folders).
export const inProject = (cwd, root) => !!cwd && (cwd === root || cwd.startsWith(`${root}/`));

async function follow({ agent, cwd, event, edits }) {
  const followers = lodeTabs().filter((e) => readTabState(e.tab.id, "follow", null)?.agent === agent && (!cwd || inProject(cwd, e.tab.root)));
  if (!followers.length) return null;
  if (event === "prompt") return { context: followContext(followers[0].tab) };
  // What happened, for main's log (lodeFollow.ts).
  const report = { canvases: followers.map((e) => e.tab.id), shown: [], missing: [], skipped: [] };
  for (const entry of followers) {
    if (event === "edit") await followEdit(entry, edits ?? [], report);
    else if (event === "stop" && flowOf(entry.tab.id)) {
      followTurns.delete(entry.tab.id);
      // Close up what closed cards left empty, then show it all.
      if (!touchedRecently(entry.tab.id)) await flowOf(entry.tab.id).apply([{ kind: "tidy" }, { kind: "fit" }]);
    }
  }
  return report;
}

export async function canvasOp(op, args) {
  if (op === "follow") return follow(args);
  if (op === "list") {
    return lodeTabs().map(({ tab, showing, focused }) => {
      const flow = flowOf(tab.id);
      const folders = flow?.folderList().map((f) => f.path) ?? [];
      return { canvas: tab.id, label: tab.label, folder: tab.root, cards: flow ? flow.cards().length : 0, ...(folders.length && { folders }), ...(flow?.asked && { question: flow.asked.question }), showing, focused };
    });
  }
  const { flow, tab } = await canvasOf(args.canvas);
  // Another folder on this canvas (a tool's `folder`): its lode, opened if
  // need be; its real path, for main to call it.
  if (op === "folder") {
    const real = await window.clanceApp.lodeOpen(args.folder);
    if (!real) throw new Error(`${args.folder} isn't a folder.`);
    if ((await flow.addFolder(real)) === null) throw new Error(`No lode for ${real}.`);
    return real === tab.root ? tab.root : real;
  }
  if (op === "read") {
    const context = flow.cards().length ? await flow.context(args.budget) : null;
    const selected = new Set(flow.selection().map((c) => c.key));
    return {
      markdown: context?.markdown ?? "",
      cards: flow.cards().map((c) => ({ key: c.key, name: c.text?.title ?? c.node.name, file: c.node.file, selected: selected.has(c.key), ...(c.text && { note: true }), ...(c.folder && { folder: c.folder }), ...(c.group && { group: c.group }) })),
      ...(flow.asked && { question: flow.asked.question }),
      ...(flow.groups().length && { groups: flow.groups() }),
    };
  }
  if (op === "apply") {
    // Cards named by the model, as the canvas's keys; what isn't there is reported.
    const missing = [];
    const key = (ref) => cardKey(flow, ref) ?? (missing.push(ref), null);
    const actions = args.actions
      .map((a) =>
        a.kind === "expand" ? (key(a.card) ? { kind: "expand", card: cardKey(flow, a.card) } : null) : a.cards ? { ...a, cards: a.cards.map(key).filter(Boolean) } : a
      )
      .filter((a) => a && (!a.cards || a.cards.length));
    await flow.apply(actions, { undoGroup: `tool-${Date.now()}` });
    return { cards: flow.cards().map((c) => c.text?.title ?? c.node.name), ...(missing.length && { missing }) };
  }
  throw new Error(`unknown canvas request ${op}`);
}
