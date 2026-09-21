import { choice, noul, TypeSafeClient, type ChoiceCriteria, type ChoiceQuestion } from "@typesafe-ai/sdk";
import type { Candidate, Decider, Decision, IntentId, Situation } from "../types";
import { INTENT_IDS } from "../types";
import { apiFailure, log, warn } from "../log";
import { MODEL, T } from "../thresholds";

// Deciding with Jev (TypeSafe AI's System One).
//
// Jev doesn't write text — it answers typed questions with probabilities,
// which is exactly and only what this needs. The assistant never shows a
// model's prose to the user; it classifies a phrase into something Clance
// already knows how to do. A model that *can't* write is a stronger
// guarantee of that than a prompt asking one not to.
//
// The whole decision is one round trip. Jev prices a batch of questions at
// roughly the cost of one — they're evaluated in parallel — so the intent
// question and the target question for the two or three likeliest intents
// all go in the same call. That's TypeSafe's own "speculative fan-out"
// pattern: ask everything the decision tree might need, and let code ignore
// the answers it turns out not to want.

/**
 * How many candidates one question may offer.
 *
 * The API's ceiling on a `choice` is 255, but latency grows with tokens
 * long before that and accuracy falls off with a wall of near-identical
 * options. A hundred is what working implementations of this task use.
 *
 * Note what this is *not*: a licence to quietly drop candidates. "Omit
 * candidate values that the model cannot choose" is on TypeSafe's list of
 * things not to do — a target that was never offered is indistinguishable,
 * from the answer, from one that was offered and rejected. Lists longer
 * than this are split into a hierarchy instead (see `menuGroups`).
 */
const MAX_CANDIDATES = 100;

/**
 * How many candidates the whole request may describe, across every question.
 *
 * The per-question cap is not enough on its own: a dozen questions each
 * comfortably under it still produced a 219-line, 10 kB element table for
 * "quit Discord", most of it the Apple menu's Recent Items and every
 * installed app. State size costs latency directly and accuracy indirectly
 * — irrelevant detail is a documented way to pull a judgement around.
 *
 * When the budget runs out, whole questions are dropped rather than lists
 * truncated, so every question that *is* asked offers a complete set and a
 * missing answer means "not asked" rather than "silently unavailable".
 *
 * Set from what it actually starved: at 120, a busy page's `target` list
 * (81–135 controls) never fit, so the intent most likely to be right when
 * someone is looking at a web page was the one always dropped — and every
 * "click the …" paid for a second round trip to ask what should have been
 * in the first.
 */
const MAX_ELEMENTS_TOTAL = 190;

/**
 * The no-match outcome, on every question that has candidates.
 *
 * "Include an 'other' or 'none of the above' option when the input might
 * fall outside your list" — and here it always might: the user can name an
 * app that isn't installed or a button that isn't on screen. Without this
 * the question is a forced choice and the model must name *something*,
 * which is how "quit Discord" becomes a press of whatever was nearest.
 */
const NONE = "None of these";

/**
 * A candidate list this short is nearly free to ask about, so it always
 * rides along rather than competing for a speculation slot.
 *
 * Measured from live traffic: `text` has four candidates and was twice
 * ranked out of the fan-out by word overlap — "Search for John Stewart",
 * "Type." — each time costing a second round trip of 330–480 ms to ask a
 * four-option question. Meanwhile `menu_in:Apple`, sixty-one options of
 * Recent Items, was sent five times and used never. Speculating by
 * relevance alone optimises the wrong thing: what matters is what a miss
 * costs against what including it costs, and for a short list the second
 * number is almost zero.
 *
 * Thirty rather than fifteen so `site` — twenty-odd well-known websites
 * plus any domain actually spoken — always rides along. It is the answer
 * to "open YouTube", which otherwise searched seventy-nine installed apps,
 * found nothing, and handed the whole thing to Claude.
 */
const CHEAP_CANDIDATES = 30;

/**
 * How many *large* candidate lists ride along, menu included.
 *
 * The big lists — every installed app, every control on screen, the menu
 * bar — are where the tokens are, so these are the slots worth rationing.
 */
const WIDE_SPECULATION = 2;

