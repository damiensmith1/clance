import { readConfig } from "../config";
import { registerTemporaryHotkey } from "../hotkey";
import type { Outcome } from "../capabilities";
import { currentContext } from "./context";
import { currentDecider } from "./decide";
import { gatherCandidates, handOff, resolve } from "./intents";
import { browserAccessBlocked, forgetBrowserAccess } from "./intents/target";
import * as act from "./act/actuator";
import * as hud from "./hud";
import { log, warn } from "./log";
import { TranscriptBuffer } from "./transcript";
import type { Candidate, Context, IntentId, Resolution, Situation } from "./types";

// The listening session: the only thing that knows what mode the assistant
// is in.
//
// One ⌥A press buys a conversation, not one command. The user keeps
// talking, commands fire as they are finished, and the session ends on ⌥A
// again, on Escape, on silence, or on being told to stop.

type State = "idle" | "listening" | "thinking" | "asking" | "acting";

/**
 * One thing the user asked for, and how far it has got.
 *
 * Carried through questions as well as steps: answering "yes" to a
 * confirmation resumes the same pursuit rather than ending it, which is
 * what lets a multi-step task survive being asked about halfway through.
 */
type Pursuit = { goal: string; steps: string[] };

/**
 * How many steps one spoken goal may take.
 *
 * A loop that cannot finish is the one failure mode here that could act on
 * the user's machine indefinitely. Six is generous for anything anyone says
 * in one breath, and the cap ends loudly rather than quietly.
 */
const MAX_STEPS = 6;

type Pending =
  | { kind: "confirm"; resolution: Resolution; ctx: Context; pursuit: Pursuit }
  | { kind: "ambiguous"; intent: IntentId; among: Candidate[]; ctx: Context; pursuit: Pursuit };

let state: State = "idle";
let pending: Pending | null = null;
let buffer = new TranscriptBuffer();
let releaseEscape: (() => void) | undefined;
// Whether this listening session has already mentioned the browser switch.
let told = false;
let idleTimer: NodeJS.Timeout | undefined;

// How the session asks for speech and gives it back. Injected so the
// assistant doesn't depend on dictation.ts, which depends on it.
export type SpeechControl = {
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
};

let speech: SpeechControl | null = null;

export function installSpeech(control: SpeechControl): void {
  speech = control;
}

export function assistantState(): State {
  return state;
}

async function warmContext(): Promise<void> {
  try {
    const ctx = await currentContext();
    if (!("error" in ctx)) await gatherCandidates(ctx);
  } catch {
    // A warm-up that fails costs nothing — consider() does the same work
    // again and reports properly if it's still broken.
  }
}

/** ⌥A: start listening, or stop if already listening. */
export async function toggleAssistant(): Promise<void> {
  if (state !== "idle") {
    await stopAssistant();
    return;
  }
  state = "listening";
  buffer = new TranscriptBuffer();
  pending = null;
  log(`listening — deciding with ${currentDecider().name}`);
  // The HUD is non-focusable by design, so it can't receive a keydown —
  // a global registration held only for the session is the way to offer a
  // cancel key at all. Same reasoning as dictation's.
  releaseEscape = registerTemporaryHotkey("Escape", () => void cancelAssistant());
  // Re-checked each session: the user may have turned it on since.
  forgetBrowserAccess();
  told = false;
  await hud.openHud();
  hud.show({ state: "listening", heard: "" });
  // Warmed while the user is still drawing breath, not awaited.
  //
  // The *first* read of an app's menu bar is slow — measured at ~4.4s
  // against Finder cold, against ~60ms for every read after it, because
  // macOS populates the menus on first access. Paid here it overlaps the
  // second or two of speech that follows; paid inside consider() it would
  // be four seconds of silence after a finished command. This is still "on
  // demand": the user has just pressed ⌥A.
  void warmContext();
  try {
    await speech?.startListening();
  } catch (error) {
    await say({ ok: false, text: `Couldn't start listening: ${(error as Error).message}` });
    await stopAssistant();
  }
}

export async function stopAssistant(): Promise<void> {
  if (state === "idle") return;
  state = "idle";
  pending = null;
  act.clearQueue();
  clearIdleTimer();
  releaseEscape?.();
  releaseEscape = undefined;
  try {
    await speech?.stopListening();
  } catch {
    // Already stopped — nothing to do.
  }
  hud.closeHud();
}

