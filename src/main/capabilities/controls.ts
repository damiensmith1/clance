import * as ax from "../ax";
import { clickAtScreenPoint } from "../frontApp";
import { type Outcome, ok, fail } from "./types";
import { resolveReadTarget, type ReadTarget } from "./target";

// Roles click_element will press. Deliberately a list rather than "anything
// with an AXPress action": a web page marks whole groups and rows pressable,
// and clicking a container because its text happened to match is exactly the
// wrong-thing-clicked this tool exists to avoid.
const CLICKABLE_ROLES = new Set([
  "AXButton",
  "AXLink",
  "AXMenuItem",
  "AXMenuButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXTabButton",
  "AXToolbarButton",
  "AXDisclosureTriangle",
  "AXIncrementor",
  "AXSwitch",
]);

export type Control = {
  node: ax.AxNode;
  label: string;
  detail?: string;
  /**
   * Inside the page or document, rather than the app's own chrome.
   *
   * A browser's Back, Forward and Reload buttons sit outside the
   * `AXWebArea`; everything on the page sits inside it. That distinction is
   * what "the first link" has to mean — nobody counting links on a search
   * results page starts with the toolbar.
   */
  inContent?: boolean;
  /**
   * Inside the window's visible bounds, rather than scrolled out of view.
   *
   * A page's accessibility tree is the whole document; the user sees one
   * screenful. Measured on a real page: 23 links in the tree, 3 on screen.
   * Without this the assistant answers questions about a document while the
   * person asking is looking at a window — which is why "the first link"
   * meant a skip-navigation link nobody can see.
   *
   * Off-screen controls are kept rather than dropped, because "click Send"
   * should still work when Send is just below the fold. They sort last and
   * say so, and never count towards "the first".
   */
  onScreen?: boolean;
};

// Walks each node's ancestors once to mark what's inside a web area. The
// tree comes back flattened with parent indices, so this costs nothing
// beyond the walk that already happened.
function markContent(nodes: ax.AxNode[]): Set<number> {
  const inside = new Set<number>();
  nodes.forEach((_, index) => {
    for (let i: number = index; i >= 0; i = nodes[i].parent) {
      if (nodes[i].role === "AXWebArea") {
        inside.add(index);
        return;
      }
      if (nodes[i].parent < 0) return;
    }
  });
  return inside;
}

/**
 * A control's label, trimmed to what a person would call it.
 *
 * A search result's accessibility label is the headline, the full URL and
 * the breadcrumb, all run together — one real example ran to
 * `"John Stewart (character) Wikipedia https://en.wikipedia.org › wiki ›
 * John_Stewart_(charact…"`. A hundred and thirty-nine of those made a
 * 7,000-token question that nobody could answer: the model had to pick
 * between near-identical walls of URL, and did so at p=0.31.
 *
 * So: the first line, up to the URL, capped. What's cut is never what the
 * user would have said out loud.
 */
const MAX_LABEL = 60;