/**
 * How long a decision gets before the local decider takes over, and why it
 * never retries.
 *
 * The SDK's defaults are built for a request worth waiting for: two
 * retries, exponential backoff, timeouts and connection errors both
 * retried. Against an unreachable Jev that is three 4s attempts plus
 * backoff — measured at **13.4 seconds** — before falling back to a decider
 * that answers in under a millisecond. For a classifier the user is waiting
 * on mid-sentence, retrying is strictly worse than falling back: the
 * fallback is free, instant and already correct for the common phrasings.
 *
 * So: no retries, and a ceiling comfortably above Jev's published range
 * (70–500 ms) but far below the point a person notices a pause. A rate
 * limit or a blip costs one local answer, not a stalled assistant.
 */
const DECIDE_TIMEOUT_MS = 1500;
const NO_RETRIES = { maxRetries: 0 } as const;

/**
 * A long window title is a distractor, not context.
 *
 * "Large state with irrelevant detail" is a documented failure mode:
 * unrelated text in the state pulls the answer around. A browser tab title
 * routinely runs to a hundred characters of site name, section and
 * "Audio playing", none of which helps decide what the user just said.
 */
const MAX_TITLE = 80;

/**
 * What each intent means, as `what`/`not_for` pairs.
 *
 * Structured rather than a sentence because these options genuinely risk
 * being confused with each other — launch against switch, menu against
 * target — and TypeSafe's guidance is to move to objects with `what` and
 * `not_for` exactly when that's true. The model reads the option names as
 * well as the descriptions, so both are written to separate the options
 * rather than to describe them in isolation.
 */
const INTENT_CRITERIA: Record<IntentId, { what: string; not_for: string }> = {
  launch: {
    what: "Open or start an application installed on this Mac, whether or not it is running.",
    not_for:
      "Opening a website such as YouTube or GitHub — that is site. Moving to an app that is " +
      "already open — that is switch.",
  },
  site: {
    what: "Open a website, by its name or by a web address the user spoke out loud.",
    not_for:
      "Searching the web for a topic — that is search. Opening an application installed on the " +
      "Mac — that is launch.",
  },
  switch: {
    what: "Bring an application that is already running to the front.",
    not_for: "Starting one that is not running — that is launch.",
  },
  quit: {
    what: "Close or quit an entire application.",
    not_for: "Closing one window, tab or document — that is a menu command.",
  },
  menu: {
    what:
      "Run a command the app in front offers in its own menus: save, new note, close tab, " +
      "export, undo, preferences.",
    not_for: "Pressing a button or link inside the window — that is target.",
  },
  navigate: {
    what: "Move around inside what is on screen: scroll, page up or down, jump to top or bottom, go back, change tab.",
    not_for: "Moving the window itself — that is window.",
  },
  window: {
    what: "Move, resize or arrange the window that is in front, such as to one half of the screen.",
    not_for: "Scrolling the contents — that is navigate.",
  },
  target: {
    what: "Press, click or focus a specific named control on screen: a button, a link, a text field.",
    not_for: "A command from the app's menu bar — that is menu.",
  },
  search: {
    what: "Search the web for something the user named out loud, in the browser.",
    not_for: "Searching within the page or document in front — that is find.",
  },
  find: {
    what: "Look for something the user named out loud within the page or document in front.",
    not_for: "Searching the whole web — that is search.",
  },
  type: {
    what: "Write words the user said out loud into whatever field is focused.",
    not_for:
      "Starting dictation so the user can speak the words afterwards — that is text. Use this " +
      "only when the words to write are already part of what they just said.",
  },
  text: {
    what:
      "Hand the microphone over so the user can dictate, now or into a field they named. The " +
      "words have not been said yet.",
    not_for:
      "Writing words that are already part of what they just said — that is type.",
  },
  clance: {
    what: "Something about Clance itself: its Claude Code sessions, its settings, its dictation history.",
    not_for: "Anything about the app the user is currently in.",
  },
  claude: {
    what:
      "Anything needing reasoning, reading, writing, explaining or judgement, which is handed to a " +
      "Claude Code session rather than performed.",
    not_for: "A direct command that one of the other intents already covers.",
  },
};

type Labelled = { label: string; candidate: Candidate };

