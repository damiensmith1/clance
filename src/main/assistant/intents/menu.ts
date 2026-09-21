import { currentMenuCommands, pressMenuCommand, type MenuCommand } from "../../capabilities";
import type { Candidate, Context, Resolver } from "../types";

// The resolver that makes the assistant general.
//
// Every macOS app publishes its whole menu bar through the accessibility
// API, so "new note", "save", "export as PDF" and "close tab" are read off
// the app in front rather than taught to Clance. An app installed tomorrow
// works today.

// Words that make a command worth confirming however clearly it was heard.
// A lexicon, not a classifier: it is deliberately over-broad, and the noise
// it creates is meant to be answered by the user allowing specific commands
// rather than by trimming this list (docs/design.md, "Risk and
// confirmation").
const DESTRUCTIVE = /\b(delete|remove|trash|send|discard|erase|clear|reset|empty|destroy|revert|overwrite|replace all|move to bin)\b/i;

function riskOf(command: MenuCommand): "safe" | "confirm" {
  return DESTRUCTIVE.test(command.path) ? "confirm" : "safe";
}

let lastCommands: MenuCommand[] = [];

export const menuResolver: Resolver = {
  id: "menu",
  // The intent's default. Narrowed per command below — most menu items are
  // ordinary, and confirming every "save" would make the assistant useless.
  risk: "safe",
  async candidates(ctx: Context): Promise<Candidate[]> {
    lastCommands = await currentMenuCommands(ctx.target, {
      bundleId: ctx.app.bundleId,
      windowTitle: ctx.app.windowTitle,
    });
    return lastCommands.map((command) => ({
      id: command.path,
      label: command.label,
      detail: command.path,
      unavailable: !command.enabled,
    }));
  },
  async resolve(candidate, ctx) {
    const command = lastCommands.find((c) => c.path === candidate.id);
    if (!command) return null;
    return {
      intent: "menu",
      label: `${command.label} — ${ctx.app.name}`,
      risk: riskOf(command),
      perform: () => pressMenuCommand(command, ctx.app.name),
      // The app's own undo, which is the second tier: it works far more
      // often than it doesn't, and says so plainly when the app refuses.
      undo: async () => {
        const undoCommand = lastCommands.find((c) => /^undo\b/i.test(c.label));
        if (!undoCommand) {
          return { ok: false as const, text: `${ctx.app.name} has no Undo command to use.` };
        }
        return pressMenuCommand({ ...undoCommand, enabled: true }, ctx.app.name);
      },
    };
  },
};
