---
title: Assistant
tags: [clance, assistant, requirements]
---

# Assistant

What the voice assistant does. How it's built is in `design.md`; why Clance
exists at all is in `background.md`. This doc describes the feature in the
user's terms and deliberately assumes nothing about what Clance can already
do — where a requirement needs a capability that doesn't exist yet, that is
noted rather than designed around.

## What it is

Press ⌥A and talk to your Mac. Clance carries out what you say — opening
apps, running their commands, moving around, putting text where you want it
— and hands anything open-ended to a Claude Code session.

It is not a chatbot with a microphone. The assistant never answers in prose
and never holds a conversation. It listens, decides what you meant, and
acts. When what you want needs thinking rather than doing, it stops being
the assistant's job and becomes a session's.

Three hotkeys, three jobs, no overlap:

| | |
|---|---|
| ⌥Space | A Claude Code session in the floating widget |
| ⌥D | Dictate text into the app you're in |
| ⌥A | Tell Clance to do something |

## Invocation and the listening session

- ⌥A starts listening from any app, immediately, and Clance keeps listening
  until told to stop. One press buys a conversation, not one command.
- Commands fire as they are finished. The user keeps talking; Clance keeps
  acting. Nothing waits for a final "go".
- Listening ends on ⌥A again, on Escape, after a period of silence, or when
  the user says so ("stop", "never mind", "that's it").
- Escape always cancels — while listening, while asking a question, and
  while an action is being confirmed. It never leaves the assistant in a
  state the user has to hunt for.
- The assistant never takes keyboard focus. Whatever the user was working in
  stays focused and stays the target of everything that happens.
- Starting a listening session never changes what's on screen by itself.
  Opening the assistant is not an action.

## Listening and acting

- Clance acts on a command as soon as the command is complete, not when the
  user stops speaking. "Open Mail, new message" performs two things in the
  order they were said.
- A command that needs several steps is carried out as several steps.
  Clance looks at the screen between each one, so what it does next is
  decided against what actually happened rather than what it expected.
- A partial command is held until it is complete or abandoned. Silence long
  enough after an incomplete phrase discards it rather than guessing.
- Commands are carried out in the order spoken, one at a time. A command
  spoken while the previous one is still running is queued, not dropped, and
  not raced.
- Filler, self-correction and restarts are tolerated: "open, uh, open Notes"
  performs one action.
- If the user says something that isn't a command at all, nothing happens
  and Clance says it heard nothing actionable. Silence is never treated as
  agreement.

## What it can do

The assistant's repertoire is everything below. Items marked *(not yet)*
don't work today.

**Applications**
- Launch an app by name, whether or not it's running.
- Switch to a running app, or to a specific window of one. *(not yet: a
  specific window — switching goes to the app, and its Window menu goes to
  the window)*
- Quit or hide an app.

**An app's own commands**
- Run any command the frontmost app publishes in its menus — "new note",
  "save", "close tab", "export as PDF". The assistant learns these from the
  app rather than being taught them, so a newly installed app works without
  Clance knowing anything about it.
- Report honestly when a command exists but is unavailable — greyed out,
  wrong context — rather than appearing to succeed.

**Moving around**
- Scroll, page and jump to top or bottom of what's in front.
- Move between tabs and windows.
- Move, resize and arrange windows. Fullscreen and minimise come from the
  app's own View and Window menus rather than being separate verbs, because
  that is where every app already puts them. Some apps refuse to be moved
  at all, and that is reported rather than retried.

**Pointing at things**
- Focus a named control — a field, a button, a link.
- Press a named control.
- Press a thing described by where it is, when its name is no help: "the
  first link", "the last button". Counted within the page rather than the
  window, so the browser's own toolbar is never "the first button".
  Only things actually on screen are counted, so a hidden
  skip-to-content link is never "the first".
  *(not yet: "the first result" — a heading, link and snippet read as one
  thing — is not grouped, so "the first link" means the topmost link rather
  than the first result.)*

**Putting text somewhere**
- Write words that were part of the command itself: "type see you at five",
  "search for Jon Stewart", "find revenue on this page". The words are taken
  from what the user actually said, never composed, so what lands is what
  they spoke.
- Dictate into a field the user names, in one movement: "click the subject
  and dictate". This is for the words that *haven't* been said yet. The
  listening session stays open but stands aside for the length of the
  dictation — one microphone, so the assistant stops listening for commands
  until the words have landed, then picks up where it left off.
- Insert a stored value — email address, phone number, a saved snippet.
  *(not yet: a way to add one. The assistant inserts any value that exists;
  nothing in Settings creates them.)*
- Insert text a Claude session produced.
- Replace a selection, insert at the cursor, or clear a field.

**Clance itself**
- Start a Claude Code session, in the widget or a tab, in a named folder.
  *(not yet: in a named folder — a session starts in the default one)*
- Open a section of the main window.
- Repeat, undo or cancel what it just did.

Starting dictation is listed under "Putting text somewhere" rather than
here: the user isn't asking for a Clance feature, they're asking for words
to end up somewhere.

**Asking Claude**
- Anything that needs reasoning, reading, writing or judgement is handed to
  a Claude Code session rather than attempted. See "Handing off".

## Referring to things on screen

- Things are named the way they are labelled: "the Send button", "the search
  field". The user should never have to know an app's internals.
- When several things match, Clance asks which, listing them, and the answer
  can be spoken — "the second one", "the one in the toolbar". Resolving an
  ambiguity never requires the mouse.
- When nothing matches, Clance says what it looked for and where, rather
  than failing silently or pressing something approximate.
- Some apps publish nothing useful about their contents. Against one of
  those the assistant says so and offers to hand the screen to a session,
  rather than reporting an empty window as an absence of buttons.