/**
 * Candidates become short ids, and their text goes in the state.
 *
 * The obvious encoding — the label as the option key, the detail as its
 * description — sends every candidate's words *twice* and makes two
 * controls called "Send" impossible to tell apart. Instead each candidate
 * gets an id, the options are bare ids with no description, and one shared
 * table in the state says what each id is:
 *
 *     e12  menu  "New Tab" · File > New Tab
 *     e13  link  "Jon Stewart - Wikipedia"  [scrolled out of view]
 *
 * The table is written once however many questions reference it, which is
 * where most of the saving comes from. It's TypeSafe's semantic-find
 * shape: describe the corpus in state, choose over handles.
 */
type Element = { id: string; line: string; intent: IntentId; candidate: Candidate };

function encode(id: string, intent: IntentId, candidate: Candidate): string {
  let line = `${id} ${intent} "${candidate.label}"`;
  if (candidate.detail && candidate.detail !== candidate.label) line += ` · ${candidate.detail}`;
  if (candidate.unavailable) line += " [unavailable]";
  return line;
}

function criteriaFor(elements: Element[], noMatch: string): ChoiceCriteria {
  const criteria: ChoiceCriteria = {};
  // Deliberately null: the description would be a second copy of the line
  // already in `state.elements`, and Jev reads both.
  for (const element of elements) criteria[element.id] = null;
  criteria[NONE] = noMatch;
  return criteria;
}

// Words shared with the utterance, as a crude ordering for speculation.
function relevance(utterance: string, candidate: Candidate): number {
  const words = new Set(utterance.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const target = `${candidate.label} ${candidate.detail ?? ""}`.toLowerCase();
  let shared = 0;
  for (const word of words) if (word.length > 2 && target.includes(word)) shared++;
  return shared;
}

/**
 * The top-level menu a command lives under — "File", "Edit", "View".
 *
 * A menu bar is already a tree and `detail` carries its path, so grouping
 * by the first segment costs nothing and turns one impossible question into
 * two easy ones.
 */
function menuGroupOf(candidate: Candidate): string {
  const first = (candidate.detail ?? "").split(" > ")[0].trim();
  return first || "Other";
}

function groupMenu(candidates: Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = menuGroupOf(candidate);
    const existing = groups.get(group);
    if (existing) existing.push(candidate);
    else groups.set(group, [candidate]);
  }
  return groups;
}

/**
 * Which intents get a target question in the same call as the intent one.
 *
 * Every cheap list, unconditionally, plus the most relevant of the
 * expensive ones. Asking is the point of speculative fan-out — the
 * questions run in parallel and a miss costs a whole extra round trip —
 * but tokens are real, so the rationing happens where the tokens are.
 */
function speculate(situation: Situation): IntentId[] {
  const available = INTENT_IDS.filter((intent) => (situation.candidates[intent] ?? []).length > 0);
  const cheap = available.filter(
    (intent) => (situation.candidates[intent] ?? []).length <= CHEAP_CANDIDATES
  );
  const wide = available
    .filter((intent) => (situation.candidates[intent] ?? []).length > CHEAP_CANDIDATES)
    .map((intent) => ({
      intent,
      size: (situation.candidates[intent] ?? []).length,
      score: (situation.candidates[intent] ?? []).reduce(
        (best, candidate) => Math.max(best, relevance(situation.utterance, candidate)),
        0
      ),
    }))
    // On a tie — which is every phrase that shares no word with any large
    // list — prefer the smaller one. Without a tiebreak the sort is stable
    // and falls back to declaration order, which quietly meant `launch`
    // (every installed app) always beat `target` (the controls actually on
    // screen) for a phrase like "click Send". Asking the smaller question
    // is both cheaper and likelier: a command spoken at an app is more
    // often about what is in front of the user than about the whole Mac.
    .sort((a, b) => b.score - a.score || a.size - b.size)
    .map((entry) => entry.intent);

  const picked = wide.slice(0, WIDE_SPECULATION);
  // The frontmost app's menu is the likeliest thing an uncued phrase means,
  // so it takes one of the wide slots whether or not it scored.
  if (!picked.includes("menu") && (situation.candidates.menu ?? []).length > 0) {
    picked[Math.max(0, picked.length - 1)] = "menu";
  }
  // Cheap lists first, then the wide ones with whatever is left.
  //
  // The budget is spent in this order, and it has been wrong in both
  // directions. Cheap-first with no cap on `target` starved the page's own
  // controls, so every "click the …" paid a second round trip. Wide-first
  // starved the opposite end — scroll, window, Clance's own verbs, one to
  // ten candidates each — because `launch` and `menu` between them ate the
  // lot. The cheap lists total under sixty elements and answer most of what
  // anyone says, so they are never the ones to drop; `target` is bounded
  // at its own end instead (see intents/target.ts).
  return [...cheap, ...picked];
}

