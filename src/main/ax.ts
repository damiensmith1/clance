import { join } from "path";

// Clance's window into the macOS accessibility tree — the typed face of
// native/ax, which is where the AXUIElement work actually happens. Lets a
// session read a field, a selection or a window's text as text, instead of
// taking a screenshot and inferring it from pixels.
//
// Everything here is best-effort by design. The addon is compiled at build
// time (scripts/build-native.mjs) and that build is allowed to fail, so a
// checkout without the Xcode command line tools still runs — the tools
// built on this just report themselves unavailable. Nothing in this module
// throws.

type NativeAddon = {
  call(request: string): Promise<string>;
  callSync(request: string): string;
};

// From dist/main/ax.js this resolves to <app>/native/ax/build/Release/ax.node,
// which holds in dev and in the packaged app alike: electron-builder copies
// the binary to the same place relative to dist/ (asar is off, see
// package.json's build.files).
const ADDON_PATH = join(__dirname, "..", "..", "native", "ax", "build", "Release", "ax.node");

let addon: NativeAddon | null = null;
let loadError: string | null = null;

function load(): NativeAddon | null {
  if (addon || loadError) return addon;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    addon = require(ADDON_PATH) as NativeAddon;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    console.warn(`ax: accessibility addon unavailable (${loadError})`);
  }
  return addon;
}

export type AxFrame = { x: number; y: number; width: number; height: number };
export type AxRange = { location: number; length: number };

export type AxElement = {
  // Identifies this element for a later read or action. Valid until it's
  // released or evicted — the addon keeps a bounded table (see ax.mm).
  handle: number;
  role?: string;
  subrole?: string;
  roleDescription?: string;
  title?: string;
  label?: string;
  help?: string;
  placeholder?: string;
  value?: unknown;
  selectedText?: string;
  selectedRange?: AxRange;
  frame?: AxFrame;
  editable?: boolean;
  attributes?: string[];
  actions?: string[];
  windowTitle?: string;
  app?: { pid: number; name?: string | null; bundleId?: string | null };
};

export type AxNode = AxElement & { depth: number; parent: number };

type AxResult = { ok: boolean; error?: string; [key: string]: unknown };

// A failure shape rather than a throw: every caller here is a tool a model
// invokes, and "couldn't read the screen" is an answer it can pass on.
function unavailable(): AxResult {
  return { ok: false, error: loadError ? "accessibility-addon-failed" : "accessibility-addon-missing" };
}

async function call(op: Record<string, unknown>): Promise<AxResult> {
  const native = load();
  if (!native) return unavailable();
  try {
    return JSON.parse(await native.call(JSON.stringify(op))) as AxResult;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function callSync(op: Record<string, unknown>): AxResult {
  const native = load();
  if (!native) return unavailable();
  try {
    return JSON.parse(native.callSync(JSON.stringify(op))) as AxResult;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether the addon loaded at all — false on a build without it. */
export function isAvailable(): boolean {
  return load() !== null;
}

/**
 * Whether macOS will answer accessibility queries for this process. False
 * means the Accessibility permission is missing, which every tool built on
 * this should report as "turn it on in Settings" rather than "nothing found".
 */
export function isTrusted(): boolean {
  const result = callSync({ op: "isTrusted" });
  return result.ok === true && result.trusted === true;
}

/** The element with keyboard focus, anywhere on the system. */
export async function focusedElement(): Promise<AxElement | null> {
  const result = await call({ op: "focusedElement" });
  return result.ok ? ((result.element as AxElement | null) ?? null) : null;
}

/** The frontmost app's focused window. */
export async function focusedWindow(): Promise<AxElement | null> {
  const result = await call({ op: "focusedWindow" });
  return result.ok ? ((result.element as AxElement | null) ?? null) : null;
}

/** Whatever is under a screen point — the read half of clicking. */
export async function elementAt(x: number, y: number): Promise<AxElement | null> {
  const result = await call({ op: "elementAt", x, y });
  return result.ok ? ((result.element as AxElement | null) ?? null) : null;
}

export async function describe(handle: number): Promise<AxElement | null> {
  const result = await call({ op: "describe", handle });
  return result.ok ? ((result.element as AxElement | null) ?? null) : null;
}

export async function attributes(
  handle: number,
  names?: string[]
): Promise<Record<string, unknown> | null> {
  const result = await call({ op: "attributes", handle, ...(names ? { names } : {}) });
  return result.ok ? ((result.values as Record<string, unknown>) ?? {}) : null;
}

export type AxTree = { nodes: AxNode[]; truncated: boolean };

/**
 * The element tree under a window (or a given element), flattened, with each
 * node's parent index. Bounded by depth and node count — a web page's tree
 * is effectively unbounded — and `truncated` says when the bounds bit.
 */
export async function tree(options: {
  handle?: number;
  root?: "focusedWindow" | "focusedElement";
  maxDepth?: number;
  maxNodes?: number;
  includeFrames?: boolean;
} = {}): Promise<AxTree> {
  const result = await call({ op: "tree", root: "focusedWindow", ...options });
  return {
    nodes: result.ok ? ((result.nodes as AxNode[]) ?? []) : [],
    truncated: result.truncated === true,
  };
}

/** The readable text of a window, de-duplicated, as text rather than pixels. */
export async function windowText(
  options: { handle?: number; maxChars?: number; maxNodes?: number } = {}
): Promise<{ text: string; truncated: boolean }> {
  const result = await call({ op: "windowText", ...options });
  return {
    text: result.ok ? ((result.text as string) ?? "") : "",
    truncated: result.truncated === true,
  };
}

/** Replaces an element's whole value. Fails when the app won't allow it. */
export async function setValue(handle: number, value: string): Promise<boolean> {
  return (await call({ op: "setValue", handle, value })).ok === true;
}

/** Replaces just the selected range of a text element. */
export async function setSelectedText(handle: number, value: string): Promise<boolean> {
  return (await call({ op: "setSelectedText", handle, value })).ok === true;
}

/** Performs an element's own action ("AXPress" and friends). */
export async function performAction(handle: number, action: string): Promise<boolean> {
  return (await call({ op: "performAction", handle, action })).ok === true;
}

/**
 * Drops handles the addon is holding. Elements are retained while a handle
 * lives, so a caller that walked a tree should release it once it's done
 * rather than wait for the table's own eviction.
 */
export async function release(handles?: number[]): Promise<void> {
  await call({ op: "release", ...(handles ? { handles } : {}) });
}
