import { execFile } from "child_process";
import { promisify } from "util";
import { type Outcome, ok, fail } from "./types";

const run = promisify(execFile);

// Reading a web page properly.
//
// For every other app, macOS's accessibility tree is the right source. For
// a browser it is a lossy projection of something much better, and the
// difference is why the assistant was bad at web pages specifically:
//
//   - no `href`, so a link is just its text
//   - no computed style, so a visually hidden skip-navigation link looks
//     exactly like the first real link on the page
//   - labels concatenated from the headline, the URL and the breadcrumb,
//     which is what produced 139 near-identical walls of text
//   - handles that go stale the moment the page re-renders
//
// The DOM has all of it: `getBoundingClientRect`, `checkVisibility`,
// `aria-label`, and ids we can write *into* the page so they survive a
// re-render. This module reaches it through AppleScript, which works on
// the browser the user already has open — no relaunch with a debugging
// port, no extension to install. It costs one switch in Chrome's own menu.

const BROWSERS: Record<string, { name: string; tell: string }> = {
  "com.google.Chrome": { name: "Google Chrome", tell: "execute active tab of front window javascript" },
  "com.google.Chrome.beta": { name: "Google Chrome Beta", tell: "execute active tab of front window javascript" },
  "com.brave.Browser": { name: "Brave Browser", tell: "execute active tab of front window javascript" },
  "com.microsoft.edgemac": { name: "Microsoft Edge", tell: "execute active tab of front window javascript" },
  "com.apple.Safari": { name: "Safari", tell: "do JavaScript" },
};

export function isBrowser(bundleId: string): boolean {
  return bundleId in BROWSERS;
}

/** What Clance can't do yet, and exactly how the user fixes it. */
export type BrowserBlocked = { blocked: string };

function appleScriptString(source: string): string {
  return source.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function evaluate(bundleId: string, source: string): Promise<string | BrowserBlocked> {
  const browser = BROWSERS[bundleId];
  if (!browser) return { blocked: "That isn't a browser Clance knows how to read." };
  const script =
    browser.tell === "do JavaScript"
      ? `tell application "${browser.name}" to ${browser.tell} "${appleScriptString(source)}" in front document`
      : `tell application "${browser.name}" to ${browser.tell} "${appleScriptString(source)}"`;
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const message = (error as { stderr?: string; message?: string }).stderr ?? String(error);
    // The one failure worth naming precisely, because it is a switch the
    // user can flip and everything else about the feature works once they
    // have. Anything else is reported as it came back.
    if (/Apple Events|AppleScript/i.test(message)) {
      return {
        blocked:
          `${browser.name} won't let Clance read the page yet. Turn on ` +
          `View → Developer → Allow JavaScript from Apple Events, then try again.`,
      };
    }
    if (/Not authorized|assistive|1743/i.test(message)) {
      return {
        blocked:
          `macOS hasn't given Clance permission to control ${browser.name}. ` +
          "Allow it under System Settings → Privacy & Security → Automation.",
      };
    }
    return { blocked: `Couldn't read ${browser.name}: ${message.split("\n")[0]}` };
  }
}

export type PageElement = {
  id: string;
  role: string;
  name: string;
  placeholder?: string;
  href?: string;
  /** Inside the viewport as the user sees it, not merely present. */
  inView: boolean;
  /** Reading order: down the page, then across it. */
  y: number;
  x: number;
};

export type Page = {
  url: string;
  title: string;
  elements: PageElement[];
  /** The page's own search box, if it has an obvious one. */
  searchBoxId?: string;
};

/**
 * The collector, which runs inside the page.
 *
 * Self-contained by necessity — it is serialised into an AppleScript
 * string, so it closes over nothing. Everything it decides is something the
 * DOM knows and the accessibility tree does not.
 */