/**
 * One answer, as a log line: what was chosen, how much of the distribution
 * it took, how concentrated that distribution was, and what came next.
 *
 * `p` and `conf` are deliberately both shown and both labelled, because
 * they are different scales and printing one beside the other unlabelled
 * is actively misleading — a run of this log read `"Dictate into Address
 * and search bar" (0.17) [then Dictate here 0.23]`, which looks like the
 * model picked a less likely option and in fact was confidence sitting
 * next to probabilities.
 *
 * The runners-up matter for the same reason the chosen probability does:
 * a wrong answer that was a close call and one that was nowhere near need
 * opposite fixes — better candidate labels, or a better question.
 */
function describeAnswer(
  answer: { choice: string; confidence: number; probabilities: Record<string, number> }
): string {
  const chosen = answer.probabilities[answer.choice] ?? 0;
  const rest = Object.entries(answer.probabilities)
    .filter(([label]) => label !== answer.choice)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .filter(([, probability]) => probability > 0.01);
  const then =
    rest.length > 0
      ? ` [then ${rest.map(([label, probability]) => `${label} p=${probability.toFixed(2)}`).join(", ")}]`
      : "";
  return `p=${chosen.toFixed(2)} conf=${answer.confidence.toFixed(2)}${then}`;
}

/**
 * How sure the "is it finished" judgement has to be to stop the loop.
 *
 * A noul is a probability of yes with no separate confidence, so this is
 * read directly. Deliberately above a half: stopping early leaves the user
 * with a job half done and no notice, while one extra step is visible,
 * cheap and usually harmless.
 */
const FINISHED_ABOVE = 0.7;

export type Ask = {
  questions: Record<string, ChoiceQuestion | ReturnType<typeof noul>>;
  /** Every id offered anywhere in this request, and what it refers to. */
  elements: Map<string, Element>;
  intents: IntentId[];
  /** Present when the menu was too big for one question. */
  menuGroups?: Map<string, Candidate[]>;
  state: Record<string, string | string[]>;
};

/**
 * Everything that goes over the wire, built separately from sending it so
 * it can be inspected and checked against the API's limits without a key.
 */