/** Escape, at any point: while listening, while asking, while confirming. */
export async function cancelAssistant(): Promise<void> {
  if (state === "idle") return;
  if (pending) {
    // Escape declines the question but keeps the session — the user is
    // saying no to this, not goodbye.
    pending = null;
    buffer.clear();
    state = "listening";
    hud.show({ state: "listening", heard: "" });
    return;
  }
  await stopAssistant();
}

/**
 * A revised transcript from the recogniser. Today one whole utterance at a
 * time; with streaming partials (step 5) this is called continuously and
 * the buffer's stable prefix does the rest.
 */
export async function hear(text: string, final = false): Promise<void> {
  if (state === "idle") return;
  if (final) buffer.final(text);
  else buffer.update(text);
  hud.show({ state: "listening", heard: buffer.heard() });
  await consider();
}

/**
 * One finished utterance, from today's record-then-transcribe path.
 *
 * Listening restarts immediately afterwards, which is what makes one ⌥A
 * press hold a conversation rather than take one command: the user keeps
 * talking and each finished command clears itself out of the way. With
 * streaming partials (build step 5) the restart goes away — the microphone
 * simply never closes — and nothing above this changes.
 */
export async function onUtterance(text: string): Promise<void> {
  if (state === "idle") return;
  if (text.trim()) await hear(text, true);
  // Read through the getter: `state` is narrowed by the guard above, but
  // anything the command did — "stop", a handoff, an Escape — can genuinely
  // have ended the session across the await.
  if (assistantState() === "idle") return;
  try {
    await speech?.startListening();
  } catch (error) {
    await say({ ok: false, text: `Stopped listening: ${(error as Error).message}` });
    await stopAssistant();
  }
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

// Silence long enough after an incomplete phrase discards it rather than
// guessing at what it was going to be.
function armIdleTimer(): void {
  clearIdleTimer();
  const { holdMs } = readConfig().assistant;
  idleTimer = setTimeout(() => {
    if (state === "listening" && !buffer.empty) {
      buffer.clear();
      hud.show({ state: "listening", heard: "" });
    }
  }, holdMs);
}

async function consider(): Promise<void> {
  if (state !== "listening" && state !== "asking") return;
  const phrase = buffer.stablePrefix();
  if (!phrase) return;

  // A pending question owns whatever is said next: "yes", "the second one",
  // "no, the other one". Only once it's answered does the decider see the
  // buffer again.
  if (pending) {
    const answered = await answerPending(phrase);
    if (answered) return;
  }

  // Session verbs never reach the decider — "stop" must work even when the
  // decision service is down.
  const verb = sessionVerb(phrase);
  if (verb) {
    buffer.commit(phrase);
    await runSessionVerb(verb);
    return;
  }

  buffer.commit(phrase);
  await pursue({ goal: phrase, steps: [] });
}

/**
 * Perceive, decide, act — and then look again.
 *
 * The assistant pursues a goal rather than performing a command. Each turn
 * re-reads what is actually on screen, asks for one bounded next step, does
 * it, and goes round. Nothing is planned in advance, which is what makes it
 * robust: if a page loads differently or a click lands somewhere else, the
 * next turn simply sees that and decides again.
 *
 * It works because a batched judgement costs ~400 ms, so a two- or
 * three-step task finishes in well under two seconds. A planner would be
 * slower *and* more brittle.
 *
 * The goal lives here, in code. The decider is handed it fresh every turn
 * and never needs memory of its own.
 */
async function pursue(pursuit: Pursuit): Promise<void> {
  for (let step = 0; step < MAX_STEPS; step++) {
    if (assistantState() === "idle") return;

    state = "thinking";
    hud.show({ state: "thinking", heard: pursuit.goal });

    const started = Date.now();
    const ctx = await currentContext(pursuit.goal);
    if ("error" in ctx) {
      warn(`couldn't read where the user is: ${ctx.error}`);
      await say({ ok: false, text: ctx.error });
      state = "listening";
      return;
    }

    // Between steps, ask the cheap question first. It needs no candidates
    // and usually ends the loop, so reading the whole window to find out
    // would be most of the cost of a one-step command.
    if (pursuit.steps.length > 0) {
      const decider = currentDecider();
      const light: Situation = {
        utterance: pursuit.goal,
        goal: pursuit.goal,
        done: pursuit.steps,
        app: { name: ctx.app.name, bundleId: ctx.app.bundleId, windowTitle: ctx.app.windowTitle },
        candidates: {},
        mode: "command",
      };
      // A decider that can't judge progress says so by not implementing it,
      // and one step is all it was ever going to take.
      const over = decider.finished ? await decider.finished(light) : true;
      if (over) {
        await finish(pursuit);
        return;
      }
    }

    const gathering = Date.now();
    const candidates = await gatherCandidates(ctx);

    // Said once, the first time it matters: without the DOM the assistant
    // is reading a browser through a keyhole, and the fix is one switch in
    // the browser's own menu.
    const blocked = browserAccessBlocked();
    if (blocked && !told) {
      told = true;
      await say({ ok: false, text: blocked });
    }
    log(
      `step ${step + 1}: "${pursuit.goal}" in ${ctx.app.name} — candidates in ${Date.now() - gathering}ms: ` +
        Object.entries(candidates)
          .map(([intent, list]) => `${intent} ${list.length}`)
          .join(", ")
    );

    const situation: Situation = {
      utterance: pursuit.goal,
      goal: pursuit.goal,
      done: pursuit.steps,
      app: { name: ctx.app.name, bundleId: ctx.app.bundleId, windowTitle: ctx.app.windowTitle },
      candidates,
      mode: "command",
    };

    const deciding = Date.now();
    const decision = await currentDecider().decide(situation);
    log(`decided ${decision.kind} in ${Date.now() - deciding}ms (${Date.now() - started}ms total)`);

    if (decision.kind === "done") {
      await finish(pursuit);
      return;
    }

    if (decision.kind === "wait") {
      state = "listening";
      armIdleTimer();
      return;
    }

    if (decision.kind === "none") {
      // Nothing left to do is an ending, not a failure — but only if
      // something was actually done. Otherwise it wasn't a command.
      if (pursuit.steps.length > 0) await finish(pursuit);
      else await say({ ok: false, text: "I didn't hear anything to do." });
      state = "listening";
      return;
    }

    if (decision.kind === "escalate") {
      log(`escalating to Claude: nothing here claimed "${decision.prompt}"`);
      state = "acting";
      hud.show({ state: "acting", label: "Handing to Claude" });
      await say(await handOff(decision.prompt, ctx));
      state = "listening";
      return;
    }

    if (decision.kind === "ambiguous") {
      pending = { kind: "ambiguous", intent: decision.intent, among: decision.among, ctx, pursuit };
      state = "asking";
      hud.show(hud.ambiguityFor(decision.among));
      return;
    }

    const candidate = (candidates[decision.intent] ?? []).find((entry) => entry.id === decision.candidateId);
    if (!candidate) {
      // The decider named an id that isn't in the list it was given, which
      // means the two disagree about what was on offer — a resolver whose
      // candidates moved between the gather and the answer, most likely.
      warn(
        `${decision.intent} candidate "${decision.candidateId}" is gone — ` +
          `${(candidates[decision.intent] ?? []).length} were offered`
      );
      await say({ ok: false, text: "I understood that but couldn't find what it referred to." });
      state = "listening";
      return;
    }

    const outcome = await carryOut(
      decision.intent,
      candidate,
      ctx,
      decision.confidence,
      pursuit,
      decision.risky === true
    );
    // Anything but a completed step ends this turn: a question is waiting
    // for the user, and a failure is not something to step past.
    if (outcome !== "acted") return;
  }

  // A cap rather than a cleverer stopping rule. A loop that cannot finish
  // is the one failure mode here that could act on the user's machine
  // indefinitely, so it ends loudly and says how far it got.
  warn(`gave up on "${pursuit.goal}" after ${MAX_STEPS} steps`);
  await say({ ok: false, text: `Stopped after ${MAX_STEPS} steps: ${pursuit.steps.join(", ")}.` });
  state = "listening";
}

async function finish(pursuit: Pursuit): Promise<void> {
  log(`done: "${pursuit.goal}" in ${pursuit.steps.length} step(s)`);
  // One step already said what it did; saying it twice is noise.
  if (pursuit.steps.length > 1) {
    await say({ ok: true, text: `Done — ${pursuit.steps.join(", then ")}.` });
  }
  state = "listening";
}

type StepOutcome = "acted" | "asked" | "stopped";

async function carryOut(
  intent: IntentId,
  candidate: Candidate,
  ctx: Context,
  confidence: number,
  pursuit: Pursuit,
  risky = false
): Promise<StepOutcome> {
  if (candidate.unavailable) {
    // Reported honestly rather than attempted: a greyed-out command that
    // "succeeds" and does nothing is the worst possible answer.
    await say({ ok: false, text: `"${candidate.label}" isn't available right now.` });
    state = "listening";
    return "stopped";
  }

  const resolution = await resolve(intent, candidate, ctx);
  if (!resolution) {
    warn(`${intent} couldn't turn "${candidate.label}" into an action`);
    await say({ ok: false, text: `I couldn't work out how to "${candidate.label}".` });
    state = "listening";
    return "stopped";
  }

  // Choosing the same step twice running means the goal was already met by
  // the first one.
  //
  // This used to be reported as a failure — "didn't seem to change
  // anything" — which was both alarming and wrong: the click had worked,
  // the page had navigated, and the only thing that hadn't kept up was the
  // `finished` judgement, which sits at 0.41–0.53 immediately after a
  // click while the page is still settling. Re-deciding the same action is
  // the clearest possible evidence there is nothing left to do, so it ends
  // the pursuit as a success instead of shouting about it.
  if (pursuit.steps[pursuit.steps.length - 1] === resolution.label) {
    log(`"${resolution.label}" chosen again — treating the goal as met`);
    await finish(pursuit);
    return "stopped";
  }

  if (act.needsConfirmation(resolution, confidence, risky)) {
    // Which of the two reasons applied, because they have different
    // answers: a confidence floor is tuned, a risk is allowed.
    const floor = act.confirmThreshold(resolution.intent);
    const why =
      confidence < floor
        ? `confidence ${confidence.toFixed(2)} below ${resolution.intent}'s floor of ${floor}`
        : risky
          ? "the decider judged it destructive"
          : `${resolution.intent} is ${resolution.risk} and not on the allow list`;
    log(`asking before "${resolution.label}" — ${why}`);
    pending = { kind: "confirm", resolution, ctx, pursuit };
    state = "asking";
    hud.show(hud.confirmationFor(resolution));
    return "asked";
  }

  return runStep(resolution, pursuit);
}

/** Perform one step and record it, so the next turn knows it happened. */
async function runStep(resolution: Resolution, pursuit: Pursuit): Promise<StepOutcome> {
  state = "acting";
  hud.show({ state: "acting", label: resolution.label });
  const acting = Date.now();
  const performed = await act.perform(resolution);
  log(
    `${performed.outcome.ok ? "did" : "failed"} "${resolution.label}" in ${Date.now() - acting}ms` +
      (performed.outcome.ok ? "" : `: ${"text" in performed.outcome ? performed.outcome.text : ""}`)
  );
  if (!performed.outcome.ok) {
    await say(performed.outcome);
    state = "listening";
    return "stopped";
  }
  pursuit.steps.push(resolution.label);
  // Acknowledged without the usual pause: mid-task, the next step is
  // already being worked out and a 900 ms hold on every one of them is
  // most of what would make a three-step task feel slow.
  const said = "image" in performed.outcome ? "Took a screenshot." : performed.outcome.text;
  hud.show({ state: "said", message: firstLine(said), ok: true });
  return "acted";
}

// ---------------------------------------------------------------------------
// Answering a question
// ---------------------------------------------------------------------------

const YES = /^(yes|yeah|yep|ok|okay|sure|do it|go ahead|confirm)\b/i;
const NO = /^(no|nope|don'?t|cancel|never ?mind|forget it)\b/i;
const ALWAYS = /^(always|always allow)\b/i;
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

async function answerPending(phrase: string): Promise<boolean> {
  const current = pending;
  if (!current) return false;

  if (current.kind === "confirm") {
    if (ALWAYS.test(phrase) || YES.test(phrase)) {
      buffer.commit(phrase);
      if (ALWAYS.test(phrase)) act.alwaysAllow(current.resolution);
      pending = null;
      // Perform it and then carry on with the same goal, rather than
      // ending here: a question asked halfway through a multi-step task
      // must not cost the rest of the task.
      const outcome = await runStep(current.resolution, current.pursuit);
      if (outcome === "acted") await pursue(current.pursuit);
      return true;
    }
    if (NO.test(phrase)) {
      buffer.commit(phrase);
      pending = null;
      state = "listening";
      await say({ ok: true, text: `Left "${current.resolution.label}" alone.` });
      return true;
    }
    // Anything else is a new command, not an answer. Silence is never
    // treated as agreement, and neither is a change of subject.
    pending = null;
    return false;
  }

  // An ambiguity: "the second one", "the one in the toolbar", or the
  // label itself. Never requires the mouse.
  const chosen = pickAmong(phrase, current.among);
  if (!chosen) {
    if (NO.test(phrase)) {
      buffer.commit(phrase);
      pending = null;
      state = "listening";
      await say({ ok: true, text: "Dropped it." });
      return true;
    }
    pending = null;
    return false;
  }
  buffer.commit(phrase);
  const { intent, ctx, pursuit } = current;
  pending = null;
  // Confidence 1: the user has just said which one by hand, which is a
  // better answer than any classifier's.
  const outcome = await carryOut(intent, chosen, ctx, 1, pursuit);
  if (outcome === "acted") await pursue(pursuit);
  return true;
}

function pickAmong(phrase: string, among: Candidate[]): Candidate | null {
  const said = phrase.toLowerCase();
  for (let index = 0; index < ORDINALS.length && index < among.length; index++) {
    if (said.includes(ORDINALS[index])) return among[index];
  }
  const numeric = said.match(/\b([1-9])\b/);
  if (numeric) {
    const candidate = among[Number(numeric[1]) - 1];
    if (candidate) return candidate;
  }
  return (
    among.find((candidate) => said.includes(candidate.label.toLowerCase())) ??
    among.find((candidate) => candidate.detail && said.includes(candidate.detail.toLowerCase())) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Session verbs
// ---------------------------------------------------------------------------

type SessionVerb = "stop" | "undo" | "cancel" | "repeat";

function sessionVerb(phrase: string): SessionVerb | null {
  const said = phrase.trim().toLowerCase();
  if (/^(stop|that'?s it|never ?mind|we'?re done|thanks,? clance)\b/.test(said)) return "stop";
  if (/^(undo|undo that|take that back)\b/.test(said)) return "undo";
  if (/^cancel\b/.test(said)) return "cancel";
  if (/^(again|repeat|do that again)\b/.test(said)) return "repeat";
  return null;
}

async function runSessionVerb(verb: SessionVerb): Promise<void> {
  switch (verb) {
    case "stop":
      await stopAssistant();
      return;
    case "undo":
      await say(await act.undoLast());
      state = "listening";
      return;
    case "cancel":
      act.clearQueue();
      pending = null;
      state = "listening";
      await say({ ok: true, text: "Cancelled." });
      return;
    case "repeat": {
      const last = act.lastAction();
      if (!last) {
        await say({ ok: false, text: "There's nothing to repeat." });
        state = "listening";
        return;
      }
      await runStep(last.resolution, { goal: last.resolution.label, steps: [] });
      state = "listening";
      return;
    }
  }
}

// Every action produces a visible acknowledgement — what was done, to what.
// "Nothing happened" is never an acceptable outcome (docs/assistant.md).
async function say(outcome: Outcome): Promise<void> {
  // A dictate-into command runs a whole dictation mid-session, and
  // dictation puts the HUD away when it's done.
  await hud.ensureVisible();
  const message = "image" in outcome ? "Took a screenshot." : outcome.text;
  hud.show({ state: "said", message: firstLine(message), ok: outcome.ok });
  // Held briefly so an acknowledgement is readable, then back to listening
  // — the session doesn't end because one command finished.
  await new Promise((done) => setTimeout(done, 900));
  if (state !== "idle" && !pending) hud.show({ state: "listening", heard: buffer.heard() });
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}