export function labelOf(node: ax.AxNode): string {
  const joined = [node.title, node.label, typeof node.value === "string" ? node.value : ""]
    .filter(Boolean)
    .join(" ")
    .trim();
  const firstLine = joined.split(/[\r\n]/)[0].trim();
  const beforeUrl = firstLine.replace(/\s*https?:\/\/\S.*$/i, "").trim();
  const text = beforeUrl || firstLine;
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1).trimEnd()}…` : text;
}

// Every labelled, pressable control in a window. clickElement narrows this
// by name; the assistant's `target` resolver hands the whole list to the
// decider as candidates (docs/design.md §"Intents and resolvers"), which is
// why the walk lives here rather than inside the tool.
/** Whether a frame overlaps the window the user is looking at. */
function visibleIn(frame: ax.AxFrame | undefined, window: ax.AxFrame | undefined): boolean {
  // Zero-sized is the usual shape of a hidden skip-navigation link.
  if (!frame || frame.width <= 1 || frame.height <= 1) return false;
  if (!window) return true;
  return (
    frame.y + frame.height > window.y &&
    frame.y < window.y + window.height &&
    frame.x + frame.width > window.x &&
    frame.x < window.x + window.width
  );
}

type Walk = { nodes: ax.AxNode[]; window?: ax.AxFrame; content: Set<number> };

// One walk per command, shared.
//
// Walking a window's tree costs ~300 ms on a big page, and the resolvers
// that need it — press, focus, dictate-into — each used to ask for their
// own, so a single spoken command paid for the same tree three times.
// Memoizing the *promise* rather than the result is what makes that work
// when `gatherCandidates` fires every resolver in parallel: the first
// caller starts the walk and the rest wait on it.
//
// Never a TTL: the tree is thrown away explicitly at the start of each
// gather, so it is always exactly as old as the command being decided.
let walking: Promise<Walk> | null = null;

export function forgetWindowTree(): void {
  walking = null;
}

function readWindowTree(target: ReadTarget): Promise<Walk> {
  if (walking) return walking;
  walking = (async () => {
    // Frames cost +64 ms on a 1200-node tree, measured — cheap enough to
    // pay once per command, and the difference between describing a
    // document and describing what the user is looking at.
    const [{ nodes }, window] = await Promise.all([
      ax.tree({ pid: target.pid, maxNodes: 1200, maxDepth: 25, includeFrames: true }),
      ax.focusedWindow(target.pid),
    ]);
    return { nodes, window: window?.frame, content: markContent(nodes) };
  })();
  return walking;
}

export async function listControls(target: ReadTarget): Promise<Control[]> {
  const { nodes, window, content } = await readWindowTree(target);
  const controls = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => CLICKABLE_ROLES.has(node.role ?? "") && labelOf(node))
    .map(({ node, index }) => ({
      node,
      label: labelOf(node),
      inContent: content.has(index),
      onScreen: visibleIn(node.frame, window),
    }));

  // Visible first, then what's in the page, then down and across it.
  //
  // Reading order alone is not enough in a browser, because the browser's
  // own furniture is at the top of the window and therefore first. Measured
  // on a real Google results page: the first eighteen controls in reading
  // order were ten tab-strip buttons followed by New Tab, Ask Gemini, Tab
  // Search, Close, Back, Forward and Reload — and only twenty-two of the
  // page's own links were on screen at all. A list capped for size then
  // drops the page and keeps the tab bar, which is exactly backwards: a
  // command spoken at a browser is almost always about the page.
  return controls.sort((a, b) => {
    if (a.onScreen !== b.onScreen) return a.onScreen ? -1 : 1;
    if (a.inContent !== b.inContent) return a.inContent ? -1 : 1;
    const ay = a.node.frame?.y ?? 0;
    const by = b.node.frame?.y ?? 0;
    if (Math.abs(ay - by) > 4) return ay - by;
    return (a.node.frame?.x ?? 0) - (b.node.frame?.x ?? 0);
  });
}

// Press one control, having already chosen it. AXPress where the control
// offers it — it needs no focus and can't land on whatever happens to be
// under a coordinate. Otherwise click the middle of the element's own frame,
// which is still better aimed than a guess off a screenshot.
export async function pressControl(control: Control, where: string): Promise<Outcome> {
  const { node, label } = control;

  // Re-read the element immediately before acting on it.
  //
  // A control is chosen from a tree read some hundreds of milliseconds ago,
  // and between the two the page can navigate, a dialog can open, a list
  // can re-render. This matters far more now that one spoken goal takes
  // several steps: a handle picked in step one is acted on after step two
  // has already changed the screen.
  //
  // `describe` returning nothing means the element is gone. Falling back to
  // the frame captured earlier — which is what this used to do — clicks the
  // coordinates where the control *used to be*, which is whatever has since
  // moved into that space. Refusing is the only safe answer.
  const described = await ax.describe(node.handle);
  if (!described) {
    return fail(`"${label}" is no longer there — ${where} has changed since it was found.`);
  }
  if (described.actions?.includes("AXPress")) {
    const pressed = await ax.performAction(node.handle, "AXPress");
    if (pressed) return ok(`Pressed "${label}" (${node.role}) in ${where}.`);
  }
  const frame = described.frame;
  if (!frame || frame.width <= 0 || frame.height <= 0) {
    return fail(`Found "${label}" but it can't be pressed and has no position to click.`);
  }
  try {
    await clickAtScreenPoint(frame.x + frame.width / 2, frame.y + frame.height / 2);
    return ok(`Clicked "${label}" (${node.role}) in ${where} at its centre.`);
  } catch (error) {
    return fail(`Failed to click "${label}": ${(error as Error).message}`);
  }
}

