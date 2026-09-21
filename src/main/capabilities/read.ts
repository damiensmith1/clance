import * as ax from "../ax";
import { type Outcome, ok, fail } from "./types";
import { resolveReadTarget, unpublishedMessage } from "./target";

export async function readFocusedField(app?: string): Promise<Outcome> {
  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  const { element, via } = await ax.focusedField(target.pid);
  if (!element) {
    return ok(`Nothing is focused in ${target.label} that can be read as text.`);
  }
  if (element.secure) {
    return ok(
      `A password field is focused in ${element.app?.name ?? target.label}. Its contents are ` +
        "never readable through Clance, deliberately — ask the user if you need what's in it."
    );
  }
  const value = typeof element.value === "string" ? element.value : "";
  const lines = [
    `Field in ${element.app?.name ?? target.label}: ${element.role ?? "unknown role"}` +
      (element.editable === false ? " (read-only)" : ""),
  ];
  if (element.placeholder) lines.push(`Placeholder: ${element.placeholder}`);
  if (element.selectedRange) {
    const { location, length } = element.selectedRange;
    lines.push(length > 0 ? `Selected: characters ${location}–${location + length}` : `Cursor at character ${location}`);
  }
  // "marked" means the app wasn't active and this is the field it would
  // return to — worth saying, since it's a claim about a moment ago.
  if (via === "marked-container") lines.push("(no text field was focused; this is the focused element)");
  lines.push("", value.length > 0 ? value : "(the field is empty)");
  return ok(lines.join("\n"));
}

export async function readWindowText(app?: string, maxChars?: number): Promise<Outcome> {
  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  const { text, truncated, publishedNothing } = await ax.windowText({
    pid: target.pid,
    maxChars: maxChars ?? 8000,
  });
  // Not `!text`: an app that published nothing still answers with its
  // window title, which reads like content and would be passed on as if
  // the window really did say only that.
  if (publishedNothing) return ok(unpublishedMessage(target.label));
  if (!text) return ok(`${target.label}'s window has no readable text in it.`);
  return ok(truncated ? `${text}\n\n(truncated)` : text);
}

export async function readSelection(app?: string): Promise<Outcome> {
  const target = await resolveReadTarget(app);
  if ("error" in target) return fail(target.error);

  const { element, via } = await ax.selection(target.pid);
  const name = element?.app?.name ?? target.label;
  if (via === "secure") {
    return ok(`The selection in ${name} is inside a password field, so its contents aren't readable.`);
  }
  const selected = element?.selectedText ?? "";
  if (!selected.trim()) {
    // Checked rather than assumed: an app that published nothing looks
    // exactly like one with nothing selected, and saying "nothing is
    // selected" when the truth is "this app told us nothing" sends the
    // model off to answer a question it could still have answered.
    const { publishedNothing } = await ax.windowText({ pid: target.pid, maxChars: 200 });
    return ok(publishedNothing ? unpublishedMessage(name) : `Nothing is selected in ${name}.`);
  }
  return ok(selected);
}