## Confidence, confirmation and refusal

- Every action carries a risk. Safe actions are performed. Risky ones are
  confirmed first, every time, however clearly they were heard.
- An action is risky if it destroys something, sends something, spends
  something, or can't be undone. When Clance can't tell, it treats the
  action as risky.
- Low confidence is its own reason to ask, even for a safe action. Clance
  says what it thinks it heard and waits.
- Confirmation is answerable by voice, and Escape declines it.
- The assistant never types into a password field, and never reads one. It
  says a password field is focused and nothing else.
- The assistant does not act on what it was not asked to do. It never
  performs an action the user did not name in order to make another one
  work, without saying so first.

## Correcting and undoing

- "Undo that" reverses the last action where the app supports it, and says
  plainly when it can't.
- "No, the other one" after an ambiguous match picks a different candidate
  without the command being repeated.
- "Cancel" stops an action that is being confirmed or is in progress, where
  stopping is possible.
- A misheard command that performed the wrong action is always reported —
  the user is told what happened, so an unexpected change is never a mystery.

## Handing off to Claude

- When a request needs reasoning rather than doing, the assistant starts or
  reuses a Claude Code session instead of attempting it.
- The session is given what it needs to start — what the user said, the app
  and window they were in, and the selection if there was one. The user
  should not have to say it twice.
- The handoff is visible. The user is told a session is taking over, and
  where it opened.
- If a session is already running for the work in front of the user, the
  request goes to that session rather than starting another.
- Handing off is also the fallback for anything the assistant can't do:
  rather than refusing, it offers the session.

## What the user sees and hears

- A small indicator shows that Clance is listening, what it is hearing, and
  what it just did. It never takes focus and never covers what the user is
  working on.
- Every action produces visible acknowledgement — what was done, to what. An
  action that fails says why in the app's own terms.
- A question — an ambiguity or a confirmation — is unmistakably a question,
  and says what will happen if it is answered.
- The indicator is legible without looking away from the work. Long
  transcripts are not shown; what was understood is.
- Nothing the assistant displays is ever captured in a screenshot Clance
  takes.

## Privacy

- Speech is transcribed on the Mac. Audio never leaves it.
- Dictated content — the words the user wants written down — never leaves
  the Mac.
- Deciding what a command means may use a service off the Mac. What it is
  given is the command, the name of the app in front, its window title, and
  the list of things that could be done. It is never given the user's
  documents, the contents of fields, or anything dictated.
- Any off-Mac decision service is named in Settings, can be switched off,
  and when off the assistant still works on what it can recognise locally.
- The assistant listens only between ⌥A and the end of the session. There is
  no wake word, no always-on microphone, and no background screen reading.

## When things fail

- No microphone, no speech model, no permission: the assistant says which,
  and links to where it's fixed.
- The decision service being unreachable degrades the assistant to what it
  can work out locally rather than disabling it.
- An action that fails says so in the words of the app that refused it.
- An assistant that can't do something says so and offers the session.
  "Nothing happened" is never an acceptable outcome.

## Non-functional

- **Fast enough to talk to.** An action begins within a few hundred
  milliseconds of the command being finished. The assistant must never be
  the reason a user slows down their speech. *Not met today: measured
  580–1250 ms end to end, most of it the decision call. See the latency
  budget in `design.md`.*
- **Never surprising.** A command that was not given is never carried out. A
  command that was given is either carried out, refused with a reason, or
  queried.
- **Interruptible.** Everything is cancellable, at any point, from the
  keyboard.
- **Works in any app,** including apps Clance has never seen, without
  per-app configuration.
- **Degrades rather than breaks** when any of speech, decision or action is
  unavailable.

## Out of scope

- A wake word, or listening when not invoked.
- Speaking responses aloud.
- Answering questions in the assistant itself — answers come from a session.
- Holding a conversation, remembering across listening sessions, or
  personalisation that learns from use.
- Automating a sequence for later replay; this is not a macro recorder.
- Controlling another machine, a phone, or anything that isn't this Mac.
- Languages other than English, initially.
- Acting on a schedule or on a trigger that isn't the user speaking.

## Open

- **Where an argument stops and starts.** A command that carries its own
  content now works — "search for Jon Stewart" finds the name in the
  sentence and searches for it. What is unproven is the boundary: the
  candidate spans are generated by trimming function words, and a phrase
  that leans on one of them ("look up how to tie a bowline") may be cut
  short. A span that is never generated can never be chosen, and nothing
  tells the user their search was trimmed.
- **How far a goal should be pursued.** "Open Mail and start a new message
  to Sarah" is now attempted as several steps towards one goal rather than
  refused, but the stopping rule is a guess: six steps, or the moment the
  decider judges the goal reached. Whether that judgement is reliable enough
  to act on, and whether six is the right number, is unmeasured.
- **Carrying context between commands.** "Open Notes. Now make a new one."
  needs the second command to know about the first. How far that memory
  should reach inside a session is undecided.
- **Stored values.** Inserting a value works and reads from config; adding
  one has no interface. What is still unspecified is how a user names a
  value by voice so that "insert my work email" finds it reliably.
- **Positional targeting beyond an ordinal.** "The first link" works.
  "The button at the bottom right" does not, and would need every control's
  frame read on every command, which the latency budget has no room for.
- **Undo beyond one step.** Single-step undo is committed. A history the
  user can walk back through is not.
- **Which commands to confirm.** Anything the assistant can't classify is
  confirmed, and the destructive lexicon that classifies the rest is a
  guess. Whether the result is too noisy to live with, and whether the
  confidence threshold below which even a safe action is queried is
  anywhere near right, are both unmeasured against real speech.