export async function clickElement(target: string, app?: string): Promise<Outcome> {
  const resolved = await resolveReadTarget(app);
  if ("error" in resolved) return fail(resolved.error);

  const clickable = await listControls(resolved);
  const needle = target.trim().toLowerCase();
  const exact = clickable.filter((control) => control.label.toLowerCase() === needle);
  const partial = clickable.filter((control) => control.label.toLowerCase().includes(needle));
  const matches = exact.length > 0 ? exact : partial;

  if (matches.length === 0) {
    const nearby = clickable.slice(0, 12).map((control) => `"${control.label}"`).join(", ");
    return fail(
      `Nothing clickable called "${target}" in ${resolved.label}.` +
        (nearby ? ` What's there: ${nearby}.` : " Nothing clickable was found at all.")
    );
  }
  if (matches.length > 1) {
    const options = matches
      .slice(0, 8)
      .map((control) => `"${control.label}" (${control.node.role})`)
      .join(", ");
    return fail(`"${target}" matches more than one control: ${options}. Be more specific.`);
  }

  return pressControl(matches[0], resolved.label);
}

// The roles a "field" can be — where text goes. Kept apart from
// CLICKABLE_ROLES because pressing a button and putting the cursor in a
// search box are different intents that happen to use the same gesture.
const FIELD_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXComboBox",
  "AXSearchField",
  "AXSecureTextField",
]);

export async function listFields(target: ReadTarget): Promise<Control[]> {
  const { nodes } = await readWindowTree(target);
  return nodes
    .filter((node) => FIELD_ROLES.has(node.role ?? ""))
    // One label, not all of them joined. Chrome's omnibox carries a title
    // *and* a placeholder, and concatenating them gave "Address and search
    // bar Ask Google or type a URL" — which reads badly in the HUD and
    // matches badly against "the address bar", because every extra word
    // dilutes the ones the user actually said.
    //
    // A field's own value is never part of either: matching "the note
    // field" against what the user already typed into it would be matching
    // on their content, and content is exactly what never reaches the
    // decider (docs/design.md, "What leaves the Mac").
    .map((node) => {
      const parts = [node.title, node.label, node.placeholder].map((part) => (part ?? "").trim());
      const label = parts.find(Boolean) ?? "";
      const rest = parts.filter((part) => part && part !== label);
      return { node, label, ...(rest.length ? { detail: rest.join(" · ") } : {}) };
    })
    .filter((control) => control.label);
}

/**
 * Puts the cursor in a field. Clicking it rather than setting AXFocused:
 * a click is what the app itself expects, and it lands the caret where a
 * person's would rather than at whatever offset the field last held.
 */
export async function focusField(control: Control, where: string): Promise<Outcome> {
  const { node, label } = control;
  if (node.secure) {
    // Focusing one is allowed — writing into it or reading it never is
    // (docs/assistant.md, "Confidence, confirmation and refusal").
    const described = await ax.describe(node.handle);
    const frame = described?.frame ?? node.frame;
    if (frame && frame.width > 0) {
      await clickAtScreenPoint(frame.x + frame.width / 2, frame.y + frame.height / 2);
    }
    return ok(`Focused the password field in ${where}. Clance won't type into it — the user has to.`);
  }
  const described = await ax.describe(node.handle);
  if (!described) {
    return fail(`"${label}" is no longer there — ${where} has changed since it was found.`);
  }
  const frame = described.frame;
  if (!frame || frame.width <= 0 || frame.height <= 0) {
    return fail(`Found "${label}" in ${where} but it has no position to click.`);
  }
  try {
    await clickAtScreenPoint(frame.x + frame.width / 2, frame.y + frame.height / 2);
    return ok(`Focused "${label}" in ${where}.`);
  } catch (error) {
    return fail(`Couldn't focus "${label}": ${(error as Error).message}`);
  }
}