const COLLECT = `(function () {
  var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],' +
    '[role=radio],[role=switch],[role=searchbox],[role=combobox],[role=textbox],' +
    '[contenteditable=true],[onclick]';
  if (!window.__clanceId) window.__clanceId = 1;
  var vw = window.innerWidth, vh = window.innerHeight;
  var clean = function (s) { return (s || '').replace(/\\s+/g, ' ').trim(); };
  var out = [], search = '';
  var nodes = document.querySelectorAll(SEL);
  for (var i = 0; i < nodes.length && out.length < 300; i++) {
    var el = nodes[i], rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!rect || rect.width < 2 || rect.height < 2) continue;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    // Always minted here, never read back from the page. An id read from
    // the DOM is attacker-controlled: a page can pre-set data-clance-id
    // and have it interpolated into the script we later run in a tab.
    var id = 'd' + (window.__clanceId++);
    el.setAttribute('data-clance-id', id);
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var role = el.getAttribute('role') || '';
    if (!role) {
      if (tag === 'a') role = 'link';
      else if (tag === 'button' || type === 'submit' || type === 'button') role = 'button';
      else if (tag === 'select') role = 'select';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'summary') role = 'button';
      else if (tag === 'input') {
        role = type === 'search' ? 'searchbox' : type === 'checkbox' ? 'checkbox'
             : type === 'radio' ? 'radio' : 'textbox';
      } else if (el.isContentEditable) role = 'textbox';
      else role = 'clickable';
    }
    var img = el.querySelector ? el.querySelector('img[alt]') : null;
    var name = clean(el.getAttribute('aria-label')) || clean(el.innerText) || clean(el.value) ||
      clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) ||
      (img ? clean(img.getAttribute('alt')) : '') || clean(el.getAttribute('name')) || '';
    if (name.length > 60) name = name.slice(0, 59) + '\\u2026';
    var href = '';
    if (tag === 'a') {
      try {
        var u = new URL(el.href, location.href);
        href = u.hostname.replace(/^www\\./, '') + (u.pathname !== '/' ? u.pathname : '');
        if (href.length > 40) href = href.slice(0, 39) + '\\u2026';
      } catch (e) { href = ''; }
    }
    var inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    if (!search && (role === 'searchbox' || type === 'search' ||
        /search|query|\\bq\\b/i.test((el.getAttribute('name') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')))) {
      search = id;
    }
    out.push({ id: id, role: role, name: name, placeholder: clean(el.getAttribute('placeholder')) || undefined,
      href: href || undefined, inView: inView, y: Math.round(rect.top), x: Math.round(rect.left) });
  }
  out.sort(function (a, b) {
    if (a.inView !== b.inView) return a.inView ? -1 : 1;
    if (Math.abs(a.y - b.y) > 4) return a.y - b.y;
    return a.x - b.x;
  });
  return JSON.stringify({ url: location.href.slice(0, 200), title: document.title.slice(0, 120),
    elements: out, searchBoxId: search || undefined });
})()`;

export async function readPage(bundleId: string): Promise<Page | BrowserBlocked> {
  const raw = await evaluate(bundleId, COLLECT);
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as Page;
  } catch {
    return { blocked: "The page didn't answer in a form Clance could read." };
  }
}

// Acting happens by id, on the element itself — not at a coordinate. The id
// was written into the DOM when the page was read, so it still refers to
// the same element even if the page has re-flowed since.
//
// The shape of an id Clance minted, and the only shape it will act on.
const CLANCE_ID = /^d[0-9]{1,9}$/;

/**
 * A selector for one element Clance itself tagged.
 *
 * This string is executed as JavaScript inside a page, so anything
 * interpolated into it is code. The id reaches here from `readPage`, which
 * reads the DOM — so until the collector was changed to mint every id
 * rather than read one back, a page could set
 * `data-clance-id='x"]);…;//'` and break out of the selector into
 * arbitrary script. Worse than it sounds: AppleScript targets *the active
 * tab*, so a tab switch between reading and clicking runs that script in
 * another site's origin.
 *
 * Minting ids closes that. This is the second lock: an id that isn't one
 * Clance could have produced never becomes code at all.
 */
function byId(id: string): string | null {
  if (!CLANCE_ID.test(id)) return null;
  return `document.querySelector('[data-clance-id="${id}"]')`;
}

export async function clickElementInPage(bundleId: string, id: string, label: string): Promise<Outcome> {
  const selector = byId(id);
  if (!selector) return fail(`"${label}" doesn't have an id Clance issued, so it won't be clicked.`);
  const source = `(function(){var el=${selector};if(!el)return 'gone';` +
    `el.scrollIntoView({block:'center'});el.click();return 'ok';})()`;
  const result = await evaluate(bundleId, source);
  if (typeof result !== "string") return fail(result.blocked);
  if (result === "gone") return fail(`"${label}" is no longer on the page.`);
  return ok(`Clicked "${label}".`);
}

export async function typeInPage(
  bundleId: string,
  id: string,
  text: string,
  submit: boolean,
  label: string
): Promise<Outcome> {
  const selector = byId(id);
  if (!selector) return fail(`"${label}" doesn't have an id Clance issued, so it won't be typed into.`);
  // Set the value, then fire the events a framework listens for — React and
  // friends ignore a value assigned behind their back.
  const source =
    `(function(){var el=${selector};if(!el)return 'gone';el.scrollIntoView({block:'center'});el.focus();` +
    `var v=${JSON.stringify(text)};` +
    `if('value' in el){var set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');` +
    `if(set&&set.set)set.set.call(el,v);else el.value=v;}else{el.textContent=v;}` +
    `el.dispatchEvent(new Event('input',{bubbles:true}));` +
    `el.dispatchEvent(new Event('change',{bubbles:true}));` +
    (submit
      ? `el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));` +
        `if(el.form&&el.form.requestSubmit)el.form.requestSubmit();`
      : "") +
    `return 'ok';})()`;
  const result = await evaluate(bundleId, source);
  if (typeof result !== "string") return fail(result.blocked);
  if (result === "gone") return fail(`"${label}" is no longer on the page.`);
  return ok(submit ? `Searched "${text}" in ${label}.` : `Typed "${text}" into ${label}.`);
}

export async function openUrl(bundleId: string, url: string): Promise<Outcome> {
  const result = await evaluate(bundleId, `(function(){location.href=${JSON.stringify(url)};return 'ok';})()`);
  if (typeof result !== "string") return fail(result.blocked);
  return ok(`Opened ${url}.`);
}
