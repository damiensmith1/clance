import * as ax from "../ax";
import { pasteAtCursor } from "../frontApp";
import { type Outcome, ok, fail } from "./types";
import { resolveReadTarget, type ReadTarget } from "./target";
import { menuCommands, pressMenuCommand } from "./menu";
import { chord, pressEnter } from "./keys";

// Commands that carry their own content: "search for X", "type X", "find X
// on this page".
//
// The words come from the user's own transcript — selected there by the
// decider, copied verbatim by code, never generated (docs/design.md,
// "Filling an argument"). What's left for this module is the part no model
// should be asked about: *where the text goes*, which is a matter of fact
// about the app in front, not a judgement.

async function focusedFieldExists(target: ReadTarget): Promise<boolean> {
  const { element } = await ax.focusedField(target.pid);
  return Boolean(element) && element?.editable !== false;
}

/**
 * Put the cursor where text should go, by whichever route the app allows.
 *
 * A ladder rather than one mechanism, because no single one works
 * everywhere: the app's own menu command is the most reliable and the most
 * specific, an accessibility field is next, and the keyboard chord every
 * Mac app answers is the floor. Each rung is checked rather than assumed —
 * the point of the ladder is to know which one worked.
 */
async function focusVia(
  target: ReadTarget,
  menuNames: RegExp,
  fallback: { key: string; command?: boolean; shift?: boolean }
): Promise<boolean> {
  const commands = await menuCommands(target).catch(() => []);
  const command = commands.find((entry) => entry.enabled && menuNames.test(entry.label));
  if (command) {
    const pressed = await pressMenuCommand(command, target.label);
    if (pressed.ok) {
      await settle();
      if (await focusedFieldExists(target)) return true;
    }
  }
  try {
    await chord(fallback);
  } catch {
    return false;
  }
  await settle();
  return focusedFieldExists(target);
}

// Focus changes aren't instant; the field has to actually have it before a
// paste can land in it.
function settle(ms = 140): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Type text into whatever field is focused right now. */
export async function typeText(text: string, app?: string): Promise<Outcome> {
  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  const { element } = await ax.focusedField(target.pid);
  if (!element) {
    return fail(`Nothing in ${target.label} is focused to type into. Click into a field first.`);
  }
  if (element.secure) {
    return fail("That's a password field. Clance won't type into one — the user has to.");
  }
  if (element.editable === false) {
    return fail(`What's focused in ${target.label} can't hold text.`);
  }
  try {
    await pasteAtCursor(text);
    return ok(`Typed "${text}".`);
  } catch (error) {
    return fail(`Couldn't type that: ${(error as Error).message}`);
  }
}

/** Search the web: focus the address bar, replace what's there, go. */
export async function searchWeb(query: string, app?: string): Promise<Outcome> {
  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  // "Open Location…" in Chrome and Safari, "Search or Enter Address" in
  // others. ⌘L is the floor and is near-universal in browsers.
  const focused = await focusVia(target, /^(open location|address|search or enter)/i, {
    key: "L",
    command: true,
  });
  if (!focused) {
    return fail(
      `Couldn't find an address bar in ${target.label}. Searching the web needs a browser in front.`
    );
  }
  try {
    // ⌘L selects the whole location, so a paste replaces it rather than
    // appending to whatever URL was already there.
    await pasteAtCursor(query);
    await settle();
    await pressEnter();
    return ok(`Searched for "${query}".`);
  } catch (error) {
    return fail(`Couldn't search for that: ${(error as Error).message}`);
  }
}

/** Find within the page or document in front. */
export async function findHere(query: string, app?: string): Promise<Outcome> {
  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  const focused = await focusVia(target, /^find(\.\.\.|…)?$/i, { key: "F", command: true });
  if (!focused) {
    return fail(`${target.label} doesn't seem to have a find box.`);
  }
  try {
    await pasteAtCursor(query);
    await settle();
    await pressEnter();
    return ok(`Looking for "${query}" in ${target.label}.`);
  } catch (error) {
    return fail(`Couldn't search for that: ${(error as Error).message}`);
  }
}
