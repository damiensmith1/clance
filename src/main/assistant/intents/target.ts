import {
  focusField,
  listControls,
  listFields,
  pressControl,
  isBrowser,
  readPage,
  clickElementInPage,
  typeInPage,
  type Control,
  type PageElement,
} from "../../capabilities";
import { log, warn } from "../log";
import type { Candidate, Context, Resolver } from "../types";

// Things on screen, named the way they're labelled — "the Send button",
// "the search field". One resolver for both because the user doesn't
// distinguish them: they say what they mean and the control's own role
// decides whether that means press it or put the cursor in it.

type Known =
  | { control: Control; kind: "press" | "focus" }
  // A real DOM element, reached through the page rather than through the
  // accessibility tree — see capabilities/browser.ts for why that matters.
  | { element: PageElement; kind: "dom"; bundleId: string };

/**
 * Whether the browser has let Clance read the page, and why not.
 *
 * Remembered so the session can say it once rather than on every command,
 * and cleared when the answer might have changed.
 */
let browserBlocked: string | null = null;

export function browserAccessBlocked(): string | null {
  return browserBlocked;
}

export function forgetBrowserAccess(): void {
  browserBlocked = null;
}

/**
 * A web page's own elements, if this is a browser and it will show them.
 *
 * Returns null for everything else, which is most apps, and the caller
 * falls back to the accessibility tree.
 */
async function pageCandidates(ctx: Context): Promise<Candidate[] | null> {
  if (!isBrowser(ctx.app.bundleId)) return null;
  const page = await readPage(ctx.app.bundleId);
  if ("blocked" in page) {
    if (browserBlocked !== page.blocked) warn(page.blocked);
    browserBlocked = page.blocked;
    return null;
  }
  browserBlocked = null;
  known = new Map();
  const candidates: Candidate[] = [];
  for (const element of page.elements) {
    const id = `dom:${element.id}`;
    known.set(id, { element, kind: "dom", bundleId: ctx.app.bundleId });
    candidates.push({
      id,
      label: element.name || element.placeholder || element.role,
      detail: [element.role, element.href, element.inView ? null : "scrolled out of view"]
        .filter(Boolean)
        .join(", "),
    });
  }

  // "The first link" means the first one the user can see, in reading
  // order — which the DOM knows exactly and the accessibility tree only
  // approximates. The page arrives already sorted that way.
  for (const [role, noun] of POSITIONAL_ROLES_DOM) {
    const ofRole = page.elements.filter((element) => element.inView && element.role === role);
    ofRole.slice(0, ORDINALS.length).forEach((element, index) => {
      candidates.push({
        id: `dom:${element.id}`,
        label: `the ${ORDINALS[index]} ${noun}`,
        detail: element.name || element.href || element.role,
      });
    });
    const last = ofRole[ofRole.length - 1];
    if (last && ofRole.length > 1) {
      candidates.push({ id: `dom:${last.id}`, label: `the last ${noun}`, detail: last.name || last.role });
    }
  }
  log(`page: ${page.elements.length} elements, ${page.elements.filter((e) => e.inView).length} in view`);
  return candidates;
}

const POSITIONAL_ROLES_DOM: [string, string][] = [
  ["link", "link"],
  ["button", "button"],
];

// Document order, which is what "first" means to someone looking at a page.
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];
/** How many scrolled-away controls stay reachable by name. */
const OFF_SCREEN_TAIL = 20;

/** The most controls one window contributes, in reading order. */
const MAX_TARGETS = 60;

const POSITIONAL_ROLES: [string, string][] = [
  ["AXLink", "link"],
  ["AXButton", "button"],
];

let known = new Map<string, Known>();