export function buildAsk(situation: Situation): Ask {
  const utterance = situation.utterance.trim();
  const intents = speculate(situation);
  const elements = new Map<string, Element>();
  const lines: string[] = [];
  let next = 1;

  // Every candidate offered anywhere in this request gets one id and one
  // line, written once into the shared table whatever questions refer to it.
  const enrol = (intent: IntentId, candidates: Candidate[]): Element[] | null => {
    // All of it or none of it: a half-offered list is worse than an
    // unasked question, because the answer can't tell you which it was.
    const wanted = Math.min(candidates.length, MAX_CANDIDATES);
    if (elements.size + wanted > MAX_ELEMENTS_TOTAL) return null;
    const enrolled: Element[] = [];
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      if (!candidate.label.trim()) continue;
      const id = `e${next++}`;
      const element = { id, line: encode(id, intent, candidate), intent, candidate };
      elements.set(id, element);
      lines.push(element.line);
      enrolled.push(element);
    }
    return enrolled;
  };

  const continuing = situation.done.length > 0;
  const questions: Record<string, ChoiceQuestion | ReturnType<typeof noul>> = {};

  // Is the user talking to Clance at all? Separate from what they want,
  // because a phrase can be a perfectly clear sentence and not be addressed
  // here — and "none of the intents fit" is a different thing from "you
  // weren't talking to me".
  questions.is_command = noul(
    "`utterance` was picked up while the user had the assistant listening. Are they telling the " +
      "computer to do something, rather than talking to someone else or thinking aloud?",
    {
      true: "An instruction addressed to the computer.",
      false: "Conversation, thinking aloud, or a false start.",
    }
  );

  // Would carrying this out destroy, send or spend something? Only ever
  // *raises* risk — an intent's own classification is the floor and this
  // cannot lower it (see act/actuator.ts).
  questions.destructive = noul(
    "If the computer carried out `utterance` on the screen described by `app`, would that delete " +
      "something, send something, spend money, or otherwise be hard to undo?",
    {
      true: "Destructive, irreversible, or sends something to someone.",
      false: "Reversible, or affects only what is displayed.",
    }
  );

  questions.intent = choice(
    continuing
      ? "`goal` is what the user asked for and `done` is what has already been carried out " +
          "towards it. What kind of thing is the *next* step?"
      : "`utterance` is a command the user spoke to their Mac, which is showing `app`. " +
          "What kind of thing are they asking for?",
    {
      ...Object.fromEntries(INTENT_IDS.map((id) => [id, INTENT_CRITERIA[id]])),
      [NONE]: continuing
        ? "No further step is needed, or none of these would help."
        : "Filler, a false start, or nothing that asks for anything to happen.",
    }
  );

  let menuGroups: Map<string, Candidate[]> | undefined;

  for (const intent of intents) {
    const candidates = situation.candidates[intent] ?? [];
    if (candidates.length === 0) continue;

    // A menu bar that doesn't fit one question is asked as the tree it
    // already is: which menu, then which command in it. Every command stays
    // reachable, which truncating the flat list would not have managed.
    if (intent === "menu" && candidates.length > MAX_CANDIDATES) {
      menuGroups = groupMenu(candidates);
      const groups = enrol(
        "menu",
        [...menuGroups].map(([group, items]) => ({
          id: group,
          label: group,
          detail: `${items.length} commands, including ${items.slice(0, 4).map((item) => item.label).join(", ")}`,
        }))
      );
      if (!groups) continue;
      questions.menu_group = choice(
        "If `utterance` is one of `app`'s own menu commands, which of its menus is that command in? " +
          "The options are ids from `elements`.",
        criteriaFor(groups, "The command is not in any of these menus.")
      );

      // Then the commands themselves, for the menus most likely to hold
      // them — speculative, the same way the intents are. Only menus the
      // phrase actually touches: with no filter, a tie at zero falls back
      // to insertion order and the Apple menu wins every time.
      const ranked = [...menuGroups.entries()]
        .map(([group, items]) => ({
          group,
          items,
          score: items.reduce((best, item) => Math.max(best, relevance(utterance, item)), 0),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        // One menu, not two. The second was nearly always the Apple menu's
        // Recent Items — sixty-odd lines of recently opened files that no
        // spoken command has ever meant — riding along because a filename
        // happened to share a word with the phrase.
        .slice(0, 1);
      for (const { group, items } of ranked) {
        const within = enrol("menu", items);
        if (!within) continue;
        questions[`menu_in:${group}`] = choice(
          `If \`utterance\` named a command in ${situation.app.name}'s ${group} menu, which one? ` +
            "The options are ids from `elements`.",
          criteriaFor(within, `No command in the ${group} menu matches.`)
        );
      }
      continue;
    }

    const offered = enrol(intent, candidates);
    if (!offered) {
      log(`no room to ask about ${intent} (${candidates.length} candidates) — skipped`);
      continue;
    }
    questions[`target_${intent}`] = choice(
      `${targetQuestion(intent)} The options are ids from \`elements\`.`,
      criteriaFor(offered, "The user named something that is not in this list.")
    );
  }

  return {
    questions,
    elements,
    intents,
    menuGroups,
    // Only what bears on the decision. Jev reads instructions literally and
    // is pulled around by irrelevant detail, so nothing else goes in.
    state: {
      utterance,
      goal: situation.goal,
      // Only the steps, never their results: what a step *did* is on the
      // screen already, and repeating it here is the irrelevant detail
      // that pulls a judgement around.
      done: situation.done,
      app: situation.app.name,
      window: situation.app.windowTitle.slice(0, MAX_TITLE),
      // One line per candidate, referenced by every question above.
      elements: lines,
    },
  };
}

/**
 * The question asked about one intent's candidates.
 *
 * Three rules, all from TypeSafe's guidance. Plain language rather than
 * Clance's intent ids, because a literal reader doesn't know the jargon.
 * The speculative premise stated outright — "if the user is asking to …" —
 * because these questions are all asked at once and most of them are about
 * a premise that turns out to be false. And the state referenced by name in
 * backticks, since a question ID is never sent to the model and the
 * question has to carry its whole meaning on its own.
 */
function targetQuestion(intent: IntentId): string {
  switch (intent) {
    case "launch":
      return "If `utterance` is asking to open an application, which one?";
    case "switch":
      return "If `utterance` is asking to move to an application already running, which one?";
    case "quit":
      return "If `utterance` is asking to quit an application, which one?";
    case "menu":
      return "If `utterance` named one of `app`'s own menu commands, which one?";
    case "navigate":
      return "If `utterance` is asking to move around what is on screen, which movement?";
    case "window":
      return "If `utterance` is asking to move or resize the window, where should it go?";
    case "target":
      return "If `utterance` named a control on screen, which one?";
    case "site":
      return "If `utterance` is asking to open a website, which one?";
    case "search":
      return "If `utterance` is asking to search the web, which part of it is the thing to search for?";
    case "find":
      return "If `utterance` is asking to find something on this page, which part of it is being looked for?";
    case "type":
      return "If `utterance` is asking to write something down, which part of it are the words to write?";
    case "text":
      return "If `utterance` is asking to start dictating, where should the words go?";
    case "clance":
      return "If `utterance` is asking for something from Clance itself, which?";
    case "claude":
      return "If `utterance` is asking for something that needs thinking, which?";
  }
}

type Answer = { type: string; choice: string; confidence: number; probabilities: Record<string, number> };

export class JevDecider implements Decider {
  readonly name = "Jev";
  private client: TypeSafeClient;
  private fallback: Decider;

  constructor(client: TypeSafeClient, fallback: Decider) {
    this.client = client;
    this.fallback = fallback;
  }

  async decide(situation: Situation): Promise<Decision> {
    const utterance = situation.utterance.trim();
    if (!utterance) return { kind: "wait" };

    const ask = buildAsk(situation);
    if (ask.elements.size === 0) {
      warn(`nothing to ask about "${utterance}" — no intent had any candidates`);
      return { kind: "escalate", prompt: utterance };
    }

    log(
      `asking about "${utterance}" in ${situation.app.name} — ` +
        `${Object.keys(ask.questions).length} questions, ${ask.elements.size} elements`
    );

    const started = Date.now();
    let answers: Record<string, Answer>;
    try {
      const result = await this.client.systemOne(
        { state: ask.state, questions: ask.questions, model: MODEL },
        { timeout: DECIDE_TIMEOUT_MS, retry: NO_RETRIES }
      );
      answers = result.answers as unknown as Record<string, Answer>;
      log(
        `answered in ${Date.now() - started}ms ` +
          `(${result.usage.input_tokens} in, ${result.usage.output_tokens} out, ${result.model})`
      );
    } catch (error) {
      // Unreachable, rate-limited, timed out: degrade to what can be
      // worked out locally rather than losing the command.
      apiFailure(`decide failed after ${Date.now() - started}ms, falling back to local matching`, error);
      return this.fallback.decide(situation);
    }

    // Were they even talking to us? Asked first, because a clear sentence
    // addressed to somebody else is not a low-confidence command — it is
    // not a command, and acting on it at any confidence is the worst thing
    // this can do.
    const addressed = readNoul(answers.is_command);
    if (addressed !== undefined) {
      log(`addressed to Clance? ${addressed.toFixed(2)}`);
      if (addressed < T.isCommand) return { kind: "none" };
    }

    const intentAnswer = answers.intent;
    if (!intentAnswer || intentAnswer.type !== "choice") {
      warn(`intent came back as ${intentAnswer?.type ?? "nothing"}, not a choice — falling back`);
      return this.fallback.decide(situation);
    }
    const intent = intentAnswer.choice;
    log(`intent: ${intent} ${describeAnswer(intentAnswer)}`);
    if (intent === NONE) return { kind: "none" };
    if (intent === "claude") return { kind: "escalate", prompt: utterance };
    if (intentAnswer.confidence < T.intent) {
      log(`intent confidence ${intentAnswer.confidence.toFixed(2)} below ${T.intent} — escalating`);
      return { kind: "escalate", prompt: utterance };
    }

    // Only ever raises risk. An intent's own classification is the floor.
    const destructive = readNoul(answers.destructive);
    if (destructive !== undefined) log(`destructive? ${destructive.toFixed(2)}`);
    const risky = (destructive ?? 0) >= T.destructive;

    if (intent === "menu" && ask.menuGroups) {
      return this.resolveMenu(ask, answers, situation, intentAnswer.confidence, risky);
    }

    const targetAnswer = answers[`target_${intent}`];
    if (!targetAnswer || targetAnswer.type !== "choice") {
      log(`speculation missed — ${intent} wasn't one of ${ask.intents.join(", ")}; asking again`);
      return this.askTarget(
        intent as IntentId,
        situation.candidates[intent] ?? [],
        situation,
        intentAnswer.confidence,
        risky
      );
    }
    return this.interpret(intent as IntentId, ask, targetAnswer, intentAnswer.confidence, utterance, risky);
  }

  /**
   * One noul, no candidates, ~300 tokens: has the goal been reached?
   *
   * Asked before the screen is read at all, because the answer is usually
   * yes and reading the screen to find out is the expensive part.
   */
  async finished(situation: Situation): Promise<boolean> {
    const started = Date.now();
    try {
      const { answers } = await this.client.systemOne(
        {
          state: {
            goal: situation.goal,
            done: situation.done,
            app: situation.app.name,
            window: situation.app.windowTitle.slice(0, MAX_TITLE),
          },
          questions: {
            finished: noul(
              "`goal` is what the user asked their computer for, and `done` is what has already " +
                "been carried out towards it on the screen described by `app`. Has the goal now " +
                "been reached?",
              {
                true: "Everything the user asked for has been done.",
                false: "At least one more step is still needed.",
              }
            ),
          },
          model: MODEL,
        },
        { timeout: DECIDE_TIMEOUT_MS, retry: NO_RETRIES }
      );
      const value = readNoul(answers.finished) ?? 0;
      log(`finished? ${value.toFixed(2)} (${Date.now() - started}ms)`);
      return value >= FINISHED_ABOVE;
    } catch (error) {
      // Can't tell: carry on and let the next decide sort it out, which is
      // bounded by the step cap either way.
      apiFailure(`finished check failed after ${Date.now() - started}ms`, error);
      return false;
    }
  }

  // The menu came back as two questions: which menu, then which command.
  private async resolveMenu(
    ask: Ask,
    answers: Record<string, Answer>,
    situation: Situation,
    intentConfidence: number,
    risky: boolean
  ): Promise<Decision> {
    const groupAnswer = answers.menu_group;
    if (!groupAnswer || groupAnswer.type !== "choice") {
      warn("the menu question came back without a menu — escalating");
      return { kind: "escalate", prompt: situation.utterance };
    }
    if (groupAnswer.choice === NONE) {
      log("no menu holds what was said — escalating");
      return { kind: "escalate", prompt: situation.utterance };
    }
    const group = ask.elements.get(groupAnswer.choice)?.candidate.label ?? groupAnswer.choice;
    log(`menu: ${group} ${describeAnswer(groupAnswer)}`);

    const commandAnswer = answers[`menu_in:${group}`];
    if (!commandAnswer || commandAnswer.type !== "choice") {
      // The speculation picked the wrong menus. One more call, over just
      // the commands in the menu it actually named.
      //
      // Note the confidence handed on is the *intent's*, not the group's:
      // which menu an app files a command under is Clance's own taxonomy
      // leaking in, and the user never said it. Letting uncertainty about
      // it veto a confident command match is what turned "close tab" —
      // command matched at 0.76 — into a confirmation at 0.34.
      log(`menu speculation missed ${group}; asking again`);
      return this.askTarget("menu", ask.menuGroups?.get(group) ?? [], situation, intentConfidence, risky);
    }
    return this.interpret("menu", ask, commandAnswer, intentConfidence, situation.utterance, risky);
  }

  // Shared by every path that has an answer and a table to read it against.
  private interpret(
    intent: IntentId,
    ask: Ask,
    answer: Answer,
    priorConfidence: number,
    utterance: string,
    risky: boolean
  ): Decision {
    if (answer.choice === NONE) {
      // The question offered a way to say "not here", and it was taken.
      // That is a real answer, and a much better one than the nearest label.
      log(`nothing in ${intent} matched — escalating`);
      return { kind: "escalate", prompt: utterance };
    }

    const chosen = ask.elements.get(answer.choice);
    if (!chosen) {
      warn(`chose "${answer.choice}", which wasn't offered for ${intent} — escalating`);
      return { kind: "escalate", prompt: utterance };
    }

    const topProb = answer.probabilities[answer.choice] ?? 0;
    log(`target: "${chosen.candidate.label}" ${describeAnswer(answer)}`);

    // The signature worth naming: the intent landed but the target didn't,
    // with the no-match outcome close behind. That is not the model being
    // unsure what the user meant — it is the model saying the right option
    // was never offered, which is a gap in the skill list rather than a
    // tuning problem, and the two have opposite fixes.
    if (priorConfidence >= 0.85 && answer.confidence < 0.5 && (answer.probabilities[NONE] ?? 0) >= 0.15) {
      warn(
        `${intent} was certain but no candidate fitted — best "${chosen.candidate.label}" ` +
          `p=${topProb.toFixed(2)}, none p=${(answer.probabilities[NONE] ?? 0).toFixed(2)}. Missing skill?`
      );
    }

    // Not confident enough to press one, but several look plausible: that
    // is a question, not a failure. Asking "which one?" over the top few is
    // a better outcome than either guessing or giving up, and it is where
    // low confidence stops being a dead end.
    if (answer.confidence < T.target || topProb < T.targetTopProb) {
      const among = Object.entries(answer.probabilities)
        .filter(([id]) => id !== NONE && ask.elements.has(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, T.candidateCount)
        .filter(([, probability]) => probability >= 0.05)
        .map(([id]) => ask.elements.get(id)!.candidate);
      if (among.length > 1) {
        log(`ambiguous (conf ${answer.confidence.toFixed(2)}, top p=${topProb.toFixed(2)}) — asking which`);
        return { kind: "ambiguous", intent, among };
      }
      log(`nothing plausible enough in ${intent} — escalating`);
      return { kind: "escalate", prompt: utterance };
    }

    // Both questions have to land for the action to be worth performing, so
    // the confidence the risk gate reads is the weaker of the two — the
    // same rule TypeSafe's own function-calling cookbook uses, since one
    // wrong half is enough to spoil the result.
    const confidence = Math.min(priorConfidence, answer.confidence);
    return { kind: "resolved", intent, candidateId: chosen.candidate.id, confidence, risky };
  }

  // The second round trip, paid only when the fan-out guessed wrong. Rare,
  // and still inside budget.
  private async askTarget(
    intent: IntentId,
    candidates: Candidate[],
    situation: Situation,
    priorConfidence: number,
    risky: boolean
  ): Promise<Decision> {
    if (candidates.length === 0) {
      warn(`${intent} had no candidates to choose from — escalating`);
      return { kind: "escalate", prompt: situation.utterance };
    }
    const elements = new Map<string, Element>();
    const lines: string[] = [];
    let next = 1;
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      if (!candidate.label.trim()) continue;
      const id = `e${next++}`;
      const element = { id, line: encode(id, intent, candidate), intent, candidate };
      elements.set(id, element);
      lines.push(element.line);
    }
    log(`second pass over ${elements.size} ${intent} candidates`);

    const started = Date.now();
    try {
      const { answers } = await this.client.systemOne(
        {
          state: {
            utterance: situation.utterance,
            goal: situation.goal,
            app: situation.app.name,
            window: situation.app.windowTitle.slice(0, MAX_TITLE),
            elements: lines,
          },
          questions: {
            target: choice(
              `${targetQuestion(intent)} The options are ids from \`elements\`.`,
              criteriaFor([...elements.values()], "The user named something that is not in this list.")
            ),
          },
          model: MODEL,
        },
        { timeout: DECIDE_TIMEOUT_MS, retry: NO_RETRIES }
      );
      log(`second pass answered in ${Date.now() - started}ms`);
      const ask: Ask = { questions: {}, elements, intents: [intent], state: {} };
      return this.interpret(
        intent,
        ask,
        answers.target as unknown as Answer,
        priorConfidence,
        situation.utterance,
        risky
      );
    } catch (error) {
      apiFailure(`second pass failed after ${Date.now() - started}ms`, error);
      return this.fallback.decide(situation);
    }
  }
}

/** A noul's probability, or undefined when the question wasn't asked. */
function readNoul(answer: unknown): number | undefined {
  const candidate = answer as { type?: string; noul?: number } | undefined;
  return candidate?.type === "noul" && typeof candidate.noul === "number" ? candidate.noul : undefined;
}
