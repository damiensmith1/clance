import { getState, listTabs, findPane, activateTab, activatePane } from "../state/layoutStore.js";
import { flowOf } from "./FlowSection.js";

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

export async function canvasOp(op, args) {
  if (op === "list") {
    return lodeTabs().map(({ tab, showing, focused }) => {
      const flow = flowOf(tab.id);
      return { canvas: tab.id, label: tab.label, folder: tab.root, cards: flow ? flow.cards().length : 0, ...(flow?.asked && { question: flow.asked.question }), showing, focused };
    });
  }
  const { flow } = await canvasOf(args.canvas);
  if (op === "read") {
    const context = flow.cards().length ? await flow.context(args.budget) : null;
    const selected = new Set(flow.selection().map((c) => c.key));
    return {
      markdown: context?.markdown ?? "",
      cards: flow.cards().map((c) => ({ key: c.key, name: c.text?.title ?? c.node.name, file: c.node.file, selected: selected.has(c.key), ...(c.text && { note: true }) })),
      ...(flow.asked && { question: flow.asked.question }),
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
