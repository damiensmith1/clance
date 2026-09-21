import { readConfig } from "../../config";
import { focusField, listFields } from "../../capabilities";
import { getBridge, viaBridge } from "../bridge";
import type { Candidate, Context, Resolver } from "../types";

// Putting text somewhere.
//
// The important thing this resolver does is *not* handle the words. "Dictate
// into the subject field" resolves to focusing that field and handing over
// to the dictation path; what the user then says is transcribed on the Mac
// and inserted by dictation.ts. It never passes through a decider, which is
// what keeps dictated content off the network by construction
// (docs/design.md, "What leaves the Mac").

type Action = { kind: "dictate"; fieldId?: string } | { kind: "value"; name: string };

let fields = new Map<string, Awaited<ReturnType<typeof listFields>>[number]>();

export const textResolver: Resolver = {
  id: "text",
  // Inserting text is not destructive on its own, and it lands where the
  // user is looking.
  risk: "safe",
  async candidates(ctx: Context): Promise<Candidate[]> {
    const candidates: Candidate[] = [{ id: "dictate", label: "Dictate here" }];

    const available = await listFields(ctx.target);
    fields = new Map(available.map((field) => [`dictate:${field.node.handle}`, field]));
    for (const [id, field] of fields) {
      candidates.push({
        id,
        label: `Dictate into ${field.label}`,
        detail: field.detail ?? field.node.role,
      });
    }

    // Stored values — an email address, a phone number, a snippet. Named by
    // the user in Settings; there are none until they add some, which is
    // why this list is empty rather than seeded with guesses.
    for (const name of Object.keys(readConfig().assistant.values)) {
      candidates.push({ id: `value:${name}`, label: `Insert ${name}` });
    }

    // "Insert what I just dictated" is deliberately *not* offered here any
    // more. Live traffic showed three near-identical dictate options
    // crowding this list, and "Type John Stewart" landing on one of them at
    // p=0.49 with `None of these` right behind — the model saying the right
    // option wasn't on the menu. It wasn't: it was `type`, which now exists.
    return candidates;
  },
  async resolve(candidate, ctx) {
    const action = parse(candidate.id);
    if (!action) return null;

    if (action.kind === "dictate") {
      const field = action.fieldId ? fields.get(action.fieldId) : undefined;
      return {
        intent: "text",
        label: field ? `Dictate into "${field.label}"` : "Dictate here",
        risk: "safe",
        perform: async () => {
          if (field) {
            const focused = await focusField(field, ctx.app.name);
            if (!focused.ok) return focused;
          }
          return viaBridge("start dictating", (bridge) => bridge.startDictation());
        },
      };
    }

    if (action.kind === "value") {
      const value = readConfig().assistant.values[action.name];
      if (value === undefined) return null;
      return {
        intent: "text",
        label: `Insert ${action.name}`,
        risk: "safe",
        perform: () => viaBridge(`insert ${action.name}`, (bridge) => bridge.pasteText(value)),
      };
    }

    return null;
  },
};

function parse(id: string): Action | null {
  if (id === "dictate") return { kind: "dictate" };
  if (id.startsWith("dictate:")) return { kind: "dictate", fieldId: id };
  if (id.startsWith("value:")) return { kind: "value", name: id.slice("value:".length) };
  return null;
}