export const targetResolver: Resolver = {
  id: "target",
  // Not structurally risky any more.
  //
  // Blanket-confirming every press was right when nothing else could tell a
  // "Delete" from a "Read more". Now the decider answers a `destructive`
  // question in the same call — measured at 0.03 for opening a search
  // result — and that can still raise this to a confirmation whenever it
  // fires. Asking before every single click, at 0.90 confidence and 0.06
  // destructive, was the assistant being useless rather than careful.
  risk: "safe",
  async candidates(ctx: Context): Promise<Candidate[]> {
    // A browser's accessibility tree is a lossy projection of its DOM, so
    // where the DOM is reachable it wins outright.
    const fromPage = await pageCandidates(ctx);
    if (fromPage) return fromPage;

    const [allControls, fields] = await Promise.all([listControls(ctx.target), listFields(ctx.target)]);

    // Everything on screen, and only a little of what isn't.
    //
    // `listControls` returns the whole window — 135 controls on a busy page,
    // most of them scrolled away. Offering all of them crowds out every
    // other intent and describes a document rather than a view. Keeping a
    // tail of off-screen controls means "click Send" still works when Send
    // is just below the fold, which was the reason for keeping them at all.
    const onScreen = allControls.filter((control) => control.onScreen);
    const below = allControls.filter((control) => !control.onScreen).slice(0, OFF_SCREEN_TAIL);
    // A web app can put 141 controls on one screen, which crowds out every
    // other intent on its own. They arrive in reading order, so the first
    // of them are the ones nearest the top of what the user is looking at.
    const controls = [...onScreen, ...below].slice(0, MAX_TARGETS);

    known = new Map();
    const candidates: Candidate[] = [];
    for (const control of controls) {
      const id = `press:${control.node.handle}`;
      known.set(id, { control, kind: "press" });
      candidates.push({
        id,
        label: control.label,
        // What the user can see is part of what the option *means*, so it
        // goes in the description Jev reads rather than being filtered out
        // behind its back.
        detail: control.onScreen ? control.node.role : `${control.node.role}, scrolled out of view`,
      });
    }

    // "Click the first link" names a thing by where it is, not what it's
    // called — and on a page of search results, what things are called is
    // barely distinguishable anyway. These ride alongside the named
    // candidates rather than replacing them: same ids, so either route
    // resolves to the same control, and the detail says which one it is so
    // the confirmation is still readable.
    // Counted within the page where there is one, so "the first link" isn't
    // the browser's Back button or a toolbar item.
    const visible = controls.filter((control) => control.onScreen);
    const pool = visible.length > 0 ? visible : controls;
    const countable = pool.some((control) => control.inContent)
      ? pool.filter((control) => control.inContent)
      : pool;
    for (const [role, noun] of POSITIONAL_ROLES) {
      const ofRole = countable.filter((control) => control.node.role === role);
      ofRole.slice(0, ORDINALS.length).forEach((control, index) => {
        candidates.push({
          id: `press:${control.node.handle}`,
          label: `the ${ORDINALS[index]} ${noun}`,
          detail: control.label,
        });
      });
      const last = ofRole[ofRole.length - 1];
      if (last && ofRole.length > 1) {
        candidates.push({ id: `press:${last.node.handle}`, label: `the last ${noun}`, detail: last.label });
      }
    }
    for (const control of fields) {
      const id = `focus:${control.node.handle}`;
      known.set(id, { control, kind: "focus" });
      candidates.push({ id, label: control.label, detail: `${control.node.role} (field)` });
    }
    return candidates;
  },
  async resolve(candidate, ctx) {
    const entry = known.get(candidate.id);
    if (!entry) return null;

    if (entry.kind === "dom") {
      const { element, bundleId } = entry;
      const name = element.name || element.placeholder || element.role;
      const typing = element.role === "textbox" || element.role === "searchbox" || element.role === "combobox";
      return {
        intent: "target",
        label: typing ? `Focus "${name}"` : `Click "${name}"`,
        // Clicking a real element rather than a coordinate: it scrolls
        // itself into view and the page decides what it means.
        risk: "safe",
        perform: () =>
          typing
            ? typeInPage(bundleId, element.id, "", false, name)
            : clickElementInPage(bundleId, element.id, name),
      };
    }

    if (entry.kind === "focus") {
      return {
        intent: "target",
        label: `Focus "${entry.control.label}"`,
        risk: "safe",
        perform: () => focusField(entry.control, ctx.app.name),
      };
    }
    return {
      intent: "target",
      label: `Press "${entry.control.label}"`,
      risk: "safe",
      perform: () => pressControl(entry.control, ctx.app.name),
    };
  },
};

/** The controls the last candidate pass saw, for the HUD's ambiguity list. */
export function lastKnownControls(): Map<string, Known> {
  return known;
}
