import type { Outcome, ReadTarget } from "../capabilities";

// The assistant's vocabulary, in one file.
//
// The shape here is the whole architecture: a *decider* turns a phrase into
// an intent and a candidate, a *resolver* turns that candidate into
// something performable, and the actuator performs it. The decider never
// builds an action and never sees the user's content — see
// docs/design.md §"Assistant".

/** The kinds of thing a spoken command can be. Deliberately few. */
export type IntentId =
  | "launch"
  | "switch"
  | "quit"
  | "menu"
  | "navigate"
  | "window"
  | "target"
  | "site"
  // The three that carry their own content. Their candidates are spans of
  // what the user just said rather than things that exist on the Mac — see
  // spans.ts — which is what lets "search for Jon Stewart" work at all.
  | "search"
  | "find"
  | "type"
  | "text"
  | "clance"
  | "claude";

export const INTENT_IDS: IntentId[] = [
  "launch",
  "switch",
  "quit",
  "menu",
  "navigate",
  "window",
  "target",
  "site",
  "search",
  "find",
  "type",
  "text",
  "clance",
  "claude",
];

/**
 * Whether an action gets performed or asked about first.
 *
 * A property of the intent, narrowed by the resolver — never a judgement
 * the decider makes about itself. Asking the component you don't fully
 * trust whether it should be trusted is not a gate.
 */
export type Risk = "safe" | "confirm";

/** One thing an intent could be about: an app, a menu command, a button. */
export type Candidate = {
  /** Resolver-local. Stable for as long as the context it came from is. */
  id: string;
  /** What the decider matches against and the user hears back. */
  label: string;
  /** Disambiguation shown alongside the label: "File > Save", "(2 windows)". */
  detail?: string;
  /** Present but not currently available — a greyed-out menu item. */
  unavailable?: boolean;
};

/** Where the user is, resolved once per command. */
export type Context = {
  app: { pid?: number; name: string; bundleId: string; windowTitle: string };
  target: ReadTarget;
  /**
   * What was said, for the resolvers whose candidates are slices of it.
   *
   * This is the only place the utterance reaches a resolver, and it is why
   * a span can be a candidate like any other: `candidates()` builds the
   * list, the decider picks one, code copies it. No new machinery.
   */
  utterance: string;
};

/** A chosen thing to do, with a way to do it and a way to take it back. */
export type Resolution = {
  intent: IntentId;
  /** What the HUD shows: "New Note — Notes". */
  label: string;
  risk: Risk;
  perform(): Promise<Outcome>;
  undo?: () => Promise<Outcome>;
};

export interface Resolver {
  id: IntentId;
  /** The intent's default risk, before the resolver narrows it. */
  risk: Risk;
  /** What this intent could be about, here, now. Fed to the decider. */
  candidates(ctx: Context): Promise<Candidate[]>;
  /** Turn one candidate into something performable. */
  resolve(candidate: Candidate, ctx: Context): Promise<Resolution | null>;
}

/**
 * Everything the decider is given. Note what isn't here: no document text,
 * no field contents, nothing dictated. A capability that wanted to send
 * content to a decider would have to add a field to this type, which is a
 * code review rather than a convention (docs/design.md, "What leaves the
 * Mac").
 */
export type Situation = {
  /** The stable prefix of what was said — never a partial word. */
  utterance: string;
  /**
   * What the user actually asked for, which outlives any single step.
   *
   * The assistant pursues a goal rather than performing a command: it
   * looks at the screen, takes one bounded step, looks again. The goal
   * lives here, in code, so the decider never needs memory of its own —
   * every call is answered fresh against what is on screen *now*.
   */
  goal: string;
  /** Steps already performed towards it, in order, as their labels. */
  done: string[];
  app: { name: string; bundleId: string; windowTitle: string };
  candidates: Record<string, Candidate[]>;
  mode: "command" | "dictating";
};

/**
 * What the decider answers.
 *
 * It names an intent and a candidate; it does not build the action. That
 * separation is what lets KeywordDecider and JevDecider be swapped without
 * either of them knowing how anything is performed.
 */
export type Decision =
  | { kind: "wait" }
  /** The goal has been reached; stop stepping. */
  | { kind: "done" }
  | {
      kind: "resolved";
      intent: IntentId;
      candidateId: string;
      confidence: number;
      /**
       * The decider judged that carrying this out would destroy, send or
       * spend something.
       *
       * It can only ever *raise* risk. An intent's own classification is
       * the floor and this never lowers it — asking the component you
       * don't fully trust whether it should be trusted is not a gate, but
       * letting it raise an alarm costs nothing.
       */
      risky?: boolean;
    }
  | { kind: "ambiguous"; intent: IntentId; among: Candidate[] }
  | { kind: "escalate"; prompt: string }
  | { kind: "none" };

export interface Decider {
  /** For the HUD and Settings: "Jev", "local matching". */
  readonly name: string;
  decide(situation: Situation): Promise<Decision>;
  /**
   * Has the goal been reached? Asked between steps, before anything is
   * read off the screen.
   *
   * Separate from `decide` because it is enormously cheaper: it needs the
   * goal and what has been done, and none of the hundred-odd candidates
   * that deciding a *next step* requires. Folded into `decide`, every
   * single-step command paid a full window read and a five-thousand-token
   * call to be told it had already finished.
   *
   * Omitted by deciders that cannot judge progress, which the session
   * reads as "assume finished".
   */
  finished?(situation: Situation): Promise<boolean>;
}
