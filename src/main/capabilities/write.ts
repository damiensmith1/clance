import * as ax from "../ax";
import {
  typeIntoCapturedWindow,
  clearFocusedField,
  replaceFocusedField,
} from "../frontApp";
import { type Outcome, ok, fail } from "./types";
import { resolveReadTarget } from "./target";

// "an AXWebArea", not "a AXWebArea" — these strings are read by a model and
// then often repeated to the user.
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

export type WriteMode = "replace" | "insert" | "clear";

export async function writeField(
  { text, mode, app }: { text?: string; mode?: WriteMode; app?: string }
): Promise<Outcome> {
  const action = mode ?? "replace";
  const value = action === "clear" ? "" : (text ?? "");
  if (action !== "clear" && !text) {
    return fail("Nothing to write — pass `text`, or use mode \"clear\".");
  }

  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  const { element } = await ax.focusedField(target.pid);
  if (!element) {
    return fail(`No field is focused in ${target.label}, so there's nothing to write into.`);
  }
  if (element.editable === false) {
    // Reported rather than attempted: the write would "succeed" against
    // something that can't hold text and only the read-back afterwards
    // would notice, which reads like a mysterious failure.
    return fail(
      `The focused element in ${target.label} is ${article(element.role ?? "control")}` +
        `${element.title ? ` ("${element.title}")` : ""}, not an editable field. ` +
        "Click into the field first, or name the app whose field you mean."
    );
  }
  if (element.secure) {
    return fail(
      "The focused field is a password field. Clance won't write into one — ask the user to " +
        "type it themselves."
    );
  }

  const before = typeof element.value === "string" ? element.value : "";
  const expected = action === "insert" ? null : value;

  // The accessibility route first: it needs no focus, no clipboard and
  // no keystrokes, so it can't disturb what the user is doing.
  let wrote =
    action === "insert"
      ? await ax.setSelectedText(element.handle, value)
      : await ax.setValue(element.handle, value);

  // Some apps accept the write and ignore it — Chromium reports success
  // on a text field it never changes — so trust the field, not the
  // return code.
  const afterAx = await ax.describe(element.handle);
  const axValue = typeof afterAx?.value === "string" ? afterAx.value : "";
  const axWorked = wrote && (expected === null ? axValue !== before : axValue === expected);

  if (!axWorked) {
    // Fall back to driving the keyboard, which is what this tool used to
    // do exclusively: focus the app, select all where the whole field is
    // being replaced, and paste.
    try {
      if (action === "clear") await clearFocusedField(app);
      else if (action === "replace") await replaceFocusedField(value, app);
      else await typeIntoCapturedWindow(value, app);
      wrote = true;
    } catch (error) {
      return fail(`Couldn't write to the field: ${(error as Error).message}`);
    }
  }

  const after = await ax.describe(element.handle);
  const afterValue = typeof after?.value === "string" ? after.value : null;
  const via = axWorked ? "accessibility" : "keystrokes";
  if (afterValue === null) {
    return ok(`Wrote to the field via ${via}, but couldn't read it back to confirm.`);
  }
  const changed = afterValue !== before;
  const summary = changed
    ? `Field now contains (via ${via}):\n${afterValue || "(empty)"}`
    : `The field still contains what it did before, so the write didn't take:\n${afterValue || "(empty)"}`;
  return changed ? ok(summary) : fail(summary);
}
