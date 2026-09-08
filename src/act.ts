// act — the only mutating surface. The transplanted attempt-6 spine
// (docs/vision.md, docs/lessons.md): revalidate at dispatch time using the browser's
// own computation → capture before-state (observers precede dispatch) →
// browser-authentic CDP input → settle → verify postcondition against the live page.
// Delivery is not success; contradicted can never become success. `select` was

import { existsSync, readdirSync } from 'node:fs';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import type { CDPSession, Page } from 'playwright';
import { normalize } from './find.js';
import type { BrowserEvent } from './host.js';
import { looksLikeChord, parseChord, pressChord } from './keys.js';
import {
  RECEIPT_POST_DATA_BOUND,
  receiptFor,
  receiptPage,
  unarmedReceipt,
  type ActReceipt,
  type ReceiptLedger,
  type WireEntry,
} from './receipt.js';
import {
  checkNavigation,
  checkSent,
  checkState,
  checkText,
  type ExpectationFailure,
  type ObservedState,
} from './expect.js';
import type {
  ActExpect,
  ActExpectation,
  ActUntil,
  ActUntilResult,
  EffectEvidence,
  EffectVerdict,
  Rejection,
  WirGraph,
  WirNode,
} from './types.js';

/** What the spine's own paths produce; the receipt is attached once, in `act`. */
export interface ActOutcome {
  actRef: string;
  outcome: 'delivered' | 'not_delivered';
  effect: {
    verdict: EffectVerdict;
    evidence: EffectEvidence;
    // Present on `unknown` alone: which observers were armed and came back
    // empty, and what WAS observed but cannot be attributed. Measured need
    // (docs/plans/fewer-misses.md §A2): 102 recorded unknowns carried no
    // reason at all, so the caller's next move was a guess. verified and
    // contradicted never carry it — their evidence already says what was seen.
    reason?: string;
    delta: { before: string; after: string };
    /** Present only when the caller declared `expect`: the declaration beside
     *  what was observed (core/expect.ts). Side by side with the verdict, never
     *  merged into it. */
    expectation?: ActExpectation;
    /** Present only when the caller declared `until`: whether the condition
     *  held inside the bound, when, and what the last check saw. Never moves
     *  the verdict above it — a condition that timed out is a fact about the
     *  page, not a contradiction of the act. */
    until?: ActUntilResult;
  };
}
export interface ActResult extends ActOutcome {
  /** The requests the browser sent inside this act's window — method, URL,
   *  status, body fields — as data, never a verdict. The effect verdict says
   *  whether SOMETHING happened; the receipt says what was actually sent, so a
   *  request that went to another route or carried other fields than intended
   *  is visible rather than hidden behind `verified`. Bounded and accounted:
   *  `read {target: actRef}` pages through everything (core/receipt.ts). */
  receipt: ActReceipt;
}
export type ActRejection = Rejection;

interface AXProbe {
  role: string;
  name: string;
  disabled: boolean;
  expanded: boolean | null;
  checked: string | null;
  pressed: string | null;
  selected: string | null;
}

/** The `until` bound: default and ceiling. 5 s is the act's own main-frame
 *  extra window (below); 15 s is the navigation budget — an act may not hold an
 *  episode longer than a page load may. */
export const UNTIL_DEFAULT_MS = 5_000;
export const UNTIL_MAX_MS = 15_000;
/** `network: "idle"` means no request this act's ledger recorded is still open,
 *  and that has held for this long. 500 ms is the settle the ordinary XHR
 *  cascade needs (a response that triggers the next request lands inside it). */
export const UNTIL_IDLE_MS = 500;
/** text / gone / role are judged over a FRESH COMPILE of the same graph `find`
 *  searches, and a compile of a heavy admin page costs 0.3-1.2 s. So the
 *  document is recompiled only when the host's mutation token has moved since
 *  the last compile, never more often than the last compile took, and at most
 *  this many times per act. A page that is still changing when the cap is spent
 *  is reported as exactly that, with the count. 30 at ~500 ms a cycle covers the
 *  15 s ceiling. */
export const UNTIL_RECOMPILE_CAP = 30;
/** How often the cheap signals (mutation token, AX probe, open-request set) are
 *  sampled between compiles. */
const UNTIL_POLL_MS = 100;

type ActRequest = {
  ref: string;
  action: 'click' | 'fill' | 'select' | 'type' | 'key' | 'upload' | 'scroll' | 'hover';
  value?: string | null;
  until?: ActUntil | null;
  expect?: ActExpect | null;
};

/** What the executor needs from the host to judge an `until` over the document:
 *  the same capture -> compile path every read and find takes, and the mutation
 *  token that says whether a recompile could see anything new. Optional so the
 *  executor stays constructible from a bare (page, cdp) pair; without it a
 *  document-backed condition is a typed rejection, never a guess. */
export interface UntilObserver {
  compile: () => Promise<WirGraph>;
  mutationToken: () => Promise<string | null>;
}

// One rejection for both ways an overlay bites: the target is covered where it
// stands, or it has been held out of the accessibility tree behind a modal.
// Naming the occluder is what makes it actionable — "something is on top"
// without saying what is barely better than the lie it replaces.
function coveredRejection(occluder: string): Rejection['rejected'] {
  // Name a call that can actually find THIS occluder. The fixed
  // `find {"role":"dialog"}` this replaced misses the two commonest cases the
  // reason text itself names: a cookie strip or sticky banner is a bare div
  // (compiled role `generic`), and a real modal often compiles as `alertdialog`,
  // which `role: "dialog"` does not match — even though coveringOverlay's own
  // closest() accepts it. A repair that cannot succeed is worse than none: it
  // closes off the alternative while looking like guidance.
  //
  // The description already carries what is needed — it is built as
  // `tag [role=X] [aria-modal] [#id] ["up to 60 chars of text"]` — so the quoted
  // text is a substring of the occluder's own words, which is exactly what find
  // matches on.
  const quoted = /"((?:[^"\\]|\\.)*)"/.exec(occluder)?.[1];
  const role = /role=([\w-]+)/.exec(occluder)?.[1];
  const byText =
    quoted !== undefined && quoted.length > 2
      ? `{"verb":"find","name":${JSON.stringify(quoted.slice(0, 40))}}`
      : null;
  const byRole = role !== undefined ? `{"verb":"find","role":${JSON.stringify(role)}}` : null;
  const how =
    byText ??
    byRole ??
    '{"verb":"read"} and look for a banner, consent wall or modal near the top of the page';
  return {
    kind: 'blocked_by_overlay',
    reason:
      `a click at this target's position would be received by ${occluder} instead — ` +
      'the target is covered, so the click cannot reach it',
    repair:
      `${how} to locate the overlay, then act on its own close/dismiss control. ` +
      'Re-reading will NOT help: the page has not changed, something is layered over it.',
  };
}

// What the hit-test found, beyond the element under the pointer: the LAYER
// that element belongs to. `root` is the nearest ancestor of the hit that is
// in the browser's top layer, else the OUTERMOST positioned (fixed / sticky /
// absolute) ancestor below the hit's common ancestor with the target — the
// boundary between the page and whatever is layered over it. null when the
// walk found no such ancestor, in which case only the hit itself is named.
interface CoveringOverlay {
  occluder: string;
  root: {
    /** The root's backendNodeId, when the DOM domain could describe it. */
    backendNodeId: number | null;
    /** The element the hit-test returned (the `top` of LOCATE_OVERLAY_JS),
     *  when the DOM domain could describe it — the backdrop classification
     *  asks it for a listener when the root has none of its own. */
    hitBackendNodeId: number | null;
    /** `tag [role=X] [#id] ["text"]`, the same shape as `occluder`. */
    desc: string;
    tag: string;
    position: string;
    topLayer: boolean;
    popover: boolean;
    /** By the rule `key` itself applies (focusableAncestorRef): a native
     *  focusable tag, a tabindex other than -1, or contenteditable. */
    focusable: boolean;
    /** A loading indicator, by one of three mechanical rules — `rule` says
     *  which fired, in the refusal's own words; `phrase` is the run of the
     *  root's own words that carried a TRANSIENT_WORDS hit (the words to
     *  watch leave), null for the aria and animated-only rules. null when no
     *  rule fired: the root is then not transient. */
    transient: { rule: string; phrase: string | null } | null;
  } | null;
  /** backendNodeIds of the root's own controls that carry a dismissal word
   *  (DISMISSAL_WORDS, over name + description + own text), plus every button
   *  of a `form method=dialog` inside it — in document order, exact. */
  dismiss: number[];
}

// The words a dismissal control tends to carry. A substring test over the
// node's own words — mechanical, never a matcher: the list is closed, the
// test is `includes`, and the result is offered as "looks like", never as
// "is". A control that carries none of these is still reachable through
// `read` on the root; nothing is removed.
const DISMISSAL_WORDS = ['close', 'dismiss', 'cancel', 'exit', 'done', '\u00d7', '\u2715'];
const DISMISSAL_WORDS_SHOWN = 'close/dismiss/cancel/exit/done/\u00d7/\u2715';
const DISMISS_LISTED = 5;
const DISMISS_CANDIDATES = 64;

// The words a loading indicator tends to carry — closed, substring-tested over
// the covering root's OWN words (accname sources, its text, the alt/title of
// its images), NFKC + case-folded; never a matcher, never learned. A root is
// called transient only when one of three mechanical rules fires (the
// classification lives in coveringOverlay), and the rule that fired is stated
// in the refusal; when none fires, the root is not transient — no guessing.
// This behavior was verified during testing.
// page's own controls refused under an unnamed fixed div with "Re-reading will
// NOT help: the page has not changed". Reproduced on that page
// This behavior was verified during testing.
// wordless div of eight animated <span>s — covers every control for the first
// seconds after load, and the picker's grid has a sibling of the same shape
// while it reloads. For that class the sentence is exactly backwards: the page
// is about to change on its own, and the right move is to wait — which `until`
// already provides. (The arms' longer-lived div was the admin menu's backdrop,
// a different class; no rule fires for it and its text is unchanged.)
const TRANSIENT_WORDS = ['loading', 'please wait', 'wait', 'spinner', 'progress', 'busy'];

// The third class: a BACKDROP — a layer with no words, no rendered control,
// and a click listener of its own, whose exit is the layer itself. Decided
// after the dismiss list and the transient rules have found nothing, from
// two facts the browser holds: the root's own content (computed in the
// browser, the same word sources the words rule reads) and the browser's
// own listener table (DOMDebugger.getEventListeners on the root, then the
// element under the pointer, then at most BACKDROP_ANCESTORS ancestors).
// This behavior was verified during testing.
// This behavior was verified during testing.
// (position fixed, z-index 697, empty, wordless, no animation, no control)
// over the whole page, and every click beneath it was refused with "no
// control inside the overlay carries a dismissal word … Re-reading will NOT
// help" for ~30 calls; arm 4 escaped only by reading the root's ref and
// clicking the overlay itself (row 96) — its own click listener closes the
// This behavior was verified during testing.
// backdrop is in the graph as a generic (Chrome's isClickable admits it) and
// the listener table shows `click` on it and nothing click-shaped on its
// ancestors. A dialog with words or controls is never a backdrop (it keeps
// its dismiss list or its no-way-out text); a loading indicator is never a
// backdrop (it keeps the wait).
const BACKDROP_LISTENER_TYPES = ['click', 'mousedown', 'pointerdown'];
const BACKDROP_ANCESTORS = 3;
interface BackdropFinding {
  /** Which node carries the listener, in the refusal's words. */
  bearer: string;
  where: 'root' | 'hit' | 'ancestor';
  /** The listener types found on the bearer, in BACKDROP_LISTENER_TYPES order. */
  types: string[];
  /** The literal click: the bearer's ref when the graph holds it (root or
   *  hit), the layer's own ref when the bearer is an ancestor (a click on the
   *  layer bubbles to it). null when nothing is addressable — the text then
   *  names the class and says so, and offers no call. */
  ref: string | null;
}
/** The act being refused, so the repair can be the literal "repeat it with
 *  until" — the same shape parseUntil's own repairs echo. */
type RepeatCall = { ref: string; action: string; value?: string | null; expect?: unknown };

// The refusal, with the layer NAMED and its own exit listed. The refusal it
// replaces named the element under the pointer and told the caller to find
// it: on Page Builder's full-screen stage that element was a panel heading
// INSIDE the overlay, `find "Elements"` found the heading, and the model spent
// 15 refused clicks searching "close" / "X" / "exit" for a control that was
// This behavior was verified during testing.
// runtime had computed where the overlay was and what it contained; it said
// neither. This says both, and only what was computed.
function overlayRejectionText(
  g: WirGraph,
  c: CoveringOverlay,
  dismiss: WirNode[],
  repeat: RepeatCall | null = null,
  waitedMs: number | null = null,
  backdrop: BackdropFinding | null = null,
): Rejection['rejected'] {
  const root = c.root;
  if (root === null) return coveredRejection(c.occluder);
  const rootRef =
    root.backendNodeId === null ? null : (g.byBackendId.get(root.backendNodeId) ?? null);
  const rootNode = rootRef === null ? null : (g.nodes.get(rootRef) ?? null);
  const layer = root.topLayer ? "in the browser's top layer" : `position ${root.position}`;
  // Named like any node: role and ref when the graph holds it, its accname or
  // description when it has one; the DOM description when it does not.
  const rootLabel =
    rootNode !== null
      ? `${rootNode.role} ${rootNode.ref}` +
        (rootNode.name !== ''
          ? ` ${JSON.stringify(rootNode.name.slice(0, 60))}`
          : rootNode.description
            ? ` (description ${JSON.stringify(rootNode.description.slice(0, 60))})`
            : '') +
        ` (${layer})`
      : `${root.desc} (${layer}; not separately addressable in this graph)`;
  // Transience only matters where the current text would say "no control
  // inside the overlay carries a dismissal word": a layer with its own exit
  // keeps the exit (a loading dialog with a Cancel button is still cancelled
  // by it), and only a layer with none is asked whether it will leave by itself.
  const transient = dismiss.length === 0 ? root.transient : null;
  // A backdrop only where neither of those fired: a layer with an exit keeps
  // the exit, a loading indicator keeps the wait.
  const bare = dismiss.length === 0 && transient === null ? backdrop : null;
  const reason =
    `a click at this target's position would be received by ${c.occluder} instead — ` +
    `the target is covered by ${rootLabel}, so the click cannot reach it` +
    (transient !== null ? `; the covering layer is a loading indicator — ${transient.rule}` : '') +
    (bare !== null
      ? `; the covering layer is a backdrop — it has no words and no rendered control, and ${bare.bearer} carries a ${bare.types.join('/')} listener`
      : '');
  const brief = (n: WirNode): string =>
    JSON.stringify({
      ref: n.ref,
      role: n.role,
      ...(n.name !== ''
        ? { name: n.name.slice(0, 60) }
        : n.description
          ? { description: n.description.slice(0, 60) }
          : n.text !== ''
            ? { text: n.text.slice(0, 60) }
            : {}),
    });
  let repair: string;
  if (transient !== null) {
    // The literal wait. `gone` is judged over the graph (awaitUntil), so it
    // is offered only when the graph can see the indicator's words; a
    // wordless spinner — the 464 shape — waits on the wire instead.
    const phrase = transient.phrase;
    const inGraph =
      phrase !== null &&
      [...g.nodes.values()].some((n) =>
        `${normalize(n.name)} ${normalize(n.text)} ${normalize(n.description ?? '')}`.includes(
          normalize(phrase),
        ),
      );
    const until: Record<string, string> = inGraph
      ? { gone: phrase as string }
      : { network: 'idle' };
    const call =
      repeat === null
        ? null
        : JSON.stringify({
            verb: 'act',
            ref: repeat.ref,
            action: repeat.action,
            ...(repeat.value === undefined || repeat.value === null ? {} : { value: repeat.value }),
            ...(repeat.expect === undefined || repeat.expect === null
              ? {}
              : { expect: repeat.expect }),
            until,
          });
    repair =
      'this overlay is a loading indicator; the page will change on its own: repeat the act with until, or read after it settles. ' +
      (call !== null
        ? `${call} waits up to withinMs (default ${UNTIL_DEFAULT_MS}, max ${UNTIL_MAX_MS}) for the indicator to leave the target before dispatching, then judges until as declared`
        : '{"verb":"read"} once it settles') +
      (waitedMs !== null
        ? `; this call already waited ${waitedMs} ms and the indicator was still there — repeat with a larger withinMs, or {"verb":"read"} once it settles`
        : '') +
      (rootRef !== null
        ? `; ${JSON.stringify({ verb: 'read', target: rootRef })} lists what the overlay itself contains`
        : '') +
      '.';
  } else if (bare !== null && bare.ref !== null) {
    // The literal exit: the layer's own listener. For an ancestor-borne
    // listener the click still goes to the layer — it bubbles up to the
    // bearer, and a click dispatched at the bearer's own centre could land on
    // anything the layer does not cover.
    const call = JSON.stringify({ verb: 'act', ref: bare.ref, action: 'click' });
    repair =
      (bare.where === 'ancestor'
        ? `this is a backdrop: it has no words and no controls, and the ${bare.types[0]} listener that dismisses it is on ${bare.bearer}; a click on the layer bubbles to it. `
        : bare.where === 'hit'
          ? `this is a backdrop: it has no words and no controls, and the element under the pointer carries its own ${bare.types[0]} listener; clicking it is how the page dismisses it. `
          : `this is a backdrop: it has no words, no controls, and its own ${bare.types[0]} listener; clicking it is how the page dismisses it. `) +
      `${call} to dismiss it, then repeat this act. ` +
      'Re-reading will NOT help: the page has not changed, something is layered over it.';
  } else if (dismiss.length > 0) {
    const shown = dismiss.slice(0, DISMISS_LISTED);
    const first = shown[0] as WirNode;
    repair =
      `the overlay's own controls whose words contain one of ${DISMISSAL_WORDS_SHOWN}` +
      (root.tag === 'dialog' ? ' (or that submit a form method=dialog)' : '') +
      `: [${shown.map(brief).join(', ')}]` +
      (dismiss.length > shown.length ? ` and ${dismiss.length - shown.length} more` : '') +
      `. ${JSON.stringify({ verb: 'act', ref: first.ref, action: 'click' })} to dismiss it, then repeat this act. ` +
      'Re-reading will NOT help: the page has not changed, something is layered over it.';
  } else {
    const escape =
      root.focusable && rootRef !== null
        ? `${JSON.stringify({ verb: 'act', ref: rootRef, action: 'key', value: 'Escape' })} sends Escape to the overlay itself`
        : root.popover
          ? 'it is a light-dismiss popover (Escape closes it), but it cannot take keyboard focus and act has no document-level key, so no key path is offered'
          : 'it cannot take keyboard focus and act has no document-level key, so no key path is offered';
    repair =
      `no control inside the overlay carries a dismissal word (${DISMISSAL_WORDS_SHOWN}); ${escape}` +
      (bare !== null
        ? `; it is a backdrop whose exit is the ${bare.types[0]} listener on ${bare.bearer}, but neither that node nor the layer is addressable in this graph, so no click is offered`
        : '') +
      (rootRef !== null
        ? `; ${JSON.stringify({ verb: 'read', target: rootRef })} lists what the overlay itself contains`
        : '') +
      '. Re-reading will NOT help: the page has not changed, something is layered over it.';
  }
  return { kind: 'blocked_by_overlay', reason, repair };
}

// Shared by the two hit-test calls below, so the root they name is the same
// root. Runs with `this` = the target element and (px, py, ...topLayer)
// as arguments; evaluates to `{ top, root }` or null when the click reaches
// the target. Every comment on WHY is kept inline — this is the executor's
// most-corrected function.
const LOCATE_OVERLAY_JS = `
  const px = arguments[0], py = arguments[1];
  const topLayerEls = Array.prototype.slice.call(arguments, 2);
// Ask about the point that will ACTUALLY be clicked. Recomputing a
// rect centre here answered a different question from the one act
// dispatches, so a target clickable at its real hit point could be
// refused on the strength of its centre.
  let x = px, y = py;
  if (x === null || y === null) {
    const r = this.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    x = r.left + r.width / 2; y = r.top + r.height / 2;
  }
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
  let top = document.elementFromPoint(x, y);
  if (!top) return null;

// DESCEND first. elementFromPoint answers for one tree and retargets a
// hit inside a shadow root to that root's HOST, so on any web component
// the answer is the component, not the button the user is pointing at.
// Recursing into each shadowRoot's own elementFromPoint is what Playwright
// does, and without it a target inside a shadow tree can never match the
// hit — every link on chromestatus.com was refused with the page's own
// <chromedash-app> named as the thing covering it.
  for (let guard = 0; guard < 32 && top.shadowRoot; guard++) {
    const deeper = top.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === top) break;
    top = deeper;
  }
// Then climb the COMPOSED tree, BOTH directions. Either relationship
// means the click reaches the target:
//   hit inside target  — a button's own label text, a component's inner
//                        node once the descent above has found it;
//   target inside hit  — an ancestor painting over its own descendant,
//                        which is a layout fact, not an overlay.

// <section #js-service-desk> read as covering the Dismiss button inside

// dismissed the notice it was told to.
  const composedUp = (start) => {
    const seen = [];
    for (let n = start, guard = 0; n && guard < 200;
         n = n.assignedSlot ?? n.parentElement ?? n.getRootNode().host, guard++) {
      seen.push(n);
    }
    return seen;
  };
  const hitChain = composedUp(top);
  if (hitChain.includes(this)) return null;
  const targetChain = composedUp(this);
  if (targetChain.includes(top)) return null;
// A <label> activates its control: clicking the label IS clicking the
// input, so a label painting over its own input is not an overlay.
// Bootstrap 4's custom controls are built exactly this way (opacity:0
// input under a ::after painted by the label) — 12 of 15 on one page.
  const label = top.closest ? top.closest('label') : null;
  if (label && (label.control === this || (label.htmlFor && label.htmlFor === this.id))) return null;
// THE LAYER. Walk outward from the hit, stopping at the first ancestor
// shared with the target (from there up, the tree is the page itself).
// A top-layer ancestor is the root and ends the walk: the top layer
// paints above every z-index, and anything positioned inside it is a
// panel of the same layer. Else the nearest ancestor that DECLARES itself

// modal is role=dialog aria-modal inside a positioned BootstrapVue wrapper
// the graph never admits, and naming the wrapper names nothing a caller
// can read. Else the OUTERMOST positioned ancestor — the fixed stage, not
// the absolute palette inside it. The browser's hit-test already proved
// the layer paints above the target; this only asks which ancestor it is.
  const shared = new Set(targetChain);
  let root = null, dialogRoot = null;
  for (const n of hitChain) {
    if (shared.has(n)) break;
    if (n.nodeType !== 1) continue;
    if (topLayerEls.includes(n)) { root = n; dialogRoot = null; break; }
    if (dialogRoot === null && n.matches('[role=dialog],[role=alertdialog],dialog,[aria-modal=true]')) dialogRoot = n;
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') root = n;
  }
  return { top, root: dialogRoot ?? root };
`;

const DESCRIBE_ELEMENT_JS = `
  const describe = (el) => {
    const bits = [el.tagName.toLowerCase()];
    const role = el.getAttribute('role');
    if (role) bits.push('role=' + role);
    if (el.getAttribute('aria-modal') === 'true') bits.push('aria-modal');
    if (el.id) bits.push('#' + el.id);
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 60);
    if (text) bits.push(JSON.stringify(text));
    return bits.join(' ');
  };
`;

export class ActExecutor {
  private counter = 0;
  constructor(
    // The page and CDP session are read THROUGH the host on every use, never
    // captured: a navigation to another declared origin lands in that origin's
    // own browser context (core/host.ts, Tab), so the page in view can change
    // under an act, and the settle and after-state must follow it. Anything
    // exposing `page` and `cdp` getters will do — a bare { page, cdp } pair
    // still constructs one.
    // `documentLedger` is optional for the same reason: a bare pair still
    // constructs one, and an `expect.navigation` then falls back to the
    // address bar. Through the host it reads the SERVED address — the document
    // behind documentEpoch, not the route the page drew (core/host.ts).
    private readonly host: {
      readonly page: Page;
      readonly cdp: CDPSession;
      documentLedger?: () => { servedUrl: string };
    },
    // Browser decisions (dialogs, popups, downloads) recorded by the host; the
    // executor surfaces the ones this act caused. Optional so the executor stays
    // constructible from a bare (page, cdp) pair.
    private readonly drainBrowserEvents: () => BrowserEvent[] = () => [],
    // The ONLY directory an upload may read from, chosen by the runner, default
    // none. This fence is not the model's to lift: its tokens are shaped by
    // untrusted page text, so an upload that accepted a path would be a
    // prompt-injection-driven exfiltration primitive — "attach ~/.ssh/id_rsa and
    // submit" is a sentence a hostile page can put on screen.
    private readonly uploadDir: string | null = null,
    // The document observer `until` polls with (see UntilObserver). The session
    // passes its own capture -> compile path so the condition is judged over the
    // graph the caller's next find would search — never a private DOM query.
    private readonly observe: UntilObserver | null = null,
  ) {}
  private get page(): Page {
    return this.host.page;
  }
  /** The `until` result of the act in flight, set by whichever path ran the
   *  extension and spliced into the effect once, in `act`. */
  private pendingUntil: ActUntilResult | null = null;
  private get cdp(): CDPSession {
    return this.host.cdp;
  }

  /** The wire ledger of the act in flight — armed with the observers below,
   *  stamped when they come off — and every finished act's ledger by actRef, so
   *  `read {target: actRef}` can page through what the act result bounded. */
  private ledger: ReceiptLedger | null = null;
  private readonly receipts = new Map<string, ReceiptLedger>();

  private takeLedger(): ReceiptLedger | null {
    const ledger = this.ledger;
    this.ledger = null;
    return ledger;
  }

  /** One page of an earlier act's receipt, or null when no act minted that ref. */
  receiptPage(actRef: string, cursor: string | null): ReturnType<typeof receiptPage> | null {
    const ledger = this.receipts.get(actRef);
    return ledger === undefined ? null : receiptPage(ledger, cursor);
  }

  /** The URL of the document an earlier act was dispatched on — the page whose
   *  requests that act's receipt reports. null when no act minted the ref. */
  receiptDocumentUrl(actRef: string): string | null {
    return this.receipts.get(actRef)?.documentUrl ?? null;
  }

  async act(
    g: WirGraph,
    req: ActRequest,
    epochNow: () => string,
  ): Promise<ActResult | ActRejection> {
    this.ledger = null;
    this.pendingUntil = null;
    const expect = req.expect ?? null;
    // The text claim needs the document as it stood BEFORE dispatch: "newly
    // present" is a comparison. Read only when declared, so an act that
    // declares nothing pays nothing.
    const textBefore =
      expect?.text !== undefined && expect?.text !== null ? await this.documentText() : null;
    const core = await this.actCore(g, req, epochNow);
    const until = this.pendingUntil;
    this.pendingUntil = null;
    if ('rejected' in core) {
      this.ledger = null;
      return core;
    }
    // ONE splice site for every path — the spine's own, scroll's and upload's.
    // `expect` is confronted below, after the receipt: its `sent` claim reads
    // the ledger, and with `until` declared the ledger spans the extension too.
    const result: ActOutcome =
      until === null ? core : { ...core, effect: { ...core.effect, until } };
    // EVERY delivered act carries a receipt. An act whose spine armed the
    // observers reports what they saw; scroll and upload, which return before
    // the observers exist, say so rather than report an empty window as fact.
    const ledger = this.takeLedger();
    if (ledger !== null) {
      ledger.actRef = result.actRef;
      this.receipts.set(result.actRef, ledger);
    }
    const receipt = ledger === null ? unarmedReceipt(req.action) : receiptFor(ledger);
    if (expect === null) return { ...result, receipt };
    const expectation = await this.confront(
      g,
      req.ref,
      req.action,
      expect,
      ledger,
      textBefore,
      epochNow,
    );
    return { ...result, receipt, effect: { ...result.effect, expectation } };
  }

  /** The declaration against the world after the settle (core/expect.ts). Reads
   *  the same instruments the spine reads — the AX probe, the value readback,
   *  the receipt ledger, the served address — after the act's own verdict is
   *  already decided, so nothing here can move that verdict. */
  private async confront(
    g: WirGraph,
    ref: string,
    action: string,
    expect: ActExpect,
    ledger: ReceiptLedger | null,
    textBefore: string | null,
    epochNow: () => string,
  ): Promise<ActExpectation> {
    const failed: ExpectationFailure[] = [];
    if (expect.text !== undefined && expect.text !== null) {
      const f = checkText(
        expect.text,
        textBefore,
        await this.documentText(),
        epochNow() !== g.epoch,
      );
      if (f !== null) failed.push(f);
    }
    if (expect.state !== undefined && expect.state !== null) {
      failed.push(
        ...checkState(
          expect.state,
          await this.observeTarget(
            g,
            ref,
            epochNow,
            expect.state.value !== undefined && expect.state.value !== null,
          ),
        ),
      );
    }
    if (expect.navigation !== undefined && expect.navigation !== null) {
      const served = this.host.documentLedger?.().servedUrl;
      const f = checkNavigation(
        expect.navigation,
        served !== undefined && served !== '' ? served : this.page.url(),
        this.page.url(),
        g.url,
      );
      if (f !== null) failed.push(f);
    }
    if (expect.sent !== undefined && expect.sent !== null) {
      const f = checkSent(expect.sent, ledger, action);
      if (f !== null) failed.push(f);
    }
    return {
      declared: expect,
      held: failed.length === 0,
      ...(failed.length > 0 ? { failed } : {}),
    };
  }

  /** The target after the act, for `expect.state`. A replaced document has no
   *  node to probe — backend ids belong to the epoch that minted them — and
   *  saying so is the observation. */
  private async observeTarget(
    g: WirGraph,
    ref: string,
    epochNow: () => string,
    wantValue: boolean,
  ): Promise<ObservedState> {
    const none: ObservedState = {
      gone: null,
      checked: null,
      selected: null,
      expanded: null,
      disabled: null,
      value: null,
      selectedLabel: null,
    };
    if (epochNow() !== g.epoch) {
      return {
        ...none,
        gone: 'the document was replaced by this act, so the target no longer exists',
      };
    }
    const node = g.nodes.get(ref);
    if (node === undefined) return { ...none, gone: `ref ${ref} is not in the current document` };
    const probe = await this.axProbe(node.backendNodeId);
    if (probe === null) return { ...none, gone: 'the target is gone from the accessibility tree' };
    const read = wantValue ? await this.readValueAndLabel(node.backendNodeId) : null;
    return {
      gone: null,
      checked: probe.checked,
      selected: probe.selected,
      expanded: probe.expanded,
      disabled: probe.disabled,
      value: read?.value ?? null,
      selectedLabel: read?.label ?? null,
    };
  }

  /** The document's rendered text, main frame — what `expect.text` is judged
   *  on. innerText, so form control values are not in it (they are state, and
   *  `expect.state.value` reads them); null when the page cannot answer. */
  private async documentText(): Promise<string | null> {
    try {
      return await this.page.evaluate(() => document.body?.innerText ?? '');
    } catch {
      return null;
    }
  }

  /** readValue plus, for a <select>, the chosen option's label — the reading a
   *  caller most likely meant when its declared value did not match. */
  private async readValueAndLabel(
    backendNodeId: number,
  ): Promise<{ value: string | null; label: string | null }> {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return { value: null, label: null };
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration:
          'function() { ' +
          'const value = this.isContentEditable ? (this.textContent ?? "") : (this.value ?? null); ' +
          'const opt = this.options && this.selectedIndex >= 0 ? this.options[this.selectedIndex] : null; ' +
          'return { value, label: opt ? (opt.label || opt.text) : null }; }',
        returnByValue: true,
      })) as { result: { value?: { value?: unknown; label?: unknown } } };
      const v = r.result.value;
      return {
        value: typeof v?.value === 'string' ? v.value : null,
        label: typeof v?.label === 'string' ? v.label : null,
      };
    } catch {
      return { value: null, label: null };
    }
  }

  private async actCore(
    g: WirGraph,
    req: ActRequest,
    epochNow: () => string,
  ): Promise<ActOutcome | ActRejection> {
    const node = g.nodes.get(req.ref);
    if (!node) {
      // The ref is not in THIS graph, so there is no name to interpolate — and a
      // repair carrying the literal `<the control's name>` is not a call the
      // caller can make. Name the one that always works. (Found by the
      // regression below, which was aimed at a different site: the repair
      // inventory read this as a deliberate template, and it is one — an
      // unusable template at the moment it fires.)
      return {
        rejected: {
          kind: 'stale_ref',
          reason: `ref ${req.ref} is not in the current document version (${g.epoch})`,
          repair:
            '{"verb":"read"} to re-resolve against the current structure, or ' +
            '{"verb":"find","name":"…"} if you know the control\'s own words',
        },
      };
    }
    // `until` is argument validation, so it is refused BEFORE anything is
    // dispatched: an act that ran and then reported its condition malformed
    // would have moved the page on a call the caller cannot repair and re-issue.
    const until = this.parseUntil(req, g);
    if (until !== null && 'rejected' in until) return until;
    if (req.action === 'select' && (req.value === undefined || req.value === null)) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: "select requires value (the option's visible label)",
          repair: '{"verb":"act","ref":"...","action":"select","value":"<option label>"}',
        },
      };
    }
    let upload: { path: string; name: string } | null = null;
    if (req.action === 'upload') {
      // The fence stays first — it is argument validation, no browser round
      // trip — but the DISPATCH now waits for the revalidation spine below.
      // upload was the one dispatching action that skipped it entirely, and
      // DOM.setFileInputFiles does not honor `disabled`: a disabled file input
      // took the file and this path answered `verified/file_attached` for an
      // attachment the page can never submit (reproduced on both the visible
      // This behavior was verified during testing.
      // This behavior was verified during testing.
      const fenced = this.resolveUpload(req.value, req.ref);
      if ('rejected' in fenced) return fenced;
      upload = fenced;
    }
    if (req.action === 'scroll') {
      // `value` is optional and closed: omitted advances one viewport, "end"
      // goes to the bottom. Anything else is refused rather than guessed at.
      const to = (req.value ?? '').trim().toLowerCase();
      if (to !== '' && to !== 'end') {
        return {
          rejected: {
            kind: 'invalid_args',
            reason: `scroll takes no value (one viewport) or "end" (to the bottom); got ${JSON.stringify(req.value)}`,
            repair: `{"verb":"act","ref":${JSON.stringify(req.ref)},"action":"scroll","value":"end"}`,
          },
        };
      }
      // scroll keeps its early exit, deliberately: its target is a REGION —
      // often the synthetic root (backendNodeId -1), which no AX probe can
      // answer for — and existence is already enforced by the epoch-scoped ref
      // lookup above (a torn-out node has no ref in the current graph to
      // dispatch; measured in the same probe, step 3: stale_ref, nothing
      // scrolled). No wrong verdict was reproducible here, so nothing more is
      // built.
      return await this.scrollContainer(node, to === 'end', until, g);
    }
    if (
      (req.action === 'fill' || req.action === 'type' || req.action === 'key') &&
      (req.value === undefined || req.value === null)
    ) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `${req.action} requires value`,
          repair: `{"verb":"act","ref":"...","action":"${req.action}","value":"<text>"}`,
        },
      };
    }
    // A value that names a chord is a KEY PRESS the caller has aimed at the text
    // channel, and `type` means "replace the content" — so it would select the
    // whole document and insert the literal 9 characters `Control+a`, then report
    // `verified/text_typed`, which is true of the bytes and a lie about the
    // This behavior was verified during testing.
    // `Control+f`, `Control+z`, `Control+h` and `Control+a` into a source file
    // across 9 calls, each answered `verified`
    // This behavior was verified during testing.
    //
    // This keys on the SHAPE OF THE ARGUMENT — `Modifier(+Modifier)*+Key`, whole
    // string — and never on page content, so no matcher is on the path. It is
    // deliberately narrow in both directions: a bare `Escape` is NOT refused
    // (Enter, Tab, Delete, Home, Clear, Select and Help are ordinary English
    // words a page may legitimately ask for), and the literal text `Control+a`
    // remains typeable through `fill`, which the repair names.
    if (req.action === 'type' && looksLikeChord(req.value ?? '')) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason:
            `${JSON.stringify(req.value)} is a key chord, not text; type would REPLACE this ` +
            "control's content with those literal characters",
          repair:
            `{"verb":"act","ref":${JSON.stringify(req.ref)},"action":"key","value":${JSON.stringify(req.value)}} ` +
            'to press it. To type those characters as literal text, use fill.',
        },
      };
    }
    if (req.action === 'key' && parseChord(req.value ?? '') === null) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `${JSON.stringify(req.value)} is not a key this runtime can press`,
          repair:
            'value is a key name or a chord: a single character, or Enter, Escape, Tab, ' +
            'Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, F1-F24, ' +
            'optionally prefixed with Control+, Alt+, Shift+ or Meta+ (e.g. "Control+a").',
        },
      };
    }

    // Revalidate with the browser's own computation (same-computation rule): re-pull
    // AX for this exact backend node and require the minted identity to still hold.
    const probe = await this.axProbe(node.backendNodeId);
    if (probe === null) {
      // A nameless ref cannot be re-resolved by name: `find` requires one of
      // role/name/state and rejects `name: ""` on arrival (find.ts), so the
      // unguarded form hands back a repair that is itself a rejection. The
      // runtime mints nameless refs routinely — a clickable generic div, an icon
      // button with no accname — and 97 of 107 recorded act targets had an empty
      // name. The epoch fence below already branches exactly this way.
      return {
        rejected: {
          kind: 'stale_ref',
          reason: `the node behind ${req.ref} no longer exists`,
          repair:
            node.name !== ''
              ? `{"verb":"find","name":${JSON.stringify(node.name.slice(0, 40))}} to re-resolve`
              : '{"verb":"read"} — this ref was minted nameless, so re-resolve it from the structure',
        },
      };
    }
    // Name drift in EITHER direction, including empty -> named. The old
    // predicate skipped the check entirely for refs minted nameless, so a node
    // that had since acquired a name — the clearest sign the backend id now
    // points at different content — revalidated clean.
    // RAW AX NAME ON BOTH SIDES — the same-computation rule, and the same fix
    // axRole already carries for roles. `node.name` may have come from the
    // compiler's fallback chain (aria-label, then img alt, then
    // name-from-content) or from the post-linkage descendant fold, and
    // getPartialAXTree reports NONE of those back — so comparing the DERIVED name
    // to a raw probe rejects a node that never moved.
    //
    // This behavior was verified during testing.
    // TWICE, and the copy carrying controlId — the field that looks like the
    // stronger identity — was refused with
    //   'minted for name "Private Project access must be granted..." but the node
    //    now reads ""'
    // while documentEpoch and url were unchanged, a fresh find returned that same
    // ref with that same name, and the sibling copy clicked through fine. The
    // prescribed repair ("read and re-resolve — the page moved") could never
    // work. That is the 9-false-stales-in-517 shape axRole was introduced to end.
    if (probe.name !== node.axName) {
      // A name that has gone EMPTY is the signature of a node held out of the
      // accessibility tree rather than replaced — which is what an open modal
      // does to everything behind it. Before blaming the page for moving, ask
      // the browser whether something is simply on top; the recorded cost of
      // getting this wrong is 32 and 36 wasted calls in two episodes
      // This behavior was verified during testing.
      // never work.
      if (probe.name === '') {
        const covered = await this.coveringOverlay(node.backendNodeId);
        if (covered !== null) return { rejected: await this.overlayRejection(g, covered, req) };
      }
      return {
        rejected: {
          kind: 'stale_ref',
          reason: `revalidation failed: ref was minted for name ${JSON.stringify(node.name)} but the node now reads ${JSON.stringify(probe.name)}`,
          repair: '{"verb":"read"} and re-resolve — the page moved',
        },
      };
    }
    // Role drift, compared the browser's computation to the browser's own
    // computation (raw AX both sides) and only where both sides HAVE one:
    // getPartialAXTree reports 'none' for nodes the full tree gave a real role,
    // so a none-tolerant comparison still cost 1 false stale in 517 live act
    // targets while this one cost 0. probe.role was fetched and never used.
    if (roleIsReal(node.axRole) && roleIsReal(probe.role) && probe.role !== node.axRole) {
      return {
        rejected: {
          kind: 'stale_ref',
          reason: `revalidation failed: ref was minted for role ${JSON.stringify(node.axRole)} but the node now reads ${JSON.stringify(probe.role)}`,
          repair: '{"verb":"read"} and re-resolve — the page moved',
        },
      };
    }
    if (probe.disabled) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `target is disabled`,
          repair: 'read the page state; a disabled control cannot be acted on',
        },
      };
    }
    if (req.action === 'upload') {
      // Revalidated like every other dispatching action: the node exists, its
      // identity holds, and it is not disabled where the AX tree can see it.
      // The hidden-input case is re-asked inside uploadFile, where the input
      // the label owns is resolved. Nothing below this point — before-state,
      // actionability, observers — is upload's; setFileInputFiles has no hit
      // point and starts no navigation the settle could wait on.
      const fenced = upload as { path: string; name: string };
      const uploadedAt = Date.now();
      const uploaded = await this.uploadFile(node, fenced.path, fenced.name, req.ref);
      // Attaching arms no network observers (the bytes go nowhere until a
      // submit), so `network` was refused by parseUntil; the document-backed
      // conditions still apply — a picker that renders a preview, a label that
      // changes to the file's name.
      if (until !== null && !('rejected' in uploaded)) {
        this.pendingUntil = await this.awaitUntil(until, {
          target: node,
          g,
          dispatchedAt: uploadedAt,
          wire: null,
        });
      }
      return uploaded;
    }

    // Before-state: captured before dispatch, always.
    const epochBefore = epochNow();
    const urlBefore = this.page.url();
    // Set when a `key` could not focus its target and was delivered to the
    // nearest focusable ancestor instead — the element a person's press would
    // actually reach. Reported in the delta, never silent.
    let redirectedTo: string | null = null;
    let redirectedFrom: string | null = null;
    /** What the delta must say when a key was delivered somewhere else. */
    const redirectNote = (): string =>
      redirectedTo === null
        ? ''
        : ` [${redirectedFrom} cannot take focus; the press was delivered to ` +
          `${redirectedTo}, its nearest focusable ancestor — where a click on it would ` +
          'have put the caret]';
    const valueBefore =
      req.action === 'fill' ||
      req.action === 'select' ||
      req.action === 'type' ||
      req.action === 'key'
        ? await this.readValue(node.backendNodeId)
        : null;
    // key's own target-scoped before-state. A select-all moves NOTHING else: not
    // the value, not the AX state, not necessarily the DOM — the caret and the
    // selection are the whole observable, so without this the one key the
    // artifact earned would always report `no_observable_change_yet`.
    const selectionBefore =
      req.action === 'key' ? await this.readSelection(node.backendNodeId) : null;

    // Actionability: scroll into view, resolve the hit point, require a real box.
    try {
      await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId });
    } catch {
      /* some nodes scroll with their container; the quad check below decides */
    }
    let point = await this.hitPoint(node.backendNodeId);
    // type is focus-addressed, never coordinate-addressed: a virtualized
    // editor's accessibility textarea may render sub-pixel or clipped (the
    // K1 recon flagged the w>=1/h>=1 gate as a risk for exactly this class),
    // and the type path dispatches no mouse events. DOM.focus failing is its
    // typed rejection below.
    // select is VALUE-addressed for the same reason and by the same rule: its
    // dispatch sets the value on the node itself and sends no mouse events, so a
    // picker whose native <select> is painted over by styled markup — an
    // ordinary idiom — must not be refused for want of a hit point it never
    // uses. "no such option" is its typed rejection below.
    // key is focus-addressed for the same reason type is — it dispatches no
    // mouse events, and a virtualized editor's accessibility textarea may render
    // sub-pixel. DOM.focus failing is its typed rejection below.
    if (
      point === null &&
      req.action !== 'type' &&
      req.action !== 'select' &&
      req.action !== 'key'
    ) {
      return {
        rejected: {
          kind: 'stale_ref',
          reason: 'target has no visible box (zero-size or unrendered)',
          repair:
            '{"verb":"read"} — the control may be inside a closed menu; act on its opener first',
        },
      };
    }

    // Would this click actually reach the target? A consent wall, a login modal,
    // or a sticky banner sits ON TOP of a node that remains perfectly valid: the
    // ref resolves, the name matches, the box is real, the click dispatches — and
    // something else receives it. Delivery then looks like success and the effect
    // reads `unknown`, which is the shape that sent two recorded episodes into a
    // This behavior was verified during testing.
    // spiegel.de where a consent IFRAME ate the click while the target stayed
    // fully in the accessibility tree).
    //
    // The question is the browser's to answer, not ours to guess: hit-test the
    // point that will actually be clicked, and accept when the hit composes back
    // to the target — through shadow boundaries and through an activating label,
    // both of which are ordinary ways real controls are built, not overlays.
    // A TRANSIENT layer — a loading indicator by the rules in coveringOverlay,
    // with no dismiss control of its own — is the one overlay that leaves by
    // itself. With `until` declared the caller has said "wait", so the wait
    // happens HERE, before dispatch: the refusal offers exactly this call, and
    // an until judged only after dispatch could never reach a click that is
    // refused before it. Bounded by until's own withinMs, polled at the same
    // cadence; whatever still covers the target at the bound is refused with
    // the wait on record, and a new, non-transient layer is refused as itself.
    let overlayWaitedMs: number | null = null;
    if (req.action === 'click' && point !== null) {
      let covered = await this.coveringOverlay(node.backendNodeId, point);
      if (
        covered !== null &&
        until !== null &&
        covered.root?.transient &&
        (await this.overlayDismiss(g, covered)).length === 0
      ) {
        const bound = until.withinMs ?? UNTIL_DEFAULT_MS;
        const t0 = Date.now();
        while (covered !== null && covered.root?.transient && Date.now() - t0 < bound) {
          await this.page.waitForTimeout(UNTIL_POLL_MS);
          covered = await this.coveringOverlay(node.backendNodeId, point);
        }
        overlayWaitedMs = Date.now() - t0;
      }
      if (covered !== null)
        return { rejected: await this.overlayRejection(g, covered, req, overlayWaitedMs) };
      if (overlayWaitedMs !== null) {
        // The page changed under the wait: the point is re-resolved against
        // the target as it stands now, and a target that no longer has a box
        // is said so rather than clicked where it used to be.
        const again = await this.hitPoint(node.backendNodeId);
        if (again === null) {
          return {
            rejected: {
              kind: 'stale_ref',
              reason: `the loading indicator left the target after ${overlayWaitedMs} ms, but the target has no visible box now (zero-size or unrendered)`,
              repair: '{"verb":"read"} — re-resolve the target against the page as it settled',
            },
          };
        }
        point = again;
      }
    }

    // Observer BEFORE dispatch (docs/vision.md): a navigation that commits after a
    // fixed sleep is invisible otherwise, and the act then reads `unknown` — which
    // This behavior was verified during testing.
    let navigationStarted = false;
    const onNavStart = (): void => {
      navigationStarted = true;
    };
    // The observers go on the session of the page being ACTED ON and come off
    // the same one. Pinned here because `this.cdp` follows the host's active
    // page: a click whose navigation is diverted into another origin's context
    // switches it mid-act, and `off` through the getter would then miss the
    // session the listeners were installed on and leak them for the episode.
    // Every tab has its own session, so the receipt ledger below is armed on
    // whichever tab is in view at dispatch — never only the default one.
    const observed = this.cdp;
    observed.on('Page.frameStartedNavigating', onNavStart);
    observed.on('Page.frameRequestedNavigation', onNavStart);
    // C1 residual: `navigation` alone cannot say whether the browser sent a POST
    // (a mutation-shaped submit) or a GET (a link-follow in different clothes).
    // Observe the main-frame Document request's method live, in the same
    // pre-dispatch window. A POST anywhere in the chain wins: a submit's 302
    // continues as a GET Document request, and the POST is the fact that counts
    // (it is exactly what NetworkEventEvaluator checks).
    // …and the method alone cannot say whether the server ACCEPTED that submit.
    // So track the request itself: which one carried the mutation, what the
    // server answered it, and when the browser was done with it.
    let documentMethod: string | null = null;
    let documentRequestId: string | null = null;
    let documentStatus: number | null = null;
    let documentSettled = false;
    let mainFrameId: string | null = null;
    try {
      const tree = (await observed.send('Page.getFrameTree')) as {
        frameTree: { frame: { id: string } };
      };
      mainFrameId = tree.frameTree.frame.id;
    } catch {
      /* frame filter degrades to accepting any document request */
    }
    // request_committed observers (G2, earned by 452): candidate APPLICATION
    // requests — XHR/Fetch by the browser's own classification, non-GET,
    // same-origin with the page at dispatch — admitted only between dispatch
    // and settle-end (the admission window IS the measured act window, so the
    // G1 false-mint bound applies as derived), each confirmed only by its own
    // 2xx response, correlated by requestId (G1 caveat: responses land late;
    // a request alone proves nothing). Click-only: the arm's blessed scope is
    // "would otherwise read verified dom_mutated" (see the minting site).
    const pageOrigin = ((): string | null => {
      try {
        return new URL(urlBefore).origin;
      } catch {
        return null;
      }
    })();
    let admitCandidates = false;
    // The other half of that admission window, and the reason it is a SEPARATE
    // flag: `admitCandidates` closes the REQUEST side, but a candidate already in
    // flight is confirmed by its RESPONSE, which onResponse below can push into
    // `committed` at any later moment the observers are still installed. The
    // accepted-submit window further down keeps them installed past the settle,
    // so the response side needs its own latch — see the boundary comment there.
    let correlationClosed = false;
    const candidates = new Map<string, { method: string; url: string }>();
    const committed: { method: string; url: string; status: number }[] = [];
    const ledger: ReceiptLedger = {
      actRef: '',
      windowMs: 0,
      entries: [],
      passwordFields: await this.passwordFieldNames(),
      documentUrl: g.url,
    };
    const byRequestId = new Map<string, WireEntry>();
    // Requests the window recorded that the browser has not finished — the set
    // `until.network: "idle"` waits to empty. Keyed like the ledger, so a
    // redirect hop that reuses its requestId stays one open request.
    const open = new Map<string, { method: string; url: string }>();
    // When the wire last moved — a request sent, answered or finished — so
    // "idle for 500 ms" counts from the browser's last event, never from when
    // the caller happened to start looking.
    let lastWireAt = 0;
    let dispatchedAt: number | null = null;
    const ledgerRequest = (ev: {
      type?: string;
      frameId?: string;
      requestId?: string;
      initiator?: { type?: string };
      request?: {
        method?: string;
        url?: string;
        headers?: Record<string, string>;
        postData?: string;
        hasPostData?: boolean;
      };
      redirectResponse?: { status?: number };
    }): void => {
      if (dispatchedAt === null || ev.requestId === undefined) return;
      // A redirect continuation reuses the requestId and carries the previous
      // hop's answer here (see the documentStatus note below); each hop is its
      // own entry, so the 302 and the GET it became both appear.
      const prev = byRequestId.get(ev.requestId);
      if (prev !== undefined && ev.redirectResponse !== undefined && prev.status === null) {
        prev.status = ev.redirectResponse.status ?? null;
      }
      const headers = ev.request?.headers ?? {};
      const ctKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
      const entry: WireEntry = {
        requestId: ev.requestId,
        atMs: Date.now() - dispatchedAt,
        type: (ev.type ?? 'other').toLowerCase(),
        method: ev.request?.method ?? '',
        url: ev.request?.url ?? '',
        frame:
          mainFrameId === null || ev.frameId === undefined
            ? 'unknown'
            : ev.frameId === mainFrameId
              ? 'main'
              : 'child',
        initiator: ev.initiator?.type ?? 'unknown',
        contentType: ctKey === undefined ? null : (headers[ctKey] ?? null),
        postData: ev.request?.postData ?? null,
        postDataWithheld: ev.request?.postData === undefined && ev.request?.hasPostData === true,
        status: null,
        mimeType: null,
        failed: null,
      };
      ledger.entries.push(entry);
      byRequestId.set(ev.requestId, entry);
      open.set(ev.requestId, { method: entry.method, url: entry.url });
      lastWireAt = Date.now();
    };
    const onRequest = (ev: {
      type?: string;
      frameId?: string;
      requestId?: string;
      initiator?: { type?: string };
      request?: {
        method?: string;
        url?: string;
        headers?: Record<string, string>;
        postData?: string;
        hasPostData?: boolean;
      };
      redirectResponse?: { status?: number };
    }): void => {
      ledgerRequest(ev);
      // A redirect continuation REUSES the requestId and carries the previous
      // hop's response here. For a form submit that is the only place the POST's
      // own status ever appears — a hop that redirected never gets its own
      // This behavior was verified during testing.
      // and the wire trace beside it): requestWillBeSent POST /-/update →
      // requestWillBeSent GET /-/blob {redirectResponse 302} → responseReceived
      // 200, all under one requestId. Keyed on the tracked id, which already
      // passed the main-frame filter below.
      if (
        ev.requestId !== undefined &&
        ev.requestId === documentRequestId &&
        ev.redirectResponse !== undefined
      ) {
        documentStatus ??= ev.redirectResponse.status ?? null;
      }
      if (ev.type === 'Document') {
        if (mainFrameId !== null && ev.frameId !== undefined && ev.frameId !== mainFrameId) return;
        const method = ev.request?.method ?? null;
        // The POST is the hop that carries the mutation, so it is the hop whose
        // answer decides; a later GET in the same chain never displaces it.
        if (method === 'POST' && documentMethod !== 'POST') {
          documentMethod = 'POST';
          documentRequestId = ev.requestId ?? null;
          documentStatus = null;
        } else if (documentMethod === null) {
          documentMethod = method;
          documentRequestId = ev.requestId ?? null;
        }
        return;
      }
      if (!admitCandidates || req.action !== 'click') return;
      if (ev.type !== 'XHR' && ev.type !== 'Fetch') return;
      const method = ev.request?.method ?? '';
      if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE')
        return;
      const url = ev.request?.url ?? '';
      try {
        if (
          pageOrigin !== null &&
          new URL(url).origin === pageOrigin &&
          ev.requestId !== undefined
        ) {
          candidates.set(ev.requestId, { method, url });
        }
      } catch {
        /* unparseable URL: not a candidate */
      }
    };
    const onResponse = (ev: {
      requestId?: string;
      response?: { status?: number; mimeType?: string };
    }): void => {
      if (ev.requestId === undefined) return;
      const hop = byRequestId.get(ev.requestId);
      if (hop !== undefined && hop.status === null) {
        hop.status = ev.response?.status ?? null;
        hop.mimeType = ev.response?.mimeType ?? null;
        lastWireAt = Date.now();
      }
      // The document request answered without redirecting — a server that
      // This behavior was verified during testing.
      // POST URL, measured) lands here rather than in the redirect branch.
      if (ev.requestId === documentRequestId) documentStatus ??= ev.response?.status ?? null;
      // THE CORRELATION BOUNDARY. Everything above this line is document
      // OBSERVATION, which the accepted-submit window below needs and which mints
      // nothing on its own. Everything below is `committed`, which does mint:
      // `request_committed` is NOT in LOCAL_ONLY_EVIDENCE (core/session.ts), so it
      // is gate-eligible, and its licence — the G1 pre-registered bound of

      // This behavior was verified during testing.
      // 2xx that lands in the EXTRA window would enlarge exactly the population
      // that bound covers, and would do it invisibly: the act would flip from
      // gate-INELIGIBLE `dom_mutated` to gate-ELIGIBLE `request_committed` purely
      // because the document request was slow. So the span stays what it was.
      if (correlationClosed) return;
      const c = candidates.get(ev.requestId);
      if (c === undefined) return;
      candidates.delete(ev.requestId);
      const status = ev.response?.status ?? 0;
      if (status >= 200 && status < 300) committed.push({ ...c, status });
    };
    // The browser's own "this request is over" — for a redirect chain it fires
    // once, at the end of the last hop, AFTER frameNavigated has committed the
    // new document (measured: frameNavigated +1828 ms, loadingFinished +1838 ms).
    // That makes it the signal the settle can wait on to know the navigation has
    // landed, which is exactly what waitForLoadState could not tell it.
    const onLoadingDone = (ev: {
      requestId?: string;
      errorText?: string;
      canceled?: boolean;
    }): void => {
      if (ev.requestId !== undefined && open.delete(ev.requestId)) lastWireAt = Date.now();
      if (ev.requestId !== undefined && ev.requestId === documentRequestId) documentSettled = true;
      // loadingFailed shares this handler: the browser's own reason a request
      // never completed (net::ERR_BLOCKED_BY_CLIENT from the origin route, a
      // refused connection) is part of the receipt.
      if (ev.requestId !== undefined && ev.errorText !== undefined) {
        const hop = byRequestId.get(ev.requestId);
        if (hop !== undefined)
          hop.failed = `${ev.errorText}${ev.canceled === true ? ' (canceled)' : ''}`;
      }
    };
    // maxPostDataSize: the body arrives WITH requestWillBeSent up to this bound
    // This behavior was verified during testing.
    // the body was withheld rather than showing nothing.
    try {
      await observed.send('Network.enable', { maxPostDataSize: RECEIPT_POST_DATA_BOUND });
    } catch {
      /* method stays unobserved */
    }
    observed.on('Network.requestWillBeSent', onRequest);
    observed.on('Network.responseReceived', onResponse);
    observed.on('Network.loadingFinished', onLoadingDone);
    observed.on('Network.loadingFailed', onLoadingDone);
    // EVERY exit from here on must remove the observers — a rejected act that
    // leaks its listeners accumulates them for the rest of the episode
    // (review finding D: the typed-rejection fix landed without its cleanup half).
    const removeObservers = (): void => {
      // The receipt's window closes when the observers do — whichever exit
      // reached here. Stamped once: a second call must not stretch it.
      if (dispatchedAt !== null && ledger.windowMs === 0)
        ledger.windowMs = Date.now() - dispatchedAt;
      observed.off('Page.frameStartedNavigating', onNavStart);
      observed.off('Page.frameRequestedNavigation', onNavStart);
      observed.off('Network.requestWillBeSent', onRequest);
      observed.off('Network.responseReceived', onResponse);
      observed.off('Network.loadingFinished', onLoadingDone);
      observed.off('Network.loadingFailed', onLoadingDone);
      observed.send('Network.disable').catch(() => undefined);
    };
    // Same-document effects need their own pre-dispatch observer: a click that
    // renders its result elsewhere in the document (menu opens, row appears) is
    // invisible to the target-scoped AX re-probe (defect C2). type arms it too:
    // a virtualized editor renders the typed text OUTSIDE the focused control,
    // so the mutation burst is one of type's two honest change signals.
    // key arms it too, and needs it most: Escape closes a modal, Enter opens a
    // menu, an arrow moves a combobox's active option — every one of those
    // renders AWAY from the focused target, invisible to a target-scoped re-probe.
    // hover joins them because for a hover the counter is often the ONLY witness:
    // a :hover menu or a text swap changes the DOM while the target's own AX name
    // This behavior was verified during testing.
    // the hover target rewrites its text to "Nice hovering!" the instant
    // mouseenter lands, and the act reported `no_observable_change_yet` with
    // "[mutation records unobserved this act]" because the counter was never
    // armed for this action. fill/select/upload/scroll stay out: each already has
    // a direct value or scroll reading that answers for it.
    if (
      req.action === 'click' ||
      req.action === 'type' ||
      req.action === 'key' ||
      req.action === 'hover'
    ) {
      await this.armMutationCounter();
    }
    // Events from before this dispatch belong to earlier causes — drop them so
    // the surfaced set is exactly what THIS act triggered.
    this.drainBrowserEvents();

    // Dispatch-time epoch fence. protocol.md promises "a stale epoch is a typed
    // rejection, not a wrong-target click"; entry-time staleness is already
    // fenced (the ref lookup is epoch-scoped), but staleness arising INSIDE the
    // act was not. Everything below dispatches raw viewport COORDINATES computed
    // from the old document, and there are unfenced awaits between the hit point
    // and here — Page.getFrameTree, Network.enable, armMutationCounter. A
    // document replaced in that window would take the click at whatever now sits
    // at those coordinates, and an interferer's request could then mint bare
    // `navigation`: gate-eligible false proof.
    // (A replacement during scrollIntoViewIfNeeded/hitPoint is already caught
    // earlier as no-box -> stale_ref, and the fill path is guarded by DOM.focus
    // failing. This closes the click path, which had no guard at all.)
    if (epochNow() !== epochBefore) {
      removeObservers();
      return {
        rejected: {
          kind: 'stale_ref',
          reason: `the document was replaced while this act was being prepared (${epochBefore} -> ${epochNow()}); nothing was dispatched`,
          repair:
            node.name !== ''
              ? `{"verb":"find","name":${JSON.stringify(node.name.slice(0, 40))}} to re-resolve against the new document`
              : '{"verb":"read"} — the document was replaced; this ref was minted nameless, so re-resolve it from the new structure',
        },
      };
    }

    // Dispatch — browser-authentic input through the CDP Input domain. Any CDP
    // failure here is a typed rejection: a dead episode teaches the model nothing.
    admitCandidates = true;
    dispatchedAt = Date.now();
    this.ledger = ledger;
    let picked: { ok: boolean; label: string; value: string } | null = null;
    try {
      if (req.action === 'select') {
        // No CDP input primitive exists for a listbox, so use the spec-sanctioned
        // UA value-change path — set the value, then fire input and change
        const outcome = await this.selectByLabel(node.backendNodeId, req.value ?? '');
        if ('notASelect' in outcome || 'options' in outcome || 'probeFailed' in outcome) {
          removeObservers();
          // The old rejection said "no option matching X" and pointed at
          // `read {target}` for the list. Both halves were wrong, in different
          // ways, and a rejection the caller cannot act on is a dead end dressed
          // as guidance.
          if ('probeFailed' in outcome) {
            return {
              rejected: {
                kind: 'invalid_args',
                reason:
                  'the browser did not answer when this control was probed; nothing ' +
                  'was dispatched, and nothing is known about which options it has',
                repair: `{"verb":"act","ref":"${req.ref}","action":"select","value":${JSON.stringify(
                  req.value ?? '',
                )}} to retry`,
              },
            };
          }
          // On a div-based ARIA combobox there are no options at all, so "no
          // option matched" was false every single time.
          if ('notASelect' in outcome) {
            return {
              rejected: {
                kind: 'invalid_args',
                reason:
                  'this control has no <option> elements, so `select` cannot drive it — ' +
                  'it is a scripted widget, not a native listbox',
                repair:
                  `{"verb":"act","ref":"${req.ref}","action":"click"} to open it, ` +
                  'then find and click the choice',
              },
            };
          }
          // A real select, nothing matched. The labels come from the call that
          // just failed to match one, which is the only place they exist.
          const shown = outcome.options;
          const rest = outcome.total - shown.length;
          // What may be promised past the listed labels depends on whether the
          // options are REACHABLE, and the first version of this claimed the gap
          // unconditionally. A collapsed select's options have no layout box, so
          // nothing admits them and no verb lists them. Give the same select a
          // size or `multiple` and a plain read returns all of them — measured at
          // 40 of 40 — so offer that call instead of declaring a gap that is not
          // there.
          const more =
            rest <= 0
              ? ''
              : outcome.reachable
                ? ` (+${rest} more of ${outcome.total}: {"verb":"read","target":"${req.ref}"})`
                : ` (+${rest} more of ${outcome.total}; the runtime cannot list the rest ` +
                  'through a verb — this select is collapsed, and a collapsed option ' +
                  'has no layout box)';
          const listing =
            shown.length === 0
              ? ''
              : ` — available: ${shown.map((o) => JSON.stringify(o)).join(', ')}${more}`;
          return {
            rejected: {
              kind: 'invalid_args',
              reason: `no option matching ${JSON.stringify(req.value)} on this control${listing}`,
              repair:
                shown.length > 0
                  ? `{"verb":"act","ref":"${req.ref}","action":"select","value":"<one of the above>"}`
                  : `{"verb":"act","ref":"${req.ref}","action":"click"} to open it and choose`,
            },
          };
        }
        // Narrowed by the guard above: every non-success shape returned already.
        picked = outcome as { ok: boolean; label: string; value: string };
      } else if (req.action === 'hover') {
        // HOVER is click's first half and nothing more: the pointer moves onto the
        // target and no button is pressed. It exists because a whole class of web
        // UI is reachable no other way — CSS :hover menus, tooltips, and any
        // `mouseenter` listener. Earned by a failing case rather than a hunch
        // This behavior was verified during testing.
        // hover request listens for `mouseenter` on a bare <div>, and with seven
        // actions there was no call that could produce one. `act click` on it
        // returned unknown/no_observable_change_yet and scored nothing.
        //
        // Coordinate-addressed like click, so it takes the same box gate above: a
        // target with no visible box cannot be pointed at, and saying so is better
        // than moving the pointer somewhere arbitrary.
        //
        // What this does NOT do: press, release, or leave. The pointer stays where
        // it was put, exactly as a human's would, and any :hover state it opened
        // remains open for the next act — which is the whole point of a menu.
        const p = point as { x: number; y: number };
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: p.x,
          y: p.y,
          button: 'none',
        });
      } else if (req.action === 'click') {
        // Non-null: the box gate above rejects a null point for every
        // coordinate-addressed action, which click is.
        const p = point as { x: number; y: number };
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: p.x,
          y: p.y,
          button: 'none',
        });
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: p.x,
          y: p.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: p.x,
          y: p.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
      } else {
        // A non-editable target must be a typed rejection, never a thrown protocol
        // This behavior was verified during testing.
        // "Element is not focusable" ended the run at model call 72).
        try {
          await this.cdp.send('DOM.focus', { backendNodeId: node.backendNodeId });
        } catch (e) {
          removeObservers();
          // Same failure, two different truths. A key press is not an edit: what
          // focus buys it is that the event lands ON THIS TARGET, and a target
          // that cannot take focus would silently forward the press to whatever
          // is focused instead — the silent no-op this action exists to remove.
          // DELIVER IT WHERE A PERSON'S PRESS WOULD LAND, rather than refusing and
          // making the caller re-issue.
          //
          // Text and focusability routinely live on different elements — a
          // <div tabindex="0"> wrapping the <p> that carries the words — and `find`
          // matches the page's own words, so it returns the paragraph. Clicking that
          // paragraph focuses the DIV; typing then goes to the DIV. So sending the
          // key to the nearest focusable ancestor is not a guess about intent, it is
          // what the browser itself does with a human's press.
          //
          // The rejection stays for the case with no focusable ancestor at all —
          // there, a press really would go somewhere unrelated, and saying so is the
          // only honest answer.
          //
          // NEVER SILENT: the delta says the target could not take focus and names
          // the element that received the press instead. A substitution the caller
          // cannot see is the over-claim this spine exists to prevent; a
          // substitution it is told about is the browser's own behaviour, reported.
          const focusable =
            req.action === 'key'
              ? await this.focusableAncestorRef(node.backendNodeId, g.byBackendId)
              : null;
          if (req.action === 'key' && focusable !== null) {
            const anc = g.nodes.get(focusable);
            if (anc !== undefined) {
              try {
                await this.cdp.send('DOM.focus', { backendNodeId: anc.backendNodeId });
                redirectedFrom = req.ref;
                redirectedTo = focusable;
              } catch {
                /* the ancestor will not take it either: fall through to the rejection */
              }
            }
          }
          if (redirectedTo === null) {
            return {
              rejected: {
                kind: 'invalid_args',
                reason:
                  req.action === 'key'
                    ? `target cannot take keyboard focus (${String((e as Error).message).slice(0, 80)}), ` +
                      'so a key pressed here would go to whatever is focused instead'
                    : `target is not editable (${String((e as Error).message).slice(0, 80)})`,
                repair:
                  req.action === 'key'
                    ? 'no ancestor of this node can take focus either; {"verb":"find","role":"textbox"}'
                    : '{"verb":"find","role":"textbox"} to locate an editable field',
              },
            };
          }
        }
        if (req.action === 'key') {
          // Real key events, never text. The chord parsed before the spine began,
          // so this cannot fail on the argument. Sequence and codes are
          // This behavior was verified during testing.
          // key down+up carrying the bitmask, modifiers up in reverse, each with
          // its Windows virtual-key code.
          const chord = parseChord(req.value ?? '');
          await pressChord(
            (p) => this.cdp.send('Input.dispatchKeyEvent', p),
            chord as NonNullable<typeof chord>,
          );
        } else if (req.action === 'fill') {
          // A VALUE-SANITIZED input has no text to insert. `input[type=date]` and its
          // relatives hold a structured value behind segmented UI, so insertText
          // This behavior was verified during testing.
          // page: CDP insertText left the field empty, and the act correctly reported
          // contradicted/value_mismatch.
          //
          // The tempting alternative is a trap and is deliberately NOT taken. Sending
          // the digits as key events DOES work — and writes the wrong date: "05151990"
          // produced 1990-12-05, because segment order follows the input's locale,
          // which the runtime cannot know. A mechanism that succeeds while storing
          // something the caller did not ask for is worse than one that fails loudly.
          //
          // So set the value the way the spec defines it. `input[type=date].value` is
          // ISO yyyy-mm-dd per HTML, unambiguous in every locale, and the input/change
          // pair is exactly what the UA fires when a picker commits.
          const sanitized = await this.valueSanitizedType(node.backendNodeId);
          if (sanitized !== null) {
            await this.setStructuredValue(node.backendNodeId, req.value ?? '');
          } else {
            // selectAll then insertText: the UA value-change path — fires input then change
            // This behavior was verified during testing.
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              commands: ['selectAll'],
              key: 'a',
              code: 'KeyA',
            });
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
            });
            await this.cdp.send('Input.insertText', { text: req.value ?? '' });
            // Then the keyup that ends every human keystroke, because a whole class
            // of widget listens for THAT and not for `input`.
            //
            // bootstrap-datepicker parses the field on keyup into its own state and
            // rewrites the field from that state when focus leaves. insertText fires
            // beforeinput/input/change and no key event at all, so the picker's state
            // stayed empty while the field showed the text — and the next click
            // anywhere, including the submit itself, blanked the field. Measured on
            // This behavior was verified during testing.
            // after the very next act. The form could not be completed through the
            // runtime at all, and `fill` had answered verified/value_set.
            //
            // Only the trailing keyup is synthesised, never a keydown: a keydown
            // carrying a character would insert it, and the text is already in place.
            // The key named is the last character typed, which is what a human's
            // final keyup carries.
            const typed = req.value ?? '';
            if (typed.length > 0) {
              const last = typed[typed.length - 1] as string;
              await this.cdp.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: last,
                text: last,
              });
            }
          }
        } else {
          // type — replace the content through the PAGE's keyboard layer. Earned
          // This behavior was verified during testing.
          // This behavior was verified during testing.
          // This behavior was verified during testing.
          // a virtualized editor's textarea is a paged window, so the renderer
          // `selectAll` command selects only the window and insertText splices —
          // the platform select-all CHORD instead reaches the page's keybinding
          // layer, which selects the whole model.
          const modifiers = process.platform === 'darwin' ? 4 /* Meta */ : 2; /* Ctrl */
          await this.cdp.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers,
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          });
          await this.cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers,
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          });
          await this.page.waitForTimeout(150);
          // Engagement check, mechanical: did anything select? A raw chord is not
          // handled natively on every platform (measured: Ctrl+A selects nothing
          // here), and a plain input has no keybinding layer — fall back to the
          // renderer's own selectAll, fill's proven mechanism, so `type` means
          // "replace the content" on every editable target, never insert-at-caret.
          const sel = await this.readSelection(node.backendNodeId);
          if (sel === null || sel.start === sel.end) {
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              commands: ['selectAll'],
              key: 'a',
              code: 'KeyA',
            });
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
            });
          }
          await this.cdp.send('Input.insertText', { text: req.value ?? '' });
          // Caret-to-end cleanup, measured necessary: the editor's a11y-selection
          // -> model mapping deterministically missed the document's FINAL char
          // (stable under re-application — not timing). Mechanically: after a
          // whole-content replace the caret must sit at the very end of the
          // field's value; characters the window reports after the collapsed
          // caret are residue; forward-delete until caret==end, bounded. On a
          // clean replace the caret lands at end and this never fires.
          // FLAGGED, then measured: a column-sliced a11y window under no-wrap
          // could make this gap rule delete real characters. Phase 2 measured
          // both wrap modes on the live editor (probe
          // This behavior was verified during testing.
          // the gap is exactly the 1-char residue, and one delete removes the
          // residue only. One recorded space-padded window (failed10 442 act
          // line 94) remains an unexplained transient with no observed
          // correctness impact — if a future artifact shows the slice for
          // real, re-measure before trusting this loop there.
          for (let i = 0; i < 5; i++) {
            await this.page.waitForTimeout(250);
            const s = await this.readSelection(node.backendNodeId);
            if (s === null || !(s.start === s.end && s.end < s.len)) break;
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Delete',
              code: 'Delete',
              windowsVirtualKeyCode: 46,
            });
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Delete',
              code: 'Delete',
              windowsVirtualKeyCode: 46,
            });
          }
        }
      }
    } catch (e) {
      removeObservers();
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `dispatch failed: ${String((e as Error).message).slice(0, 120)}`,
          repair: '{"verb":"read"} — re-resolve the target and try again',
        },
      };
    }
    const actRef = `a_${++this.counter}`;

    // Settle: a short window for same-tick effects, then — only if a navigation
    // actually started — wait for it to commit against a real budget instead of
    // guessing. Non-navigating clicks stay fast; a POST that commits at 600 ms or
    // 3 s now verifies instead of reading `unknown`.
    await this.page.waitForTimeout(400);
    if (navigationStarted || epochNow() !== epochBefore) {
      await this.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
      await this.page.waitForTimeout(150); // let the epoch listener observe the commit
    }
    // Candidate admission closes with the settle window — the G1 bound was
    // derived over exactly this span. The bounded waits below only correlate
    // RESPONSES for requests already in flight; they admit nothing new.
    admitCandidates = false;
    // The main-frame Document request this act started may still be OPEN: the
    // server has not answered, so neither the epoch nor the URL has moved and
    // the classification below would read `unknown` on a submit that is about to
    // This behavior was verified during testing.
    // commit, it answers for the document that is CURRENTLY committed (the old
    // one, already loaded) and returns in ~0 ms while the POST is still in
    // flight, so the act judged the page 1.1 s before the commit arrived
    // This behavior was verified during testing.
    // frameNavigated +1641 ms → unknown/no_observable_change_yet on a commit
    // that succeeded). Wait for the browser to finish the request instead.
    //
    // The bound exists because an act may not hang an episode: 10 s clears the
    // slowest commit observed headed (≈4.3 s to loadingFinished) by better than
    // 2x and stays under the 15 s navigation budget above, so the settle is
    // never the act's dominant cost. It elapses in full only when the request is
    // never answered — and an act that waited and still saw nothing reports an
    // honest `unknown`, which is the correct outcome for an unanswered submit.
    // Clicks that start no document request skip this entirely.
    //
    // SAMPLED TWICE, AGAINST ONE BUDGET. The first sample can be too early to see
    // a request that exists: a page whose XHR success handler reloads it issues no
    // Document request until that response lands, and the correlation wait below
    // This behavior was verified during testing.
    // This behavior was verified during testing.
    // offsets from script start): POST xhr /api/v4/projects/183/invitations +4880,
    // 201 +5340, reload GET document +5342, 200 +6130. At the first sample
    // (≈ +5263) documentRequestId was still null, so this was skipped; the 1.5 s
    // correlation wait then released on the 201 at ≈ +5340 — by which time the
    // reload HAD been issued, and nothing looked again. The act classified a
    // document that was being replaced under it and returned
    // `unknown / no_observable_change_yet`, after `name="(gone)"`, while the
    // oracle (page.evaluate, no WIR) showed the member added. Four recorded
    // This behavior was verified during testing.
    //
    // ONE deadline spans both samples so an act can never spend 2x10 s here.
    // What this does NOT claim: nothing is reclassified, no evidence string is
    // added, and no verdict is promoted by this wait. It only lets the existing
    // navigation branch observe a replacement it was already entitled to observe
    // — and `navigation_get`, what this flow then reports, is local-only evidence
    // (core/session.ts LOCAL_ONLY_EVIDENCE), so no act becomes gate-eligible that
    // was not before and the G1 false-mint bound is untouched.
    const documentDeadline = Date.now() + 10_000;
    const settleDocumentRequest = async (): Promise<void> => {
      if (documentRequestId === null || documentSettled) return;
      while (Date.now() < documentDeadline && !documentSettled) await this.page.waitForTimeout(50);
      // Let the epoch listener observe the commit, as after the load wait above.
      if (documentSettled) await this.page.waitForTimeout(150);
    };
    await settleDocumentRequest();
    if (
      req.action === 'click' &&
      candidates.size > 0 &&
      committed.length === 0 &&
      !navigationStarted &&
      epochNow() === epochBefore
    ) {
      // NOT WIDENED, AND THE REASON IS A PRE-REGISTERED BOUND, NOT TIMIDITY.
      // This behavior was verified during testing.
      // (addComment, xhr, same-origin) was sent at +3870 ms and answered 200 at
      // +6533 — 2,663 ms after dispatch and 738 ms AFTER the act had already
      // returned. So 1,500 ms is demonstrably too short, `request_committed` was
      // never minted, the whole delta was the spinner ("Please wait..."), and an
      // episode whose only site change is an ajax submit meets the MUTATE gate
      // with an EMPTY ledger. Defect D1, real and reproduced.
      //
      // The obvious repair — raise this to ~6 s — is exactly what the boundary
      // comment above forbids. `request_committed` is gate-ELIGIBLE, and its
      // licence is the G1 pre-registered bound of 0.0313 expected false
      // This behavior was verified during testing.
      // derived over THIS window. Waiting longer does not admit new candidates —
      // admitCandidates already closed — but it does enlarge the span in which an
      // ambient same-origin non-GET 2xx can be credited to the act, which is
      // precisely the population that bound covers.
      //
      // The decision rule says re-derive before widening. I tried:
      // This behavior was verified during testing.
      // and the archive returns "no analyzable episodes" — its quality bounds
      // reject the whole current corpus, and its two known-truth sanity gates
      // This behavior was verified during testing.
      // join. The oracle is not runnable, so the bound cannot be re-derived, so
      // the window does not move. A gate you cannot measure is not a gate you may
      // widen by assertion.
      //
      // TO FIX THIS PROPERLY: run an agent-seat arm that produces joinable
      // artifacts, re-derive G1 over the wider window, and widen only if the
      // bound holds. Until then D1 stands, documented, and the honest cost is
      // that ajax-only mutations still reach the gate with a thin ledger.
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline && committed.length === 0 && candidates.size > 0) {
        await this.page.waitForTimeout(100);
      }
    }
    await settleDocumentRequest();

    // Verify the postcondition against the live page.
    let epochAfter = epochNow();
    let urlAfter = this.page.url();

    // THE BOUND ABOVE STOPPED THE RUNTIME LOOKING; IT NEVER STOPPED THE ACT
    // WAITING. Measured on this defect's own reproduction (a submit whose 302
    // arrives at 13.0 s, against the 10.55 s settle): the observers came off and
    // the verdict was written at 10.55 s — and the act then blocked 2,437 ms
    // inside the AX probe further down, returning at 13.1 s with the new
    // document committed, the new URL live, `landing` compiled off the new page,
    // and `unknown / no_observable_change_yet`, delta `name="(gone)"`. The single
    // response contradicted itself: its own envelope carried the post-commit
    // epoch. Field shape identical — multisite-671 recorded act ms of 11,008,
    // 12,012, 14,198, 14,239, 14,674, 14,678, 14,688, 14,786 against the same
    // 10.55 s bound; every one of those submits had been answered 302 in
    // 597–938 ms (network.har), 12 finish rejections followed, 6 episodes scored
    // 0 on a mutation the server had already accepted.
    //
    // So spend one more BOUNDED window here, with the DOCUMENT observers still
    // installed, rather than discarding the observation the act is about to make
    // anyway. 5 s: the slowest main-frame document in the recorded corpus finished
    // This behavior was verified during testing.
    // which 10 s + 5 s clears — the 10 s bound was under-provisioned for the
    // measured distribution and the act was silently paying the difference inside
    // a probe. Cost owned, not hidden: a document request that is NEVER answered
    // now holds the act 5 s longer than before (15.55 s of settle, not 10.55 s).
    //
    // This is a FRESH bound, not a second helping of the one above: the two
    // samples of settleDocumentRequest share `documentDeadline` precisely so an
    // act cannot spend 2x10 s there, and for the shape this window exists for the
    // second sample finds that budget already spent and returns at once. The two
    // fixes are independent — that one moves the SAMPLING POINT inside the old
    // span, this one EXTENDS the span — and both are needed.
    //
    // Entered ONLY when nothing has moved yet. That scope is what keeps this out
    // of every act that already has a navigation to classify: it can turn a
    // "nothing observed" reading into an observed one and nothing else.
    // PER ACT, "contradicted can never become success" holds by construction: an
    // act that reads `contradicted` has already moved when sampled, so it never
    // enters this window, and the href branch requires `navigated` while this
    // requires epoch AND url unmoved — mutually exclusive.
    //
    // AS A CLASS CLAIM IT WOULD BE OVERSTATED, and the honest version is worth
    // stating where the code is. All 53 recorded `contradicted/navigated_elsewhere`
    // acts are FAST; the whole premise of this change is that a render can take
    // 10-13 s. The same page shape reads `contradicted` when its POST commits fast
    // and `verified navigation_post` when it does not commit inside the act — which
    // is exactly what CONTROL 4 in test/accepted-submit-slow-render.test.ts pins.
    // Concretely: the 9 recorded failed-login 302s cited below would mint
    // `verified` rather than `contradicted` on a slow enough site. That is a real
    // widening of what counts as accepted, owned here rather than discovered later.
    //
    // What this does NOT claim: that the act caused the navigation it now sees.
    // It claims only that the runtime is reading the same document its own delta
    // and landing overview are read from.
    if (
      documentRequestId !== null &&
      !documentSettled &&
      epochAfter === epochBefore &&
      stripFragment(urlAfter) === stripFragment(urlBefore)
    ) {
      // Close the correlation boundary BEFORE the window opens: the observers stay
      // on for the document, and for the document only. See onResponse above for
      // why `committed` may not grow past the span the G1 bound was derived over.
      correlationClosed = true;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !documentSettled && epochNow() === epochBefore) {
        await this.page.waitForTimeout(50);
      }
      // Let the epoch listener observe the commit, as after the waits above.
      if (documentSettled || epochNow() !== epochBefore) await this.page.waitForTimeout(150);
      epochAfter = epochNow();
      urlAfter = this.page.url();
    }
    // THE `until` EXTENSION, with the observers still on. It sits here, after
    // every settle window the spine owns and before the observers come off, so
    // that (a) the receipt's window and the network-idle condition read ONE
    // ledger, and (b) the verdict below is classified from the page as it stands
    // when the condition holds — an effect that lands at 800 ms is then the
    // act's observed effect, not a mutation the caller must re-read for.
    // The correlation boundary closes FIRST: `request_committed` is
    // gate-eligible and its G1 licence was derived over the un-extended span
    // (see onResponse), so a 2xx that lands inside the extension may appear in
    // the receipt and may never mint evidence.
    if (until !== null) {
      correlationClosed = true;
      this.pendingUntil = await this.awaitUntil(until, {
        target: node,
        g,
        dispatchedAt: dispatchedAt as number,
        wire: {
          open,
          lastAt: () => Math.max(lastWireAt, dispatchedAt as number),
          recorded: () => ledger.entries.length,
        },
      });
      if (overlayWaitedMs !== null) {
        // The pre-dispatch wait is part of what `until` did; say so where the
        // caller reads what until saw.
        this.pendingUntil = {
          ...this.pendingUntil,
          observed: `the covering loading indicator left the target after ${overlayWaitedMs} ms of waiting before dispatch; ${this.pendingUntil.observed}`,
        };
      }
      epochAfter = epochNow();
      urlAfter = this.page.url();
    }
    removeObservers();

    // The server's own answer to the submit, for the two navigation branches
    // below. A form submit is ACCEPTED with 2xx (answered in place) or 3xx
    // This behavior was verified during testing.
    // This behavior was verified during testing.
    // answers a bad CSRF token with 422 and navigates to the error page, and the
    // repository is unchanged (measured) — so without this the act mints
    // gate-eligible `verified navigation_post` for a mutation that never
    // happened, which is the false-verified class ADR-003 exists to prevent.
    //
    // Scoped to POST deliberately: navigation_post is the only gate-eligible one
    // of the three, and nothing measured justifies changing what a GET
    // navigation reports — a link-follow that lands on a 404 still navigated.
    //
    // Owned limit, measured, not papered over: status separates refusals that
    // This behavior was verified during testing.
    // with 200 and re-renders the form; the repo is unchanged yet this still
    // reads accepted. Separating that needs the page's error text, i.e. a
    // semantic matcher on the critical path — banned (docs/vision.md). This is
    // the pre-existing exposure, narrowed, never widened.
    const submitRefused =
      documentMethod === 'POST' && documentStatus !== null && documentStatus >= 400;
    const statusNote =
      documentStatus === null
        ? ''
        : ` [${documentMethod ?? 'document'} request answered ${documentStatus}]`;
    // The reason a refused submit's `unknown` cannot be told from here, shared
    // by the four navigation gates exactly as submitRefused itself is. Spread
    // into the effect so a verified navigation gains zero bytes.
    const refusedReason = submitRefused
      ? {
          reason:
            `the server answered this submit's POST ${documentStatus} — a refusal: ` +
            'the navigation is real, but the requested change cannot be claimed from it',
        }
      : {};

    // …and the same fact read the other way: THE ANSWER DECIDES, NOT THE RENDER.
    // A submit whose POST the server answered 2xx/3xx has been accepted — that
    // is decided in under a second (multisite-671: 597–938 ms) and is exactly

    // finished FETCHING AND PAINTING the resulting page is a different question
    // with a different clock (the same episodes: 10,182–13,804 ms for the
    // redirected GET), and it was the one deciding the verdict. It should never
    // have been: an act that waited out both windows above and still holds an
    // accepted-but-uncommitted submit knows the submit landed.
    //
    // Every conjunct is load-bearing:
    //   documentMethod === 'POST' — PUT/PATCH/DELETE are NOT included. 0 of 400
    //     recorded Document non-GET requests used them (HTML forms cannot), so
    //     that surface is unearned.
    //   documentStatus !== null — a request whose answer was never observed is
    //     the honest `unknown` the comment above describes. Never promoted.
    //   < 400 — 4xx/5xx is submitRefused, untouched, above.
    //   !documentSettled — the request is still IN FLIGHT, which is what makes
    //     "not rendered yet" the right reading. If the browser FINISHED it and
    //     nothing committed, there is no page coming and the act keeps
    //     withholding (a 302 to a 204 is the reproducible case; pinned in
    //     test/accepted-submit-slow-render.test.ts). Owned limit, measured, NOT
    //     the class this excludes: the recorded POST -> 302 -> host-that-never-

    //     commits its own error document, so the epoch moves and the
    //     pre-existing navigation branch mints them exactly as it does today,
    //     before and after this change alike. Nor is a destination still hanging
    //     when both windows elapse separable from a slow one here; it mints.
    //   epoch unmoved — if it moved, the navigation branches already own this.
    //
    // Pre-registered scope, and what it does NOT claim. It does not claim the
    // mutation is the one the caller wanted: 2xx/3xx cannot separate an accepted
    // submit from a refused one that redirects to a login page (measured on

    // endpoint). That exposure is PRE-EXISTING and unchanged — today's navigation
    // branch mints gate-eligible navigation_post on exactly those bounced POSTs
    // the moment the login page commits; this only removes the render's veto over
    // acts that were slower. The G1 false-mint bound does NOT cover this arm — G1

    // corpus (72 episodes, 715 acts, 18 Document POSTs) measures the ambient —
    // i.e. act-unattributed — Document-POST rate at 0 on all three origins, so
    // E[false mints] = 0.0000/episode; that number was computed AFTER seeing the
    // data and is therefore NOT pre-registered. Re-deriving it G1-style before a
    // scored arm is owner work, recorded here rather than assumed away.
    const submitAccepted =
      documentMethod === 'POST' &&
      documentStatus !== null &&
      documentStatus < 400 &&
      !documentSettled &&
      epochAfter === epochBefore;
    // The delta must not imply the caller is looking at the result. Same shape as
    // the key path's mutation note: append the call that settles it.
    const pendingNote = submitAccepted
      ? ' [the server ACCEPTED this submit; the resulting document had not committed when the ' +
        'settle elapsed, so the page here is still the previous one — {"verb":"read"} to see ' +
        'where it landed]'
      : '';

    if (req.action === 'select') {
      // A change handler is page code, and page code navigates. `<select>` that
      // moves the document on change is the dominant idiom in a store's toolbar:
      // observed on a product listing toolbar where the change handler sets
      // location.href — a main-frame Document GET answered 200 inside the act
      // window, epoch E03E85CA… -> C3EFDCA1…, while this path returned
      // `verified option_selected` with `after: value=null`, a value read off a
      // node the navigation had already destroyed. The verb was built to the
      // exact contour of the non-navigating pickers that earned it (611/618),
      // and skipped the spine that would have seen this.
      //
      // A document-level outcome outranks the value window — same guard shape as
      // type and click: movement plus a proven replacement or an observed
      // Document request, never a bare method observation, so a pushState-only
      // change (no bytes to the server) still falls through to the value branch.
      // Nothing is reclassified here: navigation_get stays local-only, and a
      // select that submits a POST form reaches navigation_post through the
      // shared machinery rather than a select-specific rule.
      const chosen = picked as { ok: boolean; label: string; value: string };
      const selectNavigated =
        epochAfter !== epochBefore || stripFragment(urlAfter) !== stripFragment(urlBefore);
      // `|| submitAccepted` — the shared decoupling, applied at all four gates
      // rather than at click alone. The predicate here is the SAME boolean
      // expression as type's, key's and click's, downstream of the SAME
      // action-agnostic settle, so a fix at one site leaves three racing on the
      // same clock. Only click has ever fired it in the field (0 recorded
      // select/type/key acts within 9.5 s of the bound, 0 select/type/key
      // navigation_post of any latency), so this is structural exposure closed,
      // not a measured failure repaired — stated so nobody reads it as evidence.
      if (
        (selectNavigated || submitAccepted) &&
        (epochAfter !== epochBefore || documentMethod !== null)
      ) {
        const evidence: EffectEvidence =
          documentMethod === 'POST'
            ? 'navigation_post'
            : documentMethod !== null
              ? 'navigation_get'
              : 'navigation';
        // Which option matched still travels: select-by-label is substring-
        // generous, so "Price" may have landed on "Price: high to low" and the
        // model has no other way to learn which.
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: submitRefused ? 'unknown' : 'verified',
            evidence,
            ...refusedReason,
            delta: {
              before: urlBefore,
              after: `${urlAfter} [selected ${JSON.stringify(chosen.label)}]${statusNote}${pendingNote}${this.drainEventNote()}`,
            },
          },
        };
      }
      const valueAfter = await this.readValue(node.backendNodeId);
      // THE VERDICT READS THE SETTLED PAGE, NOT THE DISPATCH. `chosen.ok` is
      // `this.value === opt.value` at WRITE time, inside selectByLabel — and a
      // page that accepts the change event then reverts the control during the
      // settle (a controlled select rejecting the change, a validator resetting
      // an unavailable option) made this path mint `verified/option_selected`
      // while the same response's delta printed the reverted value (reproduced:
      // This behavior was verified during testing.
      // longer reverts since the prototype-setter fix, so the condition needed
      // one fixture). Same ordering as fill: the readback AFTER the settle
      // decides. An unreadable readback keeps the write-time answer — the
      // pre-existing behaviour for that case, neither widened nor narrowed.
      const held = valueAfter !== null ? valueAfter === chosen.value : chosen.ok;
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: held ? 'verified' : 'contradicted',
          evidence: held ? 'option_selected' : 'selection_mismatch',
          delta: {
            before: `value=${JSON.stringify(valueBefore)}`,
            after:
              `value=${JSON.stringify(valueAfter)} label=${JSON.stringify(chosen.label)}` +
              (!held && chosen.ok
                ? ` [the write landed at dispatch (value=${JSON.stringify(chosen.value)}) and the page reverted it during the settle]`
                : '') +
              this.drainEventNote(),
          },
        },
      };
    }

    if (req.action === 'fill') {
      // An input handler is page code, and page code navigates. Search-as-you-
      // type is the ordinary shape: the page submits on `input`, the document is
      // replaced during the settle, and the readback below then reads value=null
      // off the destroyed node — `contradicted/value_mismatch` in the same
      // response that attaches the NEW page's landing (reproduced:
      // This behavior was verified during testing.
      // guard for its change handler; fill was the last value path without it.
      // A document-level outcome outranks the value window — same guard shape as
      // select, type, key and click: movement plus a proven replacement or an
      // observed Document request, never a bare method observation.
      // `|| submitAccepted`: see the select gate for why all the gates move together.
      const fillNavigated =
        epochAfter !== epochBefore || stripFragment(urlAfter) !== stripFragment(urlBefore);
      if (
        (fillNavigated || submitAccepted) &&
        (epochAfter !== epochBefore || documentMethod !== null)
      ) {
        const evidence: EffectEvidence =
          documentMethod === 'POST'
            ? 'navigation_post'
            : documentMethod !== null
              ? 'navigation_get'
              : 'navigation';
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: submitRefused ? 'unknown' : 'verified',
            evidence,
            ...refusedReason,
            delta: {
              before: urlBefore,
              after: urlAfter + statusNote + pendingNote + this.drainEventNote(),
            },
          },
        };
      }
      const valueAfter = await this.readValue(node.backendNodeId);
      const requested = req.value ?? '';
      const ok = valueAfter === requested;
      // THE COMPARATOR RULE, stated as a constraint. Byte equality alone minted
      // `contradicted/value_mismatch` on every value-normalizing input: a mask
      // or formatter rewrites the text as it arrives, so the readback differs
      // in dressing while carrying the same characters. Measured on the live
      // This behavior was verified during testing.
      // read back "4111 1111 1111 1111", "19900115" read back "1990-01-15",
      // "1234567" read back "1,234,567" — three correct writes, three
      // contradicted. The codebase fixed this exact class twice before: type
      // This behavior was verified during testing.
      // tolerates server-added params.
      //
      // The rule, exactly:
      //   - byte equality                                  -> verified/value_set;
      //   - a readback that is the request with non-alphanumeric characters
      //     INSERTED and nothing else — every observed formatter added its
      //     dressing (spaces, dashes, separators) and removed nothing — with at
      //     least one letter or digit to compare            -> verified, and the
      //     delta carries BOTH strings verbatim;
      //   - anything else — dropped, truncated, substituted -> contradicted,
      //     exactly as today.
      // Insertions ONLY, never deletions — and this is measured, not caution:
      // bare stripped-form equality verified a windowed editor's readback (the
      // request minus its tail — same letters, a corrupted document; the pin in
      // test/editor-typing.test.ts caught the widening). A character of the
      // request that the field dropped, even a newline, is content lost, never
      // dressing. Alphanumeric is \p{L}\p{N}, any script — an ASCII class would
      // read all non-Latin content as dressing. NEVER verified when the
      // stripped forms differ (insertions-only implies stripped equality by
      // construction), and never on an empty stripped form: a comparison with
      // no content left proves nothing (the probe's step 4, a mask dropping
      // every character, must stay contradicted).
      const reformatted =
        !ok &&
        valueAfter !== null &&
        strippedOfFormatting(requested) !== '' &&
        isReformattingOf(requested, valueAfter);
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: ok || reformatted ? 'verified' : 'contradicted',
          evidence: ok || reformatted ? 'value_set' : 'value_mismatch',
          delta: {
            before: `value=${JSON.stringify(valueBefore)}`,
            after:
              `value=${JSON.stringify(valueAfter)}` +
              (reformatted
                ? ` [the field reformatted ${JSON.stringify(requested)} — same characters, its own dressing]`
                : '') +
              this.drainEventNote(),
          },
        },
      };
    }

    if (req.action === 'type') {
      // Keys and inserted text can run page handlers that navigate — the reason
      // type runs the full observer/fence/settle spine, as select and click do.
      // A document-level outcome outranks the value window (same guard shape as
      // the click path below: movement plus a proven replacement or an observed
      // Document request, never a bare method observation).
      // `|| submitAccepted`: see the select gate for why all four move together.
      const typeNavigated =
        epochAfter !== epochBefore || stripFragment(urlAfter) !== stripFragment(urlBefore);
      if (
        (typeNavigated || submitAccepted) &&
        (epochAfter !== epochBefore || documentMethod !== null)
      ) {
        const evidence: EffectEvidence =
          documentMethod === 'POST'
            ? 'navigation_post'
            : documentMethod !== null
              ? 'navigation_get'
              : 'navigation';
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: submitRefused ? 'unknown' : 'verified',
            evidence,
            ...refusedReason,
            delta: {
              before: urlBefore,
              after: urlAfter + statusNote + pendingNote + this.drainEventNote(),
            },
          },
        };
      }
      const valueAfter = await this.readValue(node.backendNodeId);
      const mutations = await this.readMutationCount();
      // verified requires the TARGET-SCOPED signal: the readable window moved.
      // The mutations-only arm that once stood beside it minted a false
      // verified in the field on its first episode
      // This behavior was verified during testing.
      // byte-identical before/after windows, 4 ambient mutation records,
      // verdict verified — a modal focus-trap had swallowed the input
      // entirely; mechanism reproduced end-to-end through this dispatch path
      // This behavior was verified during testing.
      // are still REPORTED in the delta, but alone they mint only `unknown` —
      // absence of a target-scoped observation is not proof of typing.
      // Never `contradicted`: on a virtualized editor the readable value is a
      // paged WINDOW, so inequality with the payload is the expected state of a
      // This behavior was verified during testing.
      // on a correct mechanism). The comparison here is change-detection only;
      // the deltas are labelled as windows and claim no completeness.
      const windowChanged = valueAfter !== valueBefore;
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: windowChanged ? 'verified' : 'unknown',
          evidence: windowChanged ? 'text_typed' : 'no_observable_change_yet',
          ...(windowChanged
            ? {}
            : {
                reason:
                  'the readable window did not move' +
                  (mutations === null
                    ? ', and mutation records were unobserved this act'
                    : mutations > 0
                      ? `; ${mutations} mutation records were observed but cannot be attributed to this act`
                      : ', and 0 mutation records followed the dispatch'),
              }),
          delta: {
            before: `window=${JSON.stringify(valueBefore)}`,
            after: `window=${JSON.stringify(valueAfter)} mutationRecords=${mutations === null ? 'unobserved' : String(mutations)}${this.drainEventNote()}`,
          },
        },
      };
    }

    if (req.action === 'key') {
      // Navigation outranks everything local, same guard shape as type, select
      // and click: movement PLUS a proven replacement or an observed Document
      // request, never a bare method observation. Enter in a search field is the
      // ordinary way this fires.
      // `|| submitAccepted`: see the select gate for why all four move together.
      // This fires AHEAD of the target_state_changed arm below, the one
      // gate-eligible local fallback on this path — deliberate: an accepted
      // submit outranks the old document's AX state, and the arm is untouched
      // for every act that starts no document request.
      const keyNavigated =
        epochAfter !== epochBefore || stripFragment(urlAfter) !== stripFragment(urlBefore);
      if (
        (keyNavigated || submitAccepted) &&
        (epochAfter !== epochBefore || documentMethod !== null)
      ) {
        const evidence: EffectEvidence =
          documentMethod === 'POST'
            ? 'navigation_post'
            : documentMethod !== null
              ? 'navigation_get'
              : 'navigation';
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: submitRefused ? 'unknown' : 'verified',
            evidence,
            ...refusedReason,
            delta: {
              before: urlBefore,
              after: urlAfter + statusNote + pendingNote + this.drainEventNote(),
            },
          },
        };
      }
      const selAfter = await this.readSelection(node.backendNodeId);
      const valueAfter = await this.readValue(node.backendNodeId);
      const mutations = await this.readMutationCount();
      const after = await this.axProbe(node.backendNodeId);
      // "of 383" reads as a DOCUMENT length and is not one — it is the length of
      // the value we can read. On a virtualized editor that is a sliding window
      // over the file, and it resizes when the caret moves with no edit at all.
      // Measured: a model was told `of 383` for a 2.16 KiB file (the page states
      // the real size in its own text), believed it, and spent the episode trying
      // to reconstruct a file six times smaller than it is
      // This behavior was verified during testing.
      const describeSel = (s: { start: number; end: number; len: number } | null): string =>
        s === null ? 'unreadable' : `${s.start}..${s.end} of ${s.len} readable`;
      const before = `selection=${describeSel(selectionBefore)} window=${JSON.stringify(valueBefore)}`;
      const seen =
        `selection=${describeSel(selAfter)} window=${JSON.stringify(valueAfter)} ` +
        `mutationRecords=${mutations === null ? 'unobserved' : String(mutations)}` +
        this.drainEventNote();
      // Ordered most target-scoped first. The AX state is what the PAGE
      // committed (a toggled control, an expanded combobox), so it outranks a
      // caret that merely moved; a caret or a selection that moved is still the
      // target's own state, so it outranks ambient mutation records.
      if (after !== null && (after.name !== probe.name || after.expanded !== probe.expanded)) {
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: 'verified',
            evidence: 'target_state_changed',
            delta: {
              before: `name=${JSON.stringify(probe.name)} expanded=${String(probe.expanded)} ${before}`,
              after: `name=${JSON.stringify(after.name)} expanded=${String(after.expanded)} ${seen}`,
            },
          },
        };
      }
      // A CHANGE IN LENGTH IS NOT A CHANGE IN SELECTION, and reporting it as one
      // This behavior was verified during testing.
      // This behavior was verified during testing.
      // believed was find-and-replace, the window went 383 -> 382 characters
      // ("<!DOCTYPE html>" -> "!DOCTYPE html>"), and this branch answered
      // `verified/selection_changed`. The model was told its caret moved while
      // the file lost a character — the same lie `type` told when it reported
      // `verified/text_typed` after replacing a document with the literal string
      // `Control+a`. Length is checked FIRST because it is the stronger fact:
      // Backspace and Delete shrink the value without moving the caret's start,
      // and an input's value change fires no MutationObserver record at all, so
      // this is their only witness.
      const lenBefore = selectionBefore?.len ?? null;
      const lenAfter = selAfter?.len ?? null;
      if (lenBefore !== null && lenAfter !== null && lenAfter !== lenBefore) {
        // Report the OBSERVED quantity, never an inference about the document.
        // The earlier wording ("content GREW by 55 characters") was false on the
        // very first field episode: Control+h deleted one character while Monaco
        // re-rendered its accessibility window from 383 to 438, and the model
        // repeated our number back and discarded its work. A readable window can
        // change size without the content changing at all, so the only honest
        // claim is about the window.
        const direction =
          `readable window ${lenBefore} -> ${lenAfter} characters ` +
          '(a window can resize without the content changing)';
        // LOCAL, like text_typed: editing a buffer proves the browser holds the
        // text, never that the site changed (LOCAL_ONLY_EVIDENCE, session.ts).
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: 'verified',
            evidence: 'text_edited',
            delta: { before, after: `${seen} [${direction}]${redirectNote()}` },
          },
        };
      }
      const selMoved =
        selectionBefore !== null &&
        selAfter !== null &&
        (selAfter.start !== selectionBefore.start || selAfter.end !== selectionBefore.end);
      if (selMoved) {
        // LOCAL, always: where a caret sits proves the browser's state and
        // nothing about the site (see LOCAL_ONLY_EVIDENCE in core/session.ts).
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: 'verified',
            evidence: 'selection_changed',
            delta: { before, after: `${seen}${redirectNote()}` },
          },
        };
      }
      // NO mutations-only `verified` arm, and the omission is measured, not
      // cautious. `type` lost its identical arm after it minted a false
      // verified in the field, and this probe reproduced the trap on the very
      // This behavior was verified during testing.
      // selection whatever (the platform chord there is Meta+a, macOS) and
      // still collected mutation records from the editor's ambient rendering —
      // `verified/dom_mutated` for a keystroke the editor ignored
      // This behavior was verified during testing.
      //
      // So an unhandled key reads `unknown`, and that is the whole point: a
      // model told plainly that nothing happened tries the other chord, which
      // is the runtime owning proof and the model owning meaning. A `verified`
      // there would send it on believing the page had moved. Mutation records
      // still travel in the delta — reported, never promoted.
      //
      // The verdict and the evidence string both stay, and both are right. What
      // was missing is that the caller ACTS on the string and never reads the
      // This behavior was verified during testing.
      // presses read `no_observable_change_yet` while their own delta carried
      // `mutationRecords=321` and `=110`, the graph then grew 306 -> 351 nodes,
      // and a driver with unlimited calls concluded the route was impossible and
      // This behavior was verified during testing.
      //
      // So append the call that settles it — nothing more. Note what this does
      // NOT say: that the key caused those records. It cannot. This page may be
      // churning on a timer (test/key-action.test.ts pins exactly that case), and
      // separating act-caused mutation from ambient mutation needs a pre-dispatch
      // baseline the spine does not take. Claiming causation without one would be
      // the same over-claim this comment block already exists to prevent.
      const mutated = mutations !== null && mutations > 0;
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: 'unknown',
          evidence: 'no_observable_change_yet',
          reason:
            'nothing the target owns moved — state, selection and window are all unchanged' +
            (mutations === null
              ? ', and mutation records were unobserved this act'
              : mutated
                ? `; ${mutations} mutation records were observed but cannot be attributed to this act`
                : ', and 0 mutation records followed the dispatch'),
          delta: {
            before,
            after:
              (mutated
                ? `${seen} [nothing the TARGET owns moved; records were observed but ` +
                  'cannot be attributed to this act — {"verb":"read"} to see the page as it ' +
                  'now stands]'
                : seen) + redirectNote(),
          },
        },
      };
    }

    // click. A fragment-only href (`#`, `#menu`) declares no destination — it is a
    // styling idiom for toggles (the Forums dropdown, 37 recorded unknowns). It gets
    // the same-document check, never URL verification: sameOriginPath ignores
    // fragments, so a missed preventDefault would otherwise read `verified
    // navigated_to_destination` off a toggle — a false proof of the C1 class.
    const hrefNavigational = node.href !== null && !fragmentOnly(node.href, urlBefore);
    const navigated =
      epochAfter !== epochBefore || stripFragment(urlAfter) !== stripFragment(urlBefore);
    // Hoisted from below (it used to be declared after the href branch returned).
    // The note built from it at the bottom of this function could therefore never
    // reach a LINK click — the exact case where it matters most.
    const documentReplaced = epochAfter !== epochBefore;
    // What the browser decided during this act (dialogs answered by policy,
    // popups, downloads) — surfaced, never swallowed (defect C3).
    const events = this.drainBrowserEvents();
    const eventNote = events.length > 0 ? ` [${events.map((e) => e.description).join('; ')}]` : '';
    // A URL that moved with the document NOT replaced is a client-side route: the
    // address changed and no document was ever served. Reported wherever it is
    // true, not only on the same-document path.
    //
    // This behavior was verified during testing.
    // result moved the URL from /search?query=... to /way/154257484 with
    // documentEpoch IDENTICAL either side, and the act said
    // `verdict: verified, evidence: navigated_to_destination` with nothing at all
    // about the document. The runtime computed this fact and dropped it.
    //
    // This behavior was verified during testing.
    // out of gate arithmetic — navigated_to_destination is already LOCAL_ONLY
    // (core/session.ts:765), so such a click never minted gate-eligible proof and
    // still does not.
    const clientSideRouteNote =
      navigated && !documentReplaced
        ? ' [no document was loaded — client-side route: the address moved without a ' +
          'document request]'
        : '';

    if (navigated && hrefNavigational) {
      // A link with a known destination: URL verification uses normalized
      // origin+path and tolerates server-added params (the false-contradicted scar).
      const ok = sameOriginPath(node.href as string, urlAfter);
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: ok ? 'verified' : urlAfter === urlBefore ? 'unknown' : 'contradicted',
          evidence: ok ? 'navigated_to_destination' : 'navigated_elsewhere',
          ...(ok || urlAfter !== urlBefore
            ? {}
            : {
                reason:
                  'the document was replaced but the URL never moved — a same-URL reload, ' +
                  "not this link's declared destination, so the follow cannot be confirmed",
              }),
          delta: { before: urlBefore, after: urlAfter + eventNote + clientSideRouteNote },
        },
      };
    }
    // Review finding B1: a history.pushState route changes the URL with NO
    // document replacement (epoch unchanged) and NO Document request — zero
    // bytes reach the server. That must never mint gate-eligible `navigation`:
    // it falls through to the same-document checks below. Note what that means
    // precisely, because the original comment overstated it: such a click lands
    // on dom_mutated (local-only, correctly ineligible) OR on
    // target_state_changed, which IS gate-eligible — deliberately, by
    // measurement. 10 passing vote tasks submit via XHR, invisible as a Document
    // request, and would otherwise be false-rejected (next-level.md:97). The
    // accepted trade-off, owned here in writing: a zero-network click that flips
    // its own control's AX state can mint gate-eligible proof. Real navigations
    // still prove themselves by a loaderId change or an observed Document
    // request.
    // (`documentReplaced` is declared once, above the href branch, so the
    // client-side-route note can reach a link click.)
    // `|| submitAccepted` sits HERE and nowhere above. Placement is the whole
    // safety argument, and it was measured: the href branch at the top of this
    // block owns 53 recorded `contradicted/navigated_elsewhere` acts, 42 of them
    // in episodes holding an accepted Document POST — a wishlist add whose 302
    // lands on the wishlist index, a login POST whose 302 lands back on the login
    // page. A relaxation placed above it converts all 53 to `verified`, nine of
    // them failed logins, and breaks "contradicted can never become success"
    // outright. Placed here it cannot reach them: submitAccepted requires the
    // epoch and URL to be UNMOVED, and every one of those 53 has moved.
    if ((navigated || submitAccepted) && (documentReplaced || documentMethod !== null)) {
      // Method observed → say which kind of navigation this was. `navigation`
      // itself remains only for the unobserved-method residual (named, rare).
      const evidence: EffectEvidence =
        documentMethod === 'POST'
          ? 'navigation_post'
          : documentMethod !== null
            ? 'navigation_get'
            : 'navigation';
      // Evidence still NAMES what was seen — a POST navigation did happen — and
      // only the verdict drops on a refusal. The model learns the submit was
      // rejected and by which status (the delta), while the finish gate, which
      // admits `verified` alone, cannot spend it as proof of a change.
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: submitRefused ? 'unknown' : 'verified',
          evidence,
          ...refusedReason,
          delta: { before: urlBefore, after: urlAfter + statusNote + pendingNote + eventNote },
        },
      };
    }
    const urlNote =
      navigated && !documentReplaced
        ? ` [url moved to ${urlAfter} without document replacement — client-side route]`
        : '';
    // No navigation: a dialog answered by policy is the dominant fact — the model
    // must learn its guarded effect was decided for it, not observe `unknown`.
    const dialog = events.find((e) => e.kind === 'dialog');
    if (dialog) {
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: 'unknown',
          evidence: dialog.action === 'accepted' ? 'dialog_accepted' : 'dialog_dismissed',
          reason:
            `a native dialog was ${dialog.action} by policy, so the effect it guarded ` +
            'was decided for the page, never observed by this act',
          delta: {
            before: dialog.description,
            after: 'the guarded effect was decided by policy, not observed',
          },
        },
      };
    }
    const download = events.find((e) => e.kind === 'download');
    if (download) {
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: 'verified',
          evidence: 'download_started',
          delta: { before: urlBefore, after: download.description },
        },
      };
    }
    const popup = events.find((e) => e.kind === 'popup');
    if (popup) {
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: 'verified',
          evidence: 'popup_opened',
          delta: { before: urlBefore, after: popup.description },
        },
      };
    }
    // Same document — for EVERY node, href or not (defect C2: the early return for
    // href nodes made this check unreachable for links, 25.6% of acts unknown).
    // First the target's own AX state (expanded, pressed, name)…
    const after = await this.axProbe(node.backendNodeId);
    // Every AX state the target owns, not just two of them. A checkbox flips
    // `checked` and nothing else; a toggle button flips `pressed`. Comparing only
    // name and expanded reported `no_observable_change_yet` on both.
    const stateChanged =
      after !== null &&
      (after.name !== probe.name ||
        after.expanded !== probe.expanded ||
        after.checked !== probe.checked ||
        after.pressed !== probe.pressed ||
        after.selected !== probe.selected);
    if (stateChanged) {
      // Name only the states that EXIST on this control, so a checkbox's delta
      // reads about checkedness rather than dragging four nulls behind it.
      const describe = (p: AXProbe | null): string =>
        p === null
          ? '(gone)'
          : [
              `name=${JSON.stringify(p.name)}`,
              p.expanded !== null ? `expanded=${String(p.expanded)}` : '',
              p.checked !== null ? `checked=${p.checked}` : '',
              p.pressed !== null ? `pressed=${p.pressed}` : '',
              p.selected !== null ? `selected=${p.selected}` : '',
            ]
              .filter((x) => x !== '')
              .join(' ');
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: 'verified',
          evidence: 'target_state_changed',
          delta: { before: describe(probe), after: `${describe(after)}${urlNote}` },
        },
      };
    }
    // …then the document at large: the pre-dispatch mutation counter witnesses
    // effects that land away from the target. A DOM change is a client-side fact —
    // it verifies the act had an effect, never that a site mutation happened
    // (the gate classifies dom_mutated as local-only evidence).
    const digest = await this.readMutationDigest();
    const mutations = digest?.n ?? null;
    // The page's own words for what changed. Without this the delta is a count,
    // and a bounced form submit is indistinguishable from a silent one.
    const saidNote =
      digest && digest.appeared.length > 0
        ? `; now showing: ${digest.appeared.map((t) => JSON.stringify(t)).join(', ')}`
        : '';
    if (mutations !== null && mutations > 0) {
      // request_committed (G2, earned by 452): the click's local rendering was
      // accompanied by a same-origin non-GET APPLICATION request that returned
      // 2xx inside this act's window — the AJAX-submit class whose only other
      // honest evidence is local-only dom_mutated. Gate-eligible: the G1
      // pre-registered rule passed (worst-origin expected false mints
      // This behavior was verified during testing.
      // Scope is exactly the blessed population — "would otherwise read
      // verified dom_mutated": the re-derived bound for any wider scope FAILS
      // This behavior was verified during testing.
      // Owned, measured limits: a read-via-POST (GraphQL) inside the window
      // mints this arm too — not mechanically separable, no URL heuristics
      // This behavior was verified during testing.
      if (committed.length > 0) {
        const c = committed[0]!;
        const cu = ((): string => {
          try {
            const u = new URL(c.url);
            return u.origin + u.pathname;
          } catch {
            return c.url;
          }
        })();
        return {
          actRef,
          outcome: 'delivered',
          effect: {
            verdict: 'verified',
            evidence: 'request_committed',
            delta: {
              before: 'document unchanged',
              after: `${c.method} ${cu} -> ${c.status} observed in this act's window; ${mutations} mutation records${urlNote}${eventNote}`,
            },
          },
        };
      }
      return {
        actRef,
        outcome: 'delivered',
        effect: {
          verdict: 'verified',
          evidence: 'dom_mutated',
          delta: {
            before: 'document unchanged',
            after: `${mutations} mutation records after dispatch${urlNote}${saidNote}`,
          },
        },
      };
    }
    // `null` from the counter is "the runtime could not look" — window.__wirMut
    // went with a document that was replaced under it — which is NOT the fact
    // "no records were seen". The branch above conflates the two by construction
    // (`mutations !== null && mutations > 0`), and this return is where the
    // conflation is spent: it tells the model nothing changed while holding no
    // evidence either way. Measured on the same live invite click
    // (readMutationCount -> null at +6242 ms, above). Say which of the two
    // happened, in the coverage-gap spirit the graph applies everywhere else.
    // This is a transparency note only: no verdict and no evidence string moves.
    const unobservedNote =
      mutations === null
        ? ' [mutation records unobserved this act — absence of change is not established]'
        : '';
    // …and the second, independent of it: if a Document POST WAS answered and no
    // document ever committed, the status is a fact the model is otherwise never
    // told on this path, and "no observable change" is a poor way to report a
    // submit the server answered 422.
    //
    // What this note does NOT mean, said plainly because an earlier draft of this
    // fix asserted the opposite in its comment and named the variable
    // `refusalNote`: reaching here does NOT prove the server refused. An ACCEPTED
    // 302 reaches it too — measured on this fix's own reproduction, a POST
    // answered 302 whose destination answers 204: the browser FINISHES the
    // request without committing anything, `documentSettled` goes true, so
    // submitAccepted is false by its `!documentSettled` conjunct and the act
    // falls all the way through to here and emits this note with status 302
    // (pinned: test/accepted-submit-slow-render.test.ts CONTROL 2 asserts the
    // exact string on an ACCEPTED submit). The emitted text has always been
    // neutral — it reports the answer and says no document committed, both true
    // in either case — and it is unchanged; only the claim about it was wrong.
    //
    // The verdict is untouched either way: refusals stay `unknown`, submitRefused
    // is unchanged, and an accepted-but-uncommitted POST is not promoted by a
    // transparency note.
    const postAnswerNote =
      documentMethod === 'POST' && documentStatus !== null
        ? ` [the submit's POST was answered ${documentStatus}; no new document committed]`
        : '';
    return {
      actRef,
      outcome: 'delivered',
      effect: {
        verdict: 'unknown',
        evidence: node.href !== null ? 'no_navigation_observed' : 'no_observable_change_yet',
        // Every observer this act armed, and what each answered. Mutations can
        // only be 0 or unobserved here — a positive count minted above — which
        // is also why the `committed` clause exists: an application POST
        // answered 2xx with zero mutations cannot reach the request_committed
        // arm (it requires a positive count), so this reason was the one place
        // the answered submit could be said, and it said nothing (reproduced:

        // click and the inert click carried byte-identical reasons).
        // Transparency only: no verdict and no evidence string moves.
        reason: [
          navigated
            ? 'the URL moved with no document replacement (client-side route)'
            : navigationStarted
              ? 'a navigation started but no document committed'
              : 'no navigation started',
          documentMethod === null
            ? 'no document request was seen'
            : documentStatus === null
              ? `a ${documentMethod} document request was seen but its answer was not`
              : `the ${documentMethod} document request was answered ${documentStatus} and no new document committed`,
          ...(committed.length > 0
            ? [
                ((c: { method: string; url: string; status: number }): string => {
                  const cu = ((): string => {
                    try {
                      const u = new URL(c.url);
                      return u.origin + u.pathname;
                    } catch {
                      return c.url;
                    }
                  })();
                  return (
                    `an application ${c.method} to ${cu} was answered ${c.status} in this act's window, ` +
                    'yet nothing changed on the page'
                  );
                })(committed[0]!),
              ]
            : []),
          after === null
            ? 'the target itself is gone from the accessibility tree'
            : "the target's own state did not change",
          mutations === null
            ? 'mutation records were unobserved this act'
            : '0 mutation records followed the dispatch',
        ].join('; '),
        delta: {
          before: `name=${JSON.stringify(probe.name)} expanded=${String(probe.expanded)}`,
          after: `name=${JSON.stringify(after?.name ?? '(gone)')} expanded=${String(after?.expanded ?? null)}${unobservedNote}${postAnswerNote}`,
        },
      },
    };
  }

  /** Validate `until` before anything is dispatched. Null when absent; the
   *  parsed condition; or a typed rejection whose repair is the corrected call.
   *  Closed keys, exactly one condition, the bound inside its range, and the
   *  condition possible for THIS action and THIS executor — never a guess. */
  private parseUntil(req: ActRequest, g: WirGraph): ActUntil | ActRejection | null {
    const raw = req.until;
    if (raw === undefined || raw === null) return null;
    const call = (until: unknown): string =>
      JSON.stringify({
        verb: 'act',
        ref: req.ref,
        action: req.action,
        ...(req.value === undefined || req.value === null ? {} : { value: req.value }),
        ...(req.expect === undefined || req.expect === null ? {} : { expect: req.expect }),
        until,
      });
    const bad = (reason: string, fixed: unknown): ActRejection => ({
      rejected: { kind: 'invalid_args', reason: `until: ${reason}`, repair: call(fixed) },
    });
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return bad('must be an object with exactly one of text, gone, role, state, network', {
        text: '<words that must appear>',
      });
    }
    const r = raw as Record<string, unknown>;
    const CONDITIONS = ['text', 'gone', 'role', 'state', 'network'] as const;
    const unknown = Object.keys(r).filter(
      (k) => !(CONDITIONS as readonly string[]).includes(k) && k !== 'withinMs',
    );
    if (unknown.length > 0) {
      const kept: Record<string, unknown> = {};
      for (const k of [...CONDITIONS, 'withinMs']) if (r[k] !== undefined) kept[k] = r[k];
      return bad(
        `unknown key${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — accepted: text, gone, role, state, network, withinMs`,
        Object.keys(kept).length > 0 ? kept : { text: '<words that must appear>' },
      );
    }
    const present = CONDITIONS.filter((k) => r[k] !== undefined && r[k] !== null);
    if (present.length !== 1) {
      const first = present[0];
      return bad(
        present.length === 0
          ? 'needs exactly one of text, gone, role, state, network'
          : `carries ${present.length} conditions (${present.join(', ')}); exactly one is allowed`,
        first === undefined
          ? { text: '<words that must appear>' }
          : {
              [first]: r[first],
              ...(r['withinMs'] !== undefined ? { withinMs: r['withinMs'] } : {}),
            },
      );
    }
    const key = present[0] as (typeof CONDITIONS)[number];
    const out: ActUntil = {};
    const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    if (key === 'text' || key === 'gone') {
      if (!nonEmpty(r[key]))
        return bad(`${key} must be a non-empty string — the page's own words`, {
          [key]: '<words>',
        });
      if (this.observe === null)
        return bad(`${key} needs the document observer this executor was built without`, {});
      out[key] = r[key] as string;
    } else if (key === 'role') {
      const v = r['role'];
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return bad('role must be {role, name?}', {
          role: { role: typeof v === 'string' ? v : '<role>' },
        });
      }
      const ro = v as Record<string, unknown>;
      const strays = Object.keys(ro).filter((k) => k !== 'role' && k !== 'name');
      if (
        strays.length > 0 ||
        !nonEmpty(ro['role']) ||
        (ro['name'] !== undefined && typeof ro['name'] !== 'string')
      ) {
        return bad('role must be {role: "<role>", name?: "<name substring>"}', {
          role: { role: nonEmpty(ro['role']) ? ro['role'] : '<role>' },
        });
      }
      if (this.observe === null)
        return bad('role needs the document observer this executor was built without', {});
      out.role = {
        role: ro['role'] as string,
        ...(nonEmpty(ro['name']) ? { name: ro['name'] as string } : {}),
      };
    } else if (key === 'state') {
      const v = r['state'];
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return bad('state must be {ref?, checked?, selected?, expanded?, disabled?, value?}', {
          state: { checked: true },
        });
      }
      const st = v as Record<string, unknown>;
      const BOOLS = ['checked', 'selected', 'expanded', 'disabled'] as const;
      const strays = Object.keys(st).filter(
        (k) => k !== 'ref' && k !== 'value' && !(BOOLS as readonly string[]).includes(k),
      );
      if (strays.length > 0)
        return bad(
          `state: unknown key${strays.length > 1 ? 's' : ''} ${strays.join(', ')} — accepted: ref, checked, selected, expanded, disabled, value`,
          { state: { checked: true } },
        );
      const parsed: NonNullable<ActUntil['state']> = {};
      for (const b of BOOLS) {
        if (st[b] === undefined) continue;
        if (typeof st[b] !== 'boolean')
          return bad(`state.${b} must be a boolean`, { state: { [b]: true } });
        parsed[b] = st[b] as boolean;
      }
      if (st['value'] !== undefined) {
        if (typeof st['value'] !== 'string')
          return bad('state.value must be a string', { state: { value: '<text>' } });
        parsed.value = st['value'];
      }
      if (Object.keys(parsed).length === 0)
        return bad(
          'state names no state — give one of checked, selected, expanded, disabled, value',
          { state: { checked: true } },
        );
      if (st['ref'] !== undefined) {
        if (typeof st['ref'] !== 'string')
          return bad('state.ref must be a node ref', { state: parsed });
        if (!g.nodes.has(st['ref'])) {
          return bad(
            `state.ref ${st['ref']} is not in the current document version (${g.epoch}); omit ref to watch the act's own target`,
            { state: parsed },
          );
        }
        parsed.ref = st['ref'];
      }
      out.state = parsed;
    } else {
      if (r['network'] !== 'idle')
        return bad('network takes the single value "idle"', { network: 'idle' });
      if (req.action === 'scroll' || req.action === 'upload') {
        return bad(
          `${req.action} installs no network observers (its receipt is unarmed), so network:"idle" cannot be judged — use text, gone or role`,
          { text: '<words that must appear>' },
        );
      }
      out.network = 'idle';
    }
    const w = r['withinMs'];
    if (w !== undefined && w !== null) {
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > UNTIL_MAX_MS) {
        return bad(
          `withinMs must be a number of milliseconds from 1 to ${UNTIL_MAX_MS} (default ${UNTIL_DEFAULT_MS})`,
          {
            ...out,
            withinMs: typeof w === 'number' && w > UNTIL_MAX_MS ? UNTIL_MAX_MS : UNTIL_DEFAULT_MS,
          },
        );
      }
      out.withinMs = Math.round(w);
    }
    return out;
  }

  /** Extend the settle until `until` holds or its bound elapses. Polls, never
   *  sleeps: the cheap signal (mutation token / AX probe / open-request set) is
   *  sampled every UNTIL_POLL_MS, and the document is recompiled — through the
   *  same capture -> compile path a read takes — only when the token has moved,
   *  never faster than the last compile took, and at most UNTIL_RECOMPILE_CAP
   *  times. `observed` always says what the last check saw, and the accounting. */
  private async awaitUntil(
    until: ActUntil,
    ctx: {
      target: WirNode;
      g: WirGraph;
      dispatchedAt: number;
      /** This act's open requests and the wire's last event, or null for an
       *  action that arms no observers. */
      wire: {
        open: Map<string, { method: string; url: string }>;
        lastAt: () => number;
        recorded: () => number;
      } | null;
      /** Called each poll before the signal is sampled (scroll's nudge). */
      onPoll?: () => Promise<void>;
    },
  ): Promise<ActUntilResult> {
    const withinMs = until.withinMs ?? UNTIL_DEFAULT_MS;
    const deadline = Date.now() + withinMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const stamp = (verdict: ActUntilResult['verdict'], observed: string): ActUntilResult => ({
      declared: until,
      verdict,
      afterMs: Date.now() - ctx.dispatchedAt,
      observed,
    });
    const pause = async (ms: number): Promise<void> => {
      const n = Math.min(ms, remaining());
      if (n > 0) await this.page.waitForTimeout(n);
    };
    const short = (v: string): string => JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v);

    if (until.network === 'idle') {
      const { open, lastAt, recorded } = ctx.wire as NonNullable<typeof ctx.wire>;
      const seen = (): string => {
        const n = recorded();
        return `${n} request${n === 1 ? '' : 's'} recorded since dispatch`;
      };
      for (;;) {
        if (ctx.onPoll) await ctx.onPoll();
        // Quiet is measured from the wire's LAST event (or the dispatch), so a
        // settle that was already silent pays only the remainder of 500 ms.
        const quietMs = open.size === 0 ? Date.now() - lastAt() : 0;
        if (open.size === 0 && quietMs >= UNTIL_IDLE_MS) {
          return stamp(
            'condition_met',
            `no request of this act's window in flight, quiet since +${lastAt() - ctx.dispatchedAt} ms (${seen()})`,
          );
        }
        if (remaining() === 0) {
          if (open.size === 0) {
            return stamp(
              'timed_out',
              `no request in flight at the bound, but the wire had been quiet only ${quietMs} ms of the ${UNTIL_IDLE_MS} required (${seen()})`,
            );
          }
          const listed = [...open.values()].slice(0, 5).map((o) => `${o.method} ${o.url}`);
          return stamp(
            'timed_out',
            `${open.size} request${open.size === 1 ? '' : 's'} of this act's window still in flight at the bound: ` +
              `${listed.join(', ')}${open.size > listed.length ? ` (+${open.size - listed.length} more)` : ''}`,
          );
        }
        await pause(50);
      }
    }

    if (until.state !== undefined) {
      const want = until.state;
      const watched =
        want.ref !== undefined ? (ctx.g.nodes.get(want.ref) ?? ctx.target) : ctx.target;
      const label = want.ref !== undefined ? want.ref : `the target ${ctx.target.ref}`;
      const wanted = Object.entries(want)
        .filter(([k]) => k !== 'ref')
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      for (;;) {
        if (ctx.onPoll) await ctx.onPoll();
        // The browser's own computation on both sides, as revalidation does —
        // the AX tree for the states it owns, the control itself for its value.
        const probe = await this.axProbe(watched.backendNodeId);
        const value = want.value !== undefined ? await this.readValue(watched.backendNodeId) : null;
        const holds: string[] = [];
        const differs: string[] = [];
        const judge = (k: string, actual: string, ok: boolean): void => {
          (ok ? holds : differs).push(`${k}=${actual}`);
        };
        if (probe === null) {
          differs.push('the node is gone from the accessibility tree');
        } else {
          if (want.checked !== undefined)
            judge('checked', String(probe.checked), probe.checked === String(want.checked));
          if (want.selected !== undefined)
            judge('selected', String(probe.selected), probe.selected === String(want.selected));
          if (want.expanded !== undefined)
            judge('expanded', String(probe.expanded), probe.expanded === want.expanded);
          if (want.disabled !== undefined)
            judge('disabled', String(probe.disabled), probe.disabled === want.disabled);
          if (want.value !== undefined) judge('value', JSON.stringify(value), value === want.value);
        }
        const seen = [...holds, ...differs].join(' ');
        if (probe !== null && differs.length === 0) {
          return stamp('condition_met', `${label} now reads ${seen}`);
        }
        if (remaining() === 0) {
          return stamp('timed_out', `${label} reads ${seen} at the bound; wanted ${wanted}`);
        }
        await pause(UNTIL_POLL_MS);
      }
    }

    // text / gone / role: judged over the graph the caller's next find would
    // search, compiled through the observer the session lent this executor.
    const observe = this.observe as UntilObserver; // parseUntil refused these without it
    const needle =
      until.text !== undefined
        ? normalize(until.text)
        : until.gone !== undefined
          ? normalize(until.gone)
          : until.role?.name !== undefined
            ? normalize(until.role.name)
            : null;
    const hay = (n: WirNode): string =>
      `${normalize(n.name)} ${normalize(n.text)} ${normalize(n.description ?? '')}`;
    const describe = (n: WirNode): string =>
      `${n.ref} (${n.role}${n.name !== '' ? ` ${short(n.name)}` : n.text !== '' ? ` ${short(n.text)}` : ''})`;
    /** met, and what the check saw either way. */
    const check = (g: WirGraph): { met: boolean; observed: string } => {
      const nodes = [...g.nodes.values()];
      if (until.role !== undefined) {
        const role = until.role.role;
        const hits = nodes.filter(
          (n) => n.role === role && (needle === null || hay(n).includes(needle)),
        );
        if (hits.length > 0)
          return {
            met: true,
            observed: `matched ${describe(hits[0]!)}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`,
          };
        const roleOnly = nodes.filter((n) => n.role === role).length;
        return {
          met: false,
          observed:
            `no rendered ${role}${needle === null ? '' : ` carrying ${short(until.role.name as string)}`} among ${nodes.length} nodes` +
            (needle !== null && roleOnly > 0
              ? ` (${roleOnly} ${role}${roleOnly === 1 ? '' : 's'} with other names)`
              : ''),
        };
      }
      const hits = nodes.filter((n) => hay(n).includes(needle as string));
      if (until.text !== undefined) {
        if (hits.length > 0)
          return {
            met: true,
            observed: `matched ${describe(hits[0]!)}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`,
          };
        // Present but not rendered is a different fact from absent, and the
        // graph already accounts for it (unrendered candidates).
        const hidden = g.unrendered.candidates.filter((c) =>
          normalize(c.text).includes(needle as string),
        );
        return {
          met: false,
          observed:
            `${short(until.text)} in none of ${nodes.length} rendered nodes (name, text or description)` +
            (hidden.length > 0
              ? `; present but unrendered in ${hidden.length} node${hidden.length === 1 ? '' : 's'} under ${hidden[0]!.containerRef}`
              : ''),
        };
      }
      // gone
      if (hits.length === 0)
        return {
          met: true,
          observed: `no rendered node carries ${short(until.gone as string)} (${nodes.length} nodes)`,
        };
      const listed = hits.slice(0, 3).map(describe);
      return {
        met: false,
        observed: `still present: ${listed.join(', ')}${hits.length > listed.length ? ` (+${hits.length - listed.length} more)` : ''}`,
      };
    };
    let recompiles = 0;
    let lastCompileMs = 0;
    let lastToken: string | null = null;
    let last: { met: boolean; observed: string } | null = null;
    let compileFailed: string | null = null;
    const accounting = (): string =>
      `; ${recompiles} recompile${recompiles === 1 ? '' : 's'} of at most ${UNTIL_RECOMPILE_CAP}` +
      (compileFailed !== null ? ` (last compile failed: ${compileFailed})` : '');
    for (;;) {
      if (ctx.onPoll) await ctx.onPoll();
      // null is "the runtime cannot read the stream", never "unchanged".
      const token = await observe.mutationToken();
      const moved = last === null || token === null || token !== lastToken;
      if (moved) {
        if (recompiles >= UNTIL_RECOMPILE_CAP) {
          return stamp(
            'timed_out',
            `${last?.observed ?? 'no compile succeeded'}; the recompile cap (${UNTIL_RECOMPILE_CAP}) was spent ` +
              `at +${Date.now() - ctx.dispatchedAt} ms while the page was still changing`,
          );
        }
        const t0 = Date.now();
        try {
          const g = await observe.compile();
          recompiles += 1;
          lastToken = token;
          compileFailed = null;
          last = check(g);
        } catch (e) {
          // A document mid-replacement cannot be captured; say so and look again.
          compileFailed = String((e as Error).message ?? e).slice(0, 80);
        }
        lastCompileMs = Date.now() - t0;
      }
      if (last !== null && last.met) return stamp('condition_met', last.observed + accounting());
      if (remaining() === 0) {
        return stamp(
          'timed_out',
          `${last?.observed ?? 'no compile succeeded'} at the bound${accounting()}`,
        );
      }
      await pause(Math.max(UNTIL_POLL_MS, lastCompileMs));
    }
  }

  // Drain pending browser events into a delta suffix — for the act paths whose
  // returns are value-shaped (select/fill) rather than event-shaped.
  private drainEventNote(): string {
    const events = this.drainBrowserEvents();
    return events.length > 0 ? ` [${events.map((e) => e.description).join('; ')}]` : '';
  }

  // Pre-dispatch, main-world, namespaced; best-effort (absence reads as null,
  // never breaks an act). Runtime-internal instrumentation — nothing here is
  // exposed to the model beyond the evidence string.
  /** The names of the page's own password inputs, read before dispatch so the
   *  receipt can redact their values by the browser's own typing rather than by
   *  guessing from a name. Main document only; a form in a child frame is
   *  covered by the name heuristic in core/receipt.ts. Best-effort: a page that
   *  will not answer gets the heuristic alone. */
  private async passwordFieldNames(): Promise<Set<string>> {
    try {
      const names = await this.page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type=password]'))
          .map((i) => (i as HTMLInputElement).name)
          .filter((n) => n !== ''),
      );
      return new Set(names);
    } catch {
      return new Set();
    }
  }

  private async armMutationCounter(): Promise<void> {
    try {
      await this.page.evaluate(() => {
        const w = window as unknown as { __wirMut?: { n: number; obs: MutationObserver } };
        if (w.__wirMut) w.__wirMut.obs.disconnect();
        const state = { n: 0, targets: [] as Node[] } as {
          n: number;
          targets: Node[];
          obs: MutationObserver;
        };
        state.obs = new MutationObserver((records) => {
          state.n += records.length;
          // Keep the nodes, not just the count, and keep BOTH kinds.
          //
          // The TARGET covers the unhide case: a validation message is usually
          // already in the DOM and merely revealed (ng-show toggles a style), so
          // addedNodes sees nothing while the target is exactly the element whose
          // text is wanted.
          //
          // The ADDED NODES cover the insert case, and missing them cost the
          // whole point on React: a banner is APPENDED, so the target is its
          // container, whose text is the entire form — which the length bound
          // below then discards, losing precisely the message that appeared.
          //
          // Bounded: a flood of records is still one short list.
          for (const r of records) {
            if (state.targets.length >= 120) break;
            state.targets.push(r.target);
            for (const added of r.addedNodes) state.targets.push(added);
          }
        });
        state.obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        w.__wirMut = state;
      });
    } catch {
      /* counter is best-effort */
    }
  }

  // Who would receive a click at this point? Returns null when the target itself
  // would (the normal case), or a short human-readable identification of whatever
  // is on top. The hit is good when the topmost painted element composes back to
  // the target — itself, inside it, across a shadow boundary, or through a label
  // that activates it — because all of those mean the click reaches the target.
  //
  // The first version tested plain DOM containment and called that parity with
  // Playwright. It was not: Playwright climbs the composed tree, and the plain
  // test refused working clicks on every web component (elementFromPoint retargets
  // to the host) and on label-activated inputs. Measured before the fix: 12 of 12
  // links on chromestatus.com, 12 of 15 controls on a Bootstrap 4 page.
  //
  // Any failure to answer returns null — an occlusion check that guesses would
  // reject legitimate acts, and a false `blocked_by_overlay` is worse than the
  // missing signal it replaces.
  // Scroll a container forward by one of its own viewports, then report whether
  // the page rendered anything it had not rendered before.
  //
  // Why this exists when act already scrolls: scrollIntoViewIfNeeded scrolls TO A
  // KNOWN ELEMENT, so it cannot reach content that was never rendered. A
  // virtualized list — every serious mail client, every large grid — renders only
  // the visible window, so the rows below have no node, no ref, and nothing to
  // aim at. Measured: react-virtualized shows 50,000px of scroll extent behind 81
  // rendered children.
  //
  // Why not a viewport verb: the step is the container's OWN client height, not a
  // number the caller picks, and the answer says whether new content appeared.
  // That makes it a continuation — repeat until it stops yielding — rather than a
  // viewport the model must manage. WIR compiles whole documents, so "below the
  // fold" was never the problem; "never rendered" is.
  //
  // Detection of how much remains is deliberately NOT attempted from geometry: a
  // virtualized list sizes its scrollbar with a full-height spacer, so rendered
  // content covers the full extent and the obvious tell reads complete on exactly
  // the case it was meant to catch (measured on react-virtualized and YouTube).
  /** Advance a scroller by one viewport, or `toEnd` all the way to the bottom.
   *
   *  WHY "end" EXISTS. One viewport per call is the right default — it is how a
   *  reader moves, and it keeps every step observable. But reaching the bottom of
   *  a container then costs one MODEL ROUND TRIP per screen, and a round trip is
   *  ~3.1 s of the episode's clock against ~40 ms of runtime. Measured on the
   * This behavior was verified during testing.
   *  calls to traverse, and mimo-v2.5 exhausted its 60-call budget mid-scroll —
   *  its last recorded thought was "let me keep scrolling to the bottom". The
   *  request was reachable; the transport was not affordable.
   *
   *  "Scroll to the bottom" is one intent, and a person does it with one gesture.
   *  This is not a new capability — the same scroller, the same events, the same
   *  verdict machinery — only a destination.
   *
   *  It is still BOUNDED and still accounted: the loop stops at the end, or after
   *  a fixed number of screens, and the delta says which. An unbounded loop on a
   *  page that grows as you scroll (an infinite feed) would never return, so the
   *  cap is the honest thing and the residual is reported rather than hidden. */
  private async scrollContainer(
    node: WirNode,
    toEnd = false,
    until: ActUntil | null = null,
    g: WirGraph | null = null,
  ): Promise<ActOutcome | ActRejection> {
    const dispatchedAt = Date.now();
    try {
      // The graph's root is synthetic (backendNodeId -1), so DOM.resolveNode
      // cannot answer for it. It is obtainable — find({role:"document"}) returns
      // it — but `read` never projects it, so it is a rare way in rather than the
      // usual one: scrolling the page normally happens through the ancestor
      // fallback below, from any ref on it. Handled so a ref the graph can hand
      // out is never one act refuses.
      let objectId: string | undefined;
      if (node.backendNodeId < 0) {
        const r = (await this.cdp.send('Runtime.evaluate', {
          expression: 'document.scrollingElement',
        })) as { result?: { objectId?: string } };
        objectId = r.result?.objectId;
      } else {
        const { object } = (await this.cdp.send('DOM.resolveNode', {
          backendNodeId: node.backendNodeId,
        })) as { object: { objectId?: string } };
        objectId = object.objectId;
      }
      if (!objectId) {
        return {
          rejected: {
            kind: 'stale_ref',
            reason: 'the node behind this ref no longer exists',
            repair: '{"verb":"read"} and re-resolve',
          },
        };
      }
      const object = { objectId };
      // Resolve the scroller ONCE and hold it. The target may not survive the
      // scroll — a virtualized list destroys its rows, which is the case this
      // action exists for — and re-deriving the scroller from a detached row
      // walked to the page instead.
      const scroller = await this.scrollerHandle(object.objectId);
      if (scroller === null) {
        return {
          rejected: {
            kind: 'invalid_args',
            reason: 'nothing scrollable here: neither this element nor any ancestor of it scrolls',
            repair: '{"verb":"read"} — the page may already show everything it has',
          },
        };
      }
      const before = await this.describeScroll(scroller);
      if (before === null || !before.scrollable) {
        return {
          rejected: {
            kind: 'invalid_args',
            reason: 'nothing scrollable here: neither this element nor any ancestor of it scrolls',
            repair: '{"verb":"read"} — the page may already show everything it has',
          },
        };
      }
      // A CAP, STATED. Not "scroll forever": an infinite feed grows as you go and
      // would never return. 40 screens is far past any real document and short of
      // a hang; whatever remains is reported in the delta, never swallowed.
      const MAX_SCREENS = 40;
      let screens = 0;
      const nudge = `function() {
        const box = this;
        const vRoom = box.scrollHeight - box.clientHeight - box.scrollTop > 4;
        if (vRoom) box.scrollTop = box.scrollTop + Math.max(1, box.clientHeight - 40);
        else box.scrollLeft = box.scrollLeft + Math.max(1, box.clientWidth - 40);
      }`;
      // `until` on a scroll is the 464 shape: scroll to the end until the words
      // are there. While the condition is polled, a container that has GROWN
      // past where the loop left it (a lazy loader appended rows) is nudged on
      // again, against the same screen cap — so "to the end until X" keeps its
      // meaning on a feed that loads as you go, and stays bounded.
      const extend = async (): Promise<void> => {
        if (until === null || g === null) return;
        this.pendingUntil = await this.awaitUntil(until, {
          target: node,
          g,
          dispatchedAt,
          wire: null,
          onPoll: async () => {
            if (!toEnd || screens >= MAX_SCREENS) return;
            const now = await this.describeScroll(scroller);
            if (now === null || now.atEnd) return;
            await this.cdp.send('Runtime.callFunctionOn', {
              objectId: scroller,
              functionDeclaration: nudge,
            });
            screens += 1;
          },
        });
      };
      if (before.atEnd) {
        // Already there — but a declared condition is still answered: the end
        // of a feed is exactly where the next batch is expected to arrive.
        await extend();
        const now = await this.describeScroll(scroller);
        return {
          actRef: `a_${++this.counter}`,
          outcome: 'delivered',
          effect: {
            verdict: 'verified',
            evidence: 'scrolled_no_new_content',
            delta: {
              before: `scrollTop=${before.top} (already at the end)`,
              after:
                `scrollTop=${now?.top ?? before.top}` +
                (screens > 0
                  ? ` [${screens} more screen${screens === 1 ? '' : 's'} while waiting]`
                  : ''),
            },
          },
        };
      }
      for (;;) {
        // The scroller handle, not the target: the same element that was
        // measured, and the one that will be measured again. Vertical first,
        // and only when vertical is exhausted does horizontal move — so
        // repeating the call traverses the whole container instead of stalling
        // at the bottom of a box that still has content to the right.
        await this.cdp.send('Runtime.callFunctionOn', {
          objectId: scroller,
          functionDeclaration: nudge,
        });
        screens += 1;
        if (!toEnd || screens >= MAX_SCREENS) break;
        // Let a lazy loader answer before deciding whether we have arrived.
        await this.page.waitForTimeout(120);
        const step = await this.describeScroll(scroller);
        if (step === null || step.atEnd) break;
      }
      // Lazy loaders answer a scroll asynchronously; settle before judging.
      await this.page.waitForTimeout(900);
      await extend();
      // The SAME scroller, not the same target: the target may be gone.
      const after = await this.describeScroll(scroller);
      const moved = after !== null && (after.top !== before.top || after.left !== before.left);
      const grew = after !== null && after.extent > before.extent;
      // New content is decided by WHAT THE SCROLLER READS, not by how many nodes
      // it has. The old test — a rising element count, or a growing scrollHeight
      // — is false by construction on a virtualized list, which recycles a fixed
      // node count behind a full-height spacer. This file already documents both
      // halves of that above; the verdict was still built on them, so a screen
      // full of never-seen rows answered `scrolled_no_new_content`, and the
      // system prompt turns that token into an instruction to stop.
      //
      // A text digest is definitionally right here: recycled nodes carry
      // different text. Edge identity catches the case where a window slides far
      // enough to change its boundaries but the digest collides.
      const contentChanged =
        after !== null &&
        (after.textDigest !== before.textDigest ||
          after.textLen !== before.textLen ||
          after.firstEdge !== before.firstEdge ||
          after.lastEdge !== before.lastEdge);
      const newContent =
        after !== null && (contentChanged || grew || after.descendants > before.descendants);
      return {
        actRef: `a_${++this.counter}`,
        outcome: 'delivered',
        effect: {
          // `verified` says the scroll happened, which is all a scroll can claim.
          // Whether it REVEALED anything is the evidence, and saying "nothing new"
          // plainly is what lets a caller stop instead of scrolling forever.
          verdict: moved || newContent ? 'verified' : 'unknown',
          // MOVED AND NOT AT THE END IS NEW CONTENT, even when nothing in the DOM
          // changed. The digest above was built for a VIRTUALIZED list, which
          // recycles nodes so its text genuinely changes; an ordinary overflow
          // container already holds all its text and merely clips it, so
          // scrolling one reveals a screenful to the reader while changing
          // nothing measurable. Both then read `scrolled_no_new_content` — and
          // this file already records that the system prompt turns that token
          // into an instruction to STOP.
          //
          // This behavior was verified during testing.
          // scroll, 130px per call): calls 1-3 each advanced a screenful and each
          // reported `scrolled_no_new_content`; only call 4, which hit the
          // bottom, said `scrolled`. A caller obeying the evidence stops three
          // screens early — and the accept button that box gates stayed disabled.
          //
          // `atEnd` is the honest discriminator and was already computed on both
          // sides. It does not weaken the stop signal; it moves it to where
          // stopping is actually right.
          evidence: newContent
            ? 'scrolled'
            : moved && after !== null && !after.atEnd
              ? 'scrolled'
              : moved
                ? 'scrolled_no_new_content'
                : 'no_observable_change_yet',
          ...(moved || newContent
            ? {}
            : {
                reason:
                  after === null
                    ? 'the scroller could not be re-read after the dispatch, so neither movement nor new content is established'
                    : 'the scroller did not move (scrollTop and scrollLeft unchanged) and its readable content did not change',
              }),
          delta: {
            before: `${before.name} scrollTop=${before.top} scrollLeft=${before.left} extent=${before.extent}x${before.wExtent} rendered=${before.descendants} textLen=${before.textLen}`,
            // atEnd was computed on both sides and read only on `before`, so a
            // caller could never tell "stop, exhausted" from "stop, nothing new"
            // — two states that want different next moves.
            after:
              after === null
                ? 'unreadable'
                : `scrollTop=${after.top} scrollLeft=${after.left} extent=${after.extent}x${after.wExtent} ` +
                  `rendered=${after.descendants} textLen=${after.textLen}` +
                  (toEnd
                    ? ` [${screens} screen${screens === 1 ? '' : 's'}` +
                      `${
                        screens >= MAX_SCREENS && !after.atEnd
                          ? `; stopped at the ${MAX_SCREENS}-screen bound with more below`
                          : ''
                      }]`
                    : '') +
                  `${after.atEnd ? ' [at the end of this container]' : ''}`,
          },
        },
      };
    } catch (e) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `scroll failed: ${String(e).slice(0, 140)}`,
          repair: '{"verb":"read"} and re-resolve',
        },
      };
    }
  }

  /** The scroller that owns this element, as a HANDLE.
   *
   *  Resolved once and reused, because `describeScroll` used to re-walk the
   *  ancestor chain on both sides of the scroll — and a virtualized list
   *  destroys its rows as it scrolls, which is the case scroll exists for. A
   *  detached row has no parent chain, so the walk fell through to
   *  `document.scrollingElement` and the second reading described THE PAGE.
   *  Measured on a react-window-style fixture: before `<div#list>` extent
   *  20000x1264, after (unnamed) extent 900x1280 — and the page happened to be
   *  at its end, so the delta also announced "at the end of this container"
   *  with 20,000px of list still below. That token stops the model.
   *
   *  Holding the scroller means both readings describe one element, and a
   *  recycled target changes nothing. */
  private async scrollerHandle(objectId: string): Promise<string | null> {
    try {
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId,
        returnByValue: false,
        functionDeclaration: `function() {
          if (this === document.documentElement || this === document.body) return document.scrollingElement;
          for (let n = this; n && n.nodeType === 1; n = n.parentElement ?? (n.getRootNode()||{}).host) {
            const cs = getComputedStyle(n);
            const v = /(auto|scroll|overlay)/.test(cs.overflowY + ' ' + cs.overflow)
              && n.scrollHeight > n.clientHeight + 4;
// A horizontally-overflowing box is just as much a scroller: a nav
// strip 4006px wide in a 1400px viewport hides real menu items, and
// testing only height walked straight past it to the page.
            const h = /(auto|scroll|overlay)/.test(cs.overflowX + ' ' + cs.overflow)
              && n.scrollWidth > n.clientWidth + 4;
            if (v || h) return n;
          }
          return document.scrollingElement;
        }`,
      })) as { result?: { objectId?: string } };
      return r.result?.objectId ?? null;
    } catch {
      return null;
    }
  }

  private async describeScroll(objectId: string): Promise<{
    top: number;
    left: number;
    extent: number;
    client: number;
    wExtent: number;
    wClient: number;
    name: string;
    descendants: number;
    textLen: number;
    textDigest: number;
    firstEdge: string;
    lastEdge: string;
    scrollable: boolean;
    atEnd: boolean;
  } | null> {
    try {
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        functionDeclaration: `function() {
// THIS is the scroller, resolved once by scrollerHandle. Re-walking
// here is what let a recycled row retarget the second reading at the
// page. If the scroller itself was torn out, say so rather than
// silently measuring something else.
          const box = this.isConnected ? this : null;
          if (box === null) return null;
          const top = Math.round(box.scrollTop), left = Math.round(box.scrollLeft);
          const extent = box.scrollHeight, client = box.clientHeight;
          const wExtent = box.scrollWidth, wClient = box.clientWidth;
          const name = box === document.scrollingElement ? 'the page'
            : '<' + box.tagName.toLowerCase() + (box.id ? '#' + box.id : '') + '>';
          const vEnd = top + client >= extent - 4, hEnd = left + wClient >= wExtent - 4;
// CONTENT identity, not node count. A virtualized list recycles a fixed
// number of nodes, so the count is constant by construction on exactly
// the pages this action exists for — and scrollHeight is inert there too
// (a full-height spacer), which this file already documents above.
// Recycled nodes carry different TEXT, so a digest of what the scroller
// reads is the one signal that is definitionally correct here.
          const shown = (box.innerText || '');
          let digest = 0;
          for (let k = 0; k < shown.length; k++) digest = (digest * 31 + shown.charCodeAt(k)) | 0;
          const edge = (el) => el ? ((el.innerText || el.id || el.className || '') + '').slice(0, 60) : '';
          return { top, left, extent, client, wExtent, wClient, name,
// Direct children only: querySelectorAll('*') counts the whole
// document when the scroller IS the page, so one ad or lazy image
// injected anywhere during settle used to mint a new-content verdict.
            descendants: box.children.length,
            textLen: shown.length, textDigest: digest,
            firstEdge: edge(box.firstElementChild), lastEdge: edge(box.lastElementChild),
            scrollable: extent > client + 4 || wExtent > wClient + 4,
            atEnd: vEnd && hEnd };
        }`,
      })) as {
        result?: {
          value?: {
            top: number;
            left: number;
            extent: number;
            client: number;
            wExtent: number;
            wClient: number;
            name: string;
            descendants: number;
            textLen: number;
            textDigest: number;
            firstEdge: string;
            lastEdge: string;
            scrollable: boolean;
            atEnd: boolean;
          };
        };
      };
      return r.result?.value ?? null;
    } catch {
      return null;
    }
  }

  // The upload fence. `value` is a BASENAME chosen from a directory the runner
  // declared — never a path — and default-deny is the whole design: with no
  // declared directory there is no upload, so a capability nobody asked for
  // cannot be reached by a page that asks for it on the model's behalf.
  private resolveUpload(
    value: string | null | undefined,
    ref = '...',
  ): { path: string; name: string } | ActRejection {
    if (value === undefined || value === null || value === '') {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: "upload requires value (the file's name)",
          repair: '{"verb":"act","ref":"...","action":"upload","value":"<filename>"}',
        },
      };
    }
    // Falsy, not just null: an empty string is not "a directory" but it is not
    // === null either, and resolvePath('') is the process cwd — which would have
    // made the whole working tree uploadable.
    if (!this.uploadDir) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason:
            'no upload directory was declared for this episode, so there are no files to attach',
          repair: 'none — this episode cannot upload',
        },
      };
    }
    // A separator or a parent hop is the whole attack: reject the shape, do not
    // try to sanitise it. Then verify containment anyway, because a normaliser
    // trusted alone is how these fences fail.
    if (value.includes('/') || value.includes('\\') || value.includes('..')) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `upload value must be a bare filename, not a path (got ${JSON.stringify(value)})`,
          repair: "use just the file's name, with no directory part",
        },
      };
    }
    const dir = resolvePath(this.uploadDir);
    const full = resolvePath(dir, value);
    // No `full === dir` escape: the directory itself is never a file, and
    // allowing it let value "." through to setFileInputFiles(<the directory>).
    if (!full.startsWith(dir + pathSep)) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: "resolved path escapes the episode's upload directory",
          repair: "use just the file's name, with no directory part",
        },
      };
    }
    if (!existsSync(full)) {
      // SAY WHAT IS THERE. "No file named X" told the caller only that its guess
      // This behavior was verified during testing.
      // mimo-v2.5 tried test.txt, file.txt, test, hello.txt and upload.txt — five
      // rejections, five round trips, and the upload request went uncompleted while
      // the one available file sat unnamed the whole time.
      //
      // This discloses a RUNNER-DECLARED fence, not page content. The runner chose
      // this directory and its contents; naming them widens nothing. The value is
      // still a bare filename inside it, and every guard above is untouched — a
      // path, a parent hop, or an escape is refused exactly as before.
      //
      // Bounded and accounted like every other list here: the first few names,
      // the exact count of what was withheld, never a silent truncation.
      const LIST = 8;
      let available: string[] = [];
      try {
        available = readdirSync(dir)
          .filter((f) => !f.startsWith('.'))
          .sort();
      } catch {
        /* unreadable */
      }
      const shown = available.slice(0, LIST);
      const more = available.length - shown.length;
      const inventory =
        available.length === 0
          ? "this episode's upload directory is empty"
          : `available: ${shown.map((f) => JSON.stringify(f)).join(', ')}` +
            (more > 0 ? ` (+${more} more)` : '');
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `no file named ${JSON.stringify(value)} is available to this episode; ${inventory}`,
          repair:
            shown.length > 0
              ? `{"verb":"act","ref":${JSON.stringify(ref)},"action":"upload","value":${JSON.stringify(shown[0])}}`
              : 'none — the runner placed no files for this episode to attach',
        },
      };
    }
    return { path: full, name: value };
  }

  private async uploadFile(
    node: { backendNodeId: number; tag: string },
    path: string,
    name: string,
    ref: string,
  ): Promise<ActOutcome | ActRejection> {
    // A <label> IS an upload affordance, and on a styled form it is the ONLY one.
    // The common pattern hides the input outright —
    //   <label>Upload File <input type="file" hidden></label>
    // — and a hidden input has no layout box, so it is correctly absent from the
    // accessibility tree and no ref can ever name it. Refusing the label left
    // `act` with no path to the file at all, while telling the model to "click it
    // first", which opens the NATIVE file chooser: a dialog no verb can drive.
    // This behavior was verified during testing.
    //
    // The association is the platform's, not a guess: HTML defines a label's
    // `labeled control` as its `for=` target or its first labelable descendant
    // (whatwg-html §the-label-element), and `label.control` is the browser's own
    // implementation of that rule. So this resolves exactly where a human's click
    // would land — and when the label owns no file input, the refusal stands.
    let backendNodeId = node.backendNodeId;
    if (node.tag === 'label') {
      const resolved = await this.labeledFileInput(node.backendNodeId);
      if (resolved === null) {
        return {
          rejected: {
            kind: 'invalid_args',
            reason: 'upload targets a file input; this ref is a <label> that has no file input',
            repair:
              '{"verb":"find","role":"button","name":"<the upload control>"} — click it first if it opens a picker',
          },
        };
      }
      backendNodeId = resolved;
    } else if (node.tag !== 'input') {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `upload targets a file input; this ref is a <${node.tag}>`,
          repair:
            '{"verb":"find","role":"button","name":"<the upload control>"} — click it first if it opens a picker',
        },
      };
    }
    // The AX spine cannot see a hidden input — display:none holds it out of the
    // tree, which is exactly the styled-upload markup above — so the disabled
    // question is re-asked of the input that was RESOLVED, in the DOM, where
    // hidden and visible answer alike. DOM.setFileInputFiles does not honor
    // This behavior was verified during testing.
    // This behavior was verified during testing.
    // Playwright's own setInputFiles gates on element state for the same reason.
    // Best-effort like every probe here: a check that cannot answer must not
    // refuse a legitimate act, so only a positive `disabled` rejects.
    if ((await this.inputDisabled(backendNodeId)) === true) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: 'target is disabled',
          repair: 'read the page state; a disabled control cannot be acted on',
        },
      };
    }
    try {
      await this.cdp.send('DOM.setFileInputFiles', { files: [path], backendNodeId });
    } catch (e) {
      return {
        rejected: {
          kind: 'invalid_args',
          reason: `the browser refused the attachment: ${String(e).slice(0, 140)}`,
          // The ref, not the placeholder: every sibling repair in this file
          // interpolates, and an unsubstituted "<ref>" inside otherwise-valid JSON
          // is a call the model will copy verbatim and have rejected.
          repair: `{"verb":"read","target":${JSON.stringify(ref)}} — the control may not accept files where it stands`,
        },
      };
    }
    // Postcondition through the page's own view of the input, never our belief
    // about what we sent. The browser reports a sanitised name (C:\fakepath\… on
    // some platforms), so the check is containment of the basename, not equality.
    // Read back the node that was WRITTEN — for a label that is the input it
    // labels, and reading the label instead reported a true attachment as
    // `contradicted`, the one verdict that can never be walked back.
    const after = await this.readValue(backendNodeId);
    const attached = (after ?? '').includes(name);
    const actRef = `a_${++this.counter}`;
    return {
      actRef,
      outcome: 'delivered',
      effect: {
        verdict: attached ? 'verified' : 'contradicted',
        evidence: attached ? 'file_attached' : 'value_mismatch',
        delta: { before: 'value=""', after: `value=${JSON.stringify(after)}` },
      },
    };
  }

  /** The DOM's own answer to "is this input disabled?" — for the one node the
   *  AX spine cannot ask about, a file input held out of the tree by its styled
   *  label. null when the browser did not answer; only `true` may reject. */
  private async inputDisabled(backendNodeId: number): Promise<boolean | null> {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return null;
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: 'function(){ return this.disabled === true; }',
      })) as { result?: { value?: unknown } };
      return r.result?.value === true;
    } catch {
      return null;
    }
  }

  /** The file input a <label> labels, as the platform computes it. Returns null
   *  when the label has no labeled control or that control does not take files —
   *  the caller's refusal then stands, because there is nothing to attach to. */
  private async labeledFileInput(backendNodeId: number): Promise<number | null> {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return null;
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: false,
        // `this.control` is the spec's labeled-control association. The descendant
        // query is not a second guess at it: a label whose control is a non-file
        // input still may CONTAIN the file input on component-library markup, and
        // the type check below is what keeps either path honest.
        functionDeclaration: `function() {
          const c = this.control;
          if (c && c.tagName === 'INPUT' && c.type === 'file') return c;
          return this.querySelector('input[type=file]');
        }`,
      })) as { result?: { objectId?: string } };
      const found = r.result?.objectId;
      if (!found) return null;
      const described = (await this.cdp.send('DOM.describeNode', { objectId: found })) as {
        node?: { backendNodeId?: number };
      };
      return described.node?.backendNodeId ?? null;
    } catch {
      return null;
    }
  }

  private async coveringOverlay(
    backendNodeId: number,
    point?: { x: number; y: number },
  ): Promise<CoveringOverlay | null> {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return null;
      const topLayer = await this.topLayerObjects();
      const args = [
        { value: point?.x ?? null },
        { value: point?.y ?? null },
        ...topLayer.map((objectId) => ({ objectId })),
      ];
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        arguments: args,
        functionDeclaration: `function() {
          ${DESCRIBE_ELEMENT_JS}
          const located = (function() { ${LOCATE_OVERLAY_JS} }).apply(this, arguments);
          if (located === null) return null;
          const { top, root } = located;
          const topLayerEls = Array.prototype.slice.call(arguments, 2);
// The immediate hit is often a bare wrapper div; the dialog it belongs
// to is the thing the caller has to dismiss, so name that when present.
          const dialog = top.closest('[role=dialog],[role=alertdialog],dialog,[aria-modal=true]');
          const occluder = dialog && dialog !== top
            ? describe(dialog) + ' (hit ' + describe(top) + ')'
            : describe(top);
          if (root === null) return { occluder, root: null };
          const ti = root.getAttribute('tabindex');
          const tag = root.tagName.toLowerCase();
          const focusable = (/^(a|button|input|select|textarea)$/.test(tag) && !root.disabled)
            || (ti !== null && ti !== '-1') || root.isContentEditable === true;
// Is the root a loading indicator? Three mechanical rules, in order,
// each reported in the words it was decided on; none firing means
// "not transient", never "probably".
//   words:         its own words carry one of TRANSIENT_WORDS
//   aria:          it, or a descendant, is aria-busy / a progressbar
//   animated-only: it has no words and no dismiss control (the caller
//                  applies that half), and every leaf of it is an
//                  <img>/<svg> or sits under a CSS animation
          const transient = (function(root) {
            const fold = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\\s+/g, ' ').trim();
            const words = ${JSON.stringify(TRANSIENT_WORDS)};
            const sources = [];
            const push = (src, v) => { const t = String(v || '').replace(/\\s+/g, ' ').trim(); if (t !== '') sources.push([src, t]); };
            push('aria-label', root.getAttribute('aria-label'));
            push('aria-labelledby', (root.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
              .map(id => (document.getElementById(id) || {}).textContent || '').join(' '));
            push('title', root.getAttribute('title'));
            push('its text', root.innerText);
            for (const im of root.querySelectorAll('img, svg, [role=img]')) {
              const tag = '<' + im.tagName.toLowerCase() + ' ';
              push(tag + 'alt>', im.getAttribute('alt'));
              push(tag + 'title>', im.getAttribute('title'));
              push(tag + 'aria-label>', im.getAttribute('aria-label'));
              const t = im.tagName.toLowerCase() === 'svg' ? im.querySelector('title') : null;
              if (t) push('<svg><title>', t.textContent);
            }
            for (const [src, text] of sources) {
              const w = words.find(w => fold(text).includes(w));
              if (w) return { rule: 'words: ' + src + ' ' + JSON.stringify(text.slice(0, 60)) + ' contains ' + JSON.stringify(w), phrase: text.slice(0, 60) };
            }
            const busySel = '[aria-busy="true" i], [role="progressbar" i], progress';
            const busy = root.matches(busySel) ? root : root.querySelector(busySel);
            if (busy) {
              const what = (busy.getAttribute('aria-busy') || '').toLowerCase() === 'true' ? 'aria-busy="true"'
                : busy.tagName.toLowerCase() === 'progress' ? 'a <progress> element' : 'role="progressbar"';
              return { rule: 'aria: ' + (busy === root ? 'it carries ' : 'a descendant <' + busy.tagName.toLowerCase() + '> carries ') + what, phrase: null };
            }
            if (fold(root.innerText) !== '') return null;
            const animated = (e) => getComputedStyle(e).animationName !== 'none';
            const graphic = (e) => /^(img|svg)$/i.test(e.tagName) || e.closest('svg') !== null;
// Not Array.from: a page can replace it (Prototype.js's $A returns []

            const all = Array.prototype.slice.call(root.querySelectorAll('*'));
            const content = [root].concat(all).filter(e => animated(e) || graphic(e));
            if (content.length === 0) return null;
            const leaves = all.length === 0 ? [root] : all.filter(e => e.children.length === 0);
            const under = (e) => { for (let n = e; n && n !== root.parentElement; n = n.parentElement) if (animated(n) || graphic(n)) return true; return false; };
            if (!leaves.every(under)) return null;
            const moving = content.filter(animated);
            const names = [...new Set(moving.map(e => getComputedStyle(e).animationName))].slice(0, 3);
            const imgs = content.filter(e => /^(img|svg)$/i.test(e.tagName)).length;
            const parts = [];
            if (moving.length > 0) parts.push(moving.length + ' animated element' + (moving.length === 1 ? '' : 's') + ' (animation-name ' + names.map(n => JSON.stringify(n)).join(', ') + ')');
            if (imgs > 0) parts.push(imgs + ' <img>/<svg>');
            return { rule: 'animated-only: it has no words and its only content is ' + parts.join(' and '), phrase: null };
          })(root);
          return { occluder, root: { desc: describe(root), tag,
            position: getComputedStyle(root).position,
            topLayer: topLayerEls.includes(root),
            popover: root.hasAttribute('popover'), focusable, transient } };
        }`,
      })) as {
        result?: {
          value?: {
            occluder: string;
            root: Omit<
              NonNullable<CoveringOverlay['root']>,
              'backendNodeId' | 'hitBackendNodeId'
            > | null;
          } | null;
        };
      };
      const v = r.result?.value;
      if (v === undefined || v === null) return null;
      if (v.root === null) return { occluder: v.occluder, root: null, dismiss: [] };
      // The root as a handle, from the same locate, so the id belongs to the
      // element the text describes. Its dismiss controls follow from it.
      const h = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: false,
        arguments: args,
        functionDeclaration: `function() { const l = (function() { ${LOCATE_OVERLAY_JS} }).apply(this, arguments); return l ? l.root : null; }`,
      })) as { result?: { objectId?: string; subtype?: string } };
      const rootObjectId = h.result?.subtype === 'null' ? undefined : h.result?.objectId;
      let rootBackendId: number | null = null;
      if (rootObjectId !== undefined) {
        const d = (await this.cdp.send('DOM.describeNode', { objectId: rootObjectId })) as {
          node?: { backendNodeId?: number };
        };
        rootBackendId = d.node?.backendNodeId ?? null;
      }
      // The element under the pointer too, from the same locate — the backdrop
      // classification asks it for a listener when the root has none.
      let hitBackendId: number | null = null;
      try {
        const t = (await this.cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          returnByValue: false,
          arguments: args,
          functionDeclaration: `function() { const l = (function() { ${LOCATE_OVERLAY_JS} }).apply(this, arguments); return l ? l.top : null; }`,
        })) as { result?: { objectId?: string; subtype?: string } };
        const topObjectId = t.result?.subtype === 'null' ? undefined : t.result?.objectId;
        if (topObjectId !== undefined) {
          const d = (await this.cdp.send('DOM.describeNode', { objectId: topObjectId })) as {
            node?: { backendNodeId?: number };
          };
          hitBackendId = d.node?.backendNodeId ?? null;
        }
      } catch {
        /* unnamed: the classification then asks only the root and its ancestors */
      }
      return {
        occluder: v.occluder,
        root: { ...v.root, backendNodeId: rootBackendId, hitBackendNodeId: hitBackendId },
        dismiss: [],
      };
    } catch {
      return null;
    }
  }

  /** The top layer, as live object handles for the hit-test above — computed
   *  at act time, not read from the graph, because the graph is a census and
   *  the overlay may have opened since. `DOM.getTopLayerElements` needs a
   *  document handed out first (measured: [] otherwise), and lists each
   *  element's ::backdrop beside it, which resolves to no object and is
   *  skipped. */
  private async topLayerObjects(): Promise<string[]> {
    try {
      await this.cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeIds } = (await this.cdp.send('DOM.getTopLayerElements')) as { nodeIds: number[] };
      const out: string[] = [];
      for (const nodeId of nodeIds.slice(0, 16)) {
        try {
          const d = (await this.cdp.send('DOM.describeNode', { nodeId })) as {
            node?: { nodeType?: number; pseudoType?: string };
          };
          if (d.node?.nodeType !== 1 || d.node.pseudoType !== undefined) continue;
          const { object } = (await this.cdp.send('DOM.resolveNode', { nodeId })) as {
            object: { objectId?: string };
          };
          if (object.objectId) out.push(object.objectId);
        } catch {
          /* a node that vanished between the two calls is not in the layer */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** The refusal for a covered click, with the layer's own dismiss controls
   *  computed against the graph: clickable nodes carrying a dismissal word,
   *  tested for containment in the root by the browser (composed tree), plus
   *  the buttons of any `form method=dialog` the root holds. Bounded — at most
   *  DISMISS_CANDIDATES word-matching nodes are resolved — and the bound is
   *  disclosed as "and N more" only over what was actually tested. Any failure
   *  in the containment step leaves the list empty, and the text then says no
   *  control was found INSIDE the overlay, which is what was computed. */
  private async overlayRejection(
    g: WirGraph,
    c: CoveringOverlay,
    repeat: RepeatCall | null = null,
    waitedMs: number | null = null,
  ): Promise<Rejection['rejected']> {
    const dismiss = await this.overlayDismiss(g, c);
    // The backdrop question is asked only where the text would otherwise say
    // "no way out": after the dismiss list and the transient rules.
    const backdrop =
      dismiss.length === 0 && c.root !== null && c.root.transient === null
        ? await this.overlayBackdrop(g, c)
        : null;
    return overlayRejectionText(g, c, dismiss, repeat, waitedMs, backdrop);
  }

  /** Is the covering root a backdrop (see BACKDROP_LISTENER_TYPES)? Two
   *  facts, both the browser's: the root has no words (the same sources the
   *  words rule reads) and no rendered control by tag/role/tabindex; and a
   *  click-shaped listener sits on the root, else on the element under the
   *  pointer, else on one of the root's nearest BACKDROP_ANCESTORS ancestors —
   *  from DOMDebugger.getEventListeners, the table Chrome's own isClickable
   *  is built from, filtered to listeners bound to that node itself. null
   *  when either fact fails: the class is then not claimed. Any failure
   *  leaves it null, and the text stays the no-way-out text. */
  private async overlayBackdrop(g: WirGraph, c: CoveringOverlay): Promise<BackdropFinding | null> {
    const root = c.root;
    if (root === null || root.backendNodeId === null) return null;
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', {
        backendNodeId: root.backendNodeId,
      })) as { object: { objectId?: string } };
      if (!object.objectId) return null;
      const shape = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function() {
          const t = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
          const words = [this.getAttribute('aria-label'), this.getAttribute('title'), this.innerText,
            (this.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
              .map(id => (document.getElementById(id) || {}).textContent || '').join(' ')];
          for (const im of this.querySelectorAll('img, svg, [role=img]')) {
            words.push(im.getAttribute('alt'), im.getAttribute('title'), im.getAttribute('aria-label'));
            const st = im.tagName.toLowerCase() === 'svg' ? im.querySelector('title') : null;
            if (st) words.push(st.textContent);
          }
          if (words.some(w => t(w) !== '')) return { wordless: false, controls: 0 };
          const rendered = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
          const sel = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable],' +
            '[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],' +
            '[role=checkbox],[role=radio],[role=option],[role=switch],[role=textbox],[role=combobox],[role=slider]';
          return { wordless: true, controls: Array.prototype.filter.call(this.querySelectorAll(sel), rendered).length };
        }`,
      })) as { result?: { value?: { wordless: boolean; controls: number } } };
      const v = shape.result?.value;
      if (v === undefined || !v.wordless || v.controls > 0) return null;
      // The listener: the root, the element under the pointer, then the
      // ancestors — first bearer wins, and the walk stops at BACKDROP_ANCESTORS.
      const candidates: { objectId: string; where: BackdropFinding['where']; levels: number }[] = [
        { objectId: object.objectId, where: 'root', levels: 0 },
      ];
      if (root.hitBackendNodeId !== null && root.hitBackendNodeId !== root.backendNodeId) {
        try {
          const h = (await this.cdp.send('DOM.resolveNode', {
            backendNodeId: root.hitBackendNodeId,
          })) as { object: { objectId?: string } };
          if (h.object.objectId)
            candidates.push({ objectId: h.object.objectId, where: 'hit', levels: 0 });
        } catch {
          /* gone: not a candidate */
        }
      }
      for (let i = 1; i <= BACKDROP_ANCESTORS; i++) {
        const a = (await this.cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          returnByValue: false,
          functionDeclaration: `function() { let n = this; for (let k = 0; k < ${i} && n; k++) n = n.parentElement; return n; }`,
        })) as { result?: { objectId?: string; subtype?: string } };
        if (a.result?.subtype === 'null' || !a.result?.objectId) break;
        candidates.push({ objectId: a.result.objectId, where: 'ancestor', levels: i });
      }
      for (const cand of candidates) {
        const d = (await this.cdp.send('DOM.describeNode', { objectId: cand.objectId })) as {
          node?: { backendNodeId?: number };
        };
        const id = d.node?.backendNodeId ?? null;
        const { listeners } = (await this.cdp.send('DOMDebugger.getEventListeners', {
          objectId: cand.objectId,
        })) as { listeners: { type: string; backendNodeId?: number }[] };
        const own = new Set(
          listeners
            .filter(
              (l) =>
                BACKDROP_LISTENER_TYPES.includes(l.type) &&
                (l.backendNodeId === undefined || l.backendNodeId === id),
            )
            .map((l) => l.type),
        );
        if (own.size === 0) continue;
        const types = BACKDROP_LISTENER_TYPES.filter((t) => own.has(t));
        const desc = (await this.cdp.send('Runtime.callFunctionOn', {
          objectId: cand.objectId,
          returnByValue: true,
          functionDeclaration: `function() { ${DESCRIBE_ELEMENT_JS} return describe(this); }`,
        })) as { result?: { value?: string } };
        const named = desc.result?.value ?? '?';
        const rootRef = g.byBackendId.get(root.backendNodeId) ?? null;
        const ownRef = id === null ? null : (g.byBackendId.get(id) ?? null);
        const bearer =
          cand.where === 'root'
            ? `the layer itself (${named})`
            : cand.where === 'hit'
              ? `the element under the pointer (${named})`
              : cand.levels === 1
                ? `its parent (${named})`
                : `its ancestor ${cand.levels} levels up (${named})`;
        const ref = cand.where === 'ancestor' ? rootRef : ownRef;
        return { bearer, where: cand.where, types, ref };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** The root's own dismiss controls, as the refusal lists them (see
   *  overlayRejection) — and, before that, the half of the transient
   *  classification the browser cannot do alone: a layer with an exit is not
   *  waited on. */
  private async overlayDismiss(g: WirGraph, c: CoveringOverlay): Promise<WirNode[]> {
    const dismiss: WirNode[] = [];
    const root = c.root;
    if (root !== null && root.backendNodeId !== null) {
      try {
        const words = (n: WirNode): string =>
          `${n.name}\n${n.description ?? ''}\n${n.text}`.toLowerCase();
        const candidates = [...g.nodes.values()]
          .filter(
            (n) =>
              n.backendNodeId > 0 &&
              n.affordances.includes('clickable') &&
              DISMISSAL_WORDS.some((w) => words(n).includes(w)),
          )
          .slice(0, DISMISS_CANDIDATES);
        const { object } = (await this.cdp.send('DOM.resolveNode', {
          backendNodeId: root.backendNodeId,
        })) as { object: { objectId?: string } };
        if (object.objectId) {
          const handles: { objectId: string; node: WirNode }[] = [];
          for (const n of candidates) {
            try {
              const r = (await this.cdp.send('DOM.resolveNode', {
                backendNodeId: n.backendNodeId,
              })) as { object: { objectId?: string } };
              if (r.object.objectId) handles.push({ objectId: r.object.objectId, node: n });
            } catch {
              /* gone since the census: not inside anything */
            }
          }
          const inside = (await this.cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            returnByValue: true,
            arguments: handles.map((h) => ({ objectId: h.objectId })),
            functionDeclaration: `function() {
              const within = (e) => {
                for (let n = e, guard = 0; n && guard < 200;
                     n = n.assignedSlot ?? n.parentElement ?? n.getRootNode().host, guard++) {
                  if (n === this) return true;
                }
                return false;
              };
              return Array.prototype.map.call(arguments, within);
            }`,
          })) as { result?: { value?: boolean[] } };
          const flags = inside.result?.value ?? [];
          const picked = new Set<number>();
          handles.forEach((h, i) => {
            if (flags[i] === true) picked.add(h.node.backendNodeId);
          });
          if (root.tag === 'dialog') {
            for (const id of await this.formDialogButtons(object.objectId)) picked.add(id);
          }
          // Document order, from the graph's own order.
          for (const n of g.nodes.values()) if (picked.has(n.backendNodeId)) dismiss.push(n);
        }
      } catch {
        /* the list stays empty, and the text says so */
      }
    }
    return dismiss;
  }

  /** backendNodeIds of the buttons that submit a `form method=dialog` inside
   *  the element, in document order, at most DISMISS_LISTED. A <dialog>'s
   *  own closing mechanism, by the HTML spec — no words involved. */
  private async formDialogButtons(rootObjectId: string): Promise<number[]> {
    try {
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: rootObjectId,
        returnByValue: false,
        functionDeclaration: `function() {
          return Array.from(this.querySelectorAll(
            'form[method=dialog i] button:not([type=button]):not([type=reset]), ' +
            'form[method=dialog i] input[type=submit], button[formmethod=dialog i]')).slice(0, ${DISMISS_LISTED});
        }`,
      })) as { result?: { objectId?: string } };
      if (!r.result?.objectId) return [];
      const props = (await this.cdp.send('Runtime.getProperties', {
        objectId: r.result.objectId,
        ownProperties: true,
      })) as { result: { name: string; value?: { objectId?: string } }[] };
      const out: number[] = [];
      for (const p of props.result) {
        if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
        const d = (await this.cdp.send('DOM.describeNode', { objectId: p.value.objectId })) as {
          node?: { backendNodeId?: number };
        };
        if (d.node?.backendNodeId !== undefined) out.push(d.node.backendNodeId);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** The nearest ancestor of a node that CAN take keyboard focus, as a ref, or
   *  null when there is none.
   *
   *  WHY. Text and focusability routinely live on different elements: a
   *  `<div tabindex="0">` wrapping a `<p>` that carries the words. `find` matches
   *  on the page's own words, so it returns the PARAGRAPH — and `key` then
   *  refuses it, correctly, because a press there would go to whatever is
   * This behavior was verified during testing.
   *  wraps its prompt in exactly that shape, `find "press the"` returned the
   *  generic and the paragraph, the focusable container was the ancestor of both,
   *  and three presses in a row were rejected.
   *
   *  Telling the caller to "click it first" was true and useless — clicking the
   *  paragraph focuses nothing either. This computes the answer the runtime
   *  already holds. It is disclosure, not matching: no similarity, no ranking,
   *  just the DOM ancestor chain and the browser's own focusability rule. */
  private async focusableAncestorRef(
    backendNodeId: number,
    byBackendId: Map<number, string>,
  ): Promise<string | null> {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return null;
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: false,
        functionDeclaration:
          'function(){ ' +
          'let e = this.parentElement; ' +
          'while (e) { ' +
          '  const ti = e.getAttribute("tabindex"); ' +
          '  const nat = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !e.disabled; ' +
          '  if (nat || (ti !== null && ti !== "-1") || e.isContentEditable) return e; ' +
          '  e = e.parentElement; } ' +
          'return null; }',
      })) as { result?: { objectId?: string; subtype?: string } };
      if (!r.result?.objectId || r.result.subtype === 'null') return null;
      const d = (await this.cdp.send('DOM.describeNode', { objectId: r.result.objectId })) as {
        node?: { backendNodeId?: number };
      };
      const b = d.node?.backendNodeId;
      // The graph's OWN map. The executor never mints a ref — identity has one
      // minting site (core/compiler.ts) and a second would be a second identity.
      // A focusable ancestor the compiler did not compile simply has no ref, and
      // saying nothing is correct there.
      return b === undefined ? null : (byBackendId.get(b) ?? null);
    } catch {
      return null;
    }
  }

  /** The input types whose value the UA sanitizes into a structured format, so
   *  there is no text field to insert into. Returns the type, or null for an
   *  ordinary text-like control. */
  private async valueSanitizedType(backendNodeId: number): Promise<string | null> {
    // `range` joins them for the same reason `color` did: the control holds a
    // sanitized value behind non-text UI, so selectAll+insertText reaches nothing.
    // This behavior was verified during testing.
    // on <input type=range min=1 max=100> returned contradicted/value_mismatch and
    // the oracle showed the value still 1 — WIR was right to contradict; it simply
    // had no mechanism. The keystroke path is real here (End goes to max, arrows
    // step) but cannot express an arbitrary value in one act, which is the same
    // bind `color` is in. setStructuredValue's input+change pair is exactly what a
    // drag produces, and the page's own listener is on `input`.
    const STRUCTURED = new Set([
      'date',
      'datetime-local',
      'month',
      'week',
      'time',
      'color',
      'range',
    ]);
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return null;
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: 'function(){ return this.tagName === "INPUT" ? this.type : ""; }',
      })) as { result?: { value?: string } };
      const type = r.result?.value ?? '';
      return STRUCTURED.has(type) ? type : null;
    } catch {
      return null;
    }
  }

  /** Set a structured input's value and fire the pair the UA fires when its own
   *  picker commits. Not a shortcut around browser-authentic events — for these
   *  controls it IS the commit path; there is no keystroke that means "this date". */
  private async setStructuredValue(backendNodeId: number, value: string): Promise<void> {
    const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
      object: { objectId?: string };
    };
    if (!object.objectId) return;
    // Write through the PROTOTYPE's native setter, not `this.value = v`.
    //
    // React makes a controlled input's value a property on the INSTANCE, backed
    // by a tracker holding the last value it knows about. Assigning `this.value`
    // goes through that instance property, so the tracker is updated in the same
    // breath — and when the `input` event arrives React compares the two, sees no
    // change, and never calls onChange. Its state keeps the old value, and the
    // next render writes that back over the DOM.
    //
    // The damage is not a failed fill, it is a LYING one: the readback taken
    // immediately after the write sees the new value and `act` answers
    // verified/value_set, so the model is told the field is filled. It empties
    // some milliseconds later, when anything else on the form re-renders.
    // This behavior was verified during testing.
    // `this.value = v` left "" and the prototype setter left "1990-01-15".
    //
    // The prototype setter writes past the instance property, so the tracker
    // reads stale, React sees a real change, and its state actually updates.
    // Frameworks that do not install a tracker are unaffected: this is the same
    // native setter their inputs already use.
    await this.cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value }],
      functionDeclaration:
        'function(v){ this.focus(); ' +
        'const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value"); ' +
        'if (d && d.set) d.set.call(this, v); else this.value = v; ' +
        'this.dispatchEvent(new Event("input", { bubbles: true })); ' +
        'this.dispatchEvent(new Event("change", { bubbles: true })); return this.value; }',
    });
  }

  private async readMutationCount(): Promise<number | null> {
    return (await this.readMutationDigest())?.n ?? null;
  }

  /** The count, and the text that BECAME VISIBLE while the act was in flight.
   *
   *  "9 mutation records after dispatch" is a count, not a delta: it says the
   *  page answered without saying what it said. On a form that answer is the
   *  reason the submit bounced — "Date of Birth is required." — and an agent that
   *  cannot read it can only guess. Measured: after a rejected submit the text was
   *  on screen, `find {name:"required"}` returned it, and `read {}` carried no
   *  trace of it; the mimo episode spent 44 calls flailing at that wall.
   *
   *  Page-agnostic by construction — it reports the page's own words from the
   *  nodes the browser said changed, matches nothing, and knows no vocabulary. */
  private async readMutationDigest(): Promise<{ n: number; appeared: string[] } | null> {
    // A page that answers 100ms after the click is still answering the click.
    //
    // This behavior was verified during testing.
    // success banner was on screen from +420ms to +2980ms — one millisecond
    // outside the window, and gone 2.5s later. So the delta said "1 mutation
    // records" about a submit that had SUCCEEDED, the banner removed itself
    // before the model's next call (~5s of provider latency), and a completed
    // request became unobservable: the agent had done the work and could not report
    // it. Three of the eight forms it failed are this exact shape.
    //
    // So when the document moved but showed no words yet, wait briefly and look
    // again. Narrow and bounded: only when `n > 0` and nothing legible was found,
    // at most three 150ms looks. An act that changed nothing pays nothing, and
    // the runtime is 4.6% of an episode's wall clock — this is affordable exactly
    // where it buys the answer.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const peek = await this.peekMutationDigest(false);
      if (peek === null) return null;
      if (peek.n === 0 || peek.appeared.length > 0) break;
      await this.page.waitForTimeout(150);
    }
    return await this.peekMutationDigest(true);
  }

  /** One reading of the counter. `finish` disconnects the observer and clears it;
   *  until then the same act may look again while the page settles. */
  private async peekMutationDigest(
    finish: boolean,
  ): Promise<{ n: number; appeared: string[] } | null> {
    try {
      return await this.page.evaluate((done: boolean) => {
        const w = window as unknown as {
          __wirMut?: { n: number; targets: Node[]; obs: MutationObserver };
        };
        if (!w.__wirMut) return null;
        const { n, targets } = w.__wirMut;
        const seen = new Set<string>();
        const candidates: string[] = [];
        for (const t of targets) {
          const el = (t.nodeType === 1 ? t : t.parentElement) as Element | null;
          if (!el || !el.isConnected) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          // A long block is the page re-rendering, not a message; the caller has
          // `read` for that. Short visible text is the answer to "what happened?".
          if (!text || text.length > 120 || seen.has(text)) continue;
          seen.add(text);
          candidates.push(text);
        }
        // A changed element and its container both qualify, and the container's
        // text is the child's plus the whole surrounding form. Keep the most
        // specific: drop any candidate that merely contains another one.
        const appeared = candidates
          .filter((t) => !candidates.some((other) => other !== t && t.includes(other)))
          .slice(0, 4);
        if (done) {
          w.__wirMut.obs.disconnect();
          delete w.__wirMut;
        }
        return { n, appeared };
      }, finish);
    } catch {
      return null;
    }
  }

  // The browser's own role/name for one node, without enabling the AX domain.
  private async axProbe(backendNodeId: number): Promise<AXProbe | null> {
    try {
      const res = (await this.cdp.send('Accessibility.getPartialAXTree', {
        backendNodeId,
        fetchRelatives: false,
      })) as {
        nodes: {
          role?: { value?: string };
          name?: { value?: string };
          properties?: { name: string; value?: { value?: unknown } }[];
        }[];
      };
      const n = res.nodes[0];
      if (!n) return null;
      const disabled = (n.properties ?? []).some(
        (p) => p.name === 'disabled' && p.value?.value === true,
      );
      const exp = (n.properties ?? []).find((p) => p.name === 'expanded');
      const expanded = exp ? exp.value?.value === true : null;
      const raw = (name: string): string | null => {
        const p = (n.properties ?? []).find((q) => q.name === name);
        return p === undefined || p.value?.value === undefined ? null : String(p.value.value);
      };
      return {
        role: n.role?.value ?? '',
        name: n.name?.value ?? '',
        disabled,
        expanded,
        checked: raw('checked'),
        pressed: raw('pressed'),
        selected: raw('selected'),
      };
    } catch {
      return null;
    }
  }

  // Match an option by its visible label: exact first, then normalized substring —
  // the same generous-but-deterministic rule `find` uses on the page's own words.
  /** Pick an option by label. Returns the outcome, and on failure says WHICH
   *  failure it was — the two are different problems with different next moves,
   *  and collapsing them into `null` is what made the rejection unactionable:
   *
   *    - `notASelect`: the element has no `options` at all, which is every
   *      div-based ARIA combobox. `select` cannot drive it and never will; the
   *      old message claimed no option matched, which is false 100% of the time
   *      because there were no options to match.
   *    - `options`: it is a real select and nothing matched. The labels are
   *      right here, in the call that just failed to find one. */
  private async selectByLabel(
    backendNodeId: number,
    label: string,
  ): Promise<
    | { ok: boolean; label: string; value: string }
    | { notASelect: true }
    | { options: string[]; total: number; reachable: boolean }
    | { probeFailed: true }
  > {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return { probeFailed: true };
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        arguments: [{ value: label }],
        returnByValue: true,
        functionDeclaration: `function(wanted) {
          if (!this.options) return { notASelect: true };
          const norm = s => (s ?? '').normalize('NFKC').toLowerCase().replace(/\\s+/g,' ').trim();
          const target = norm(wanted);
          const opts = [...this.options];
          let opt = opts.find(o => norm(o.label || o.text) === target)
                 ?? opts.find(o => norm(o.label || o.text).includes(target))
                 ?? opts.find(o => norm(o.value) === target);
// Nothing matched: hand back the page's own option labels, and say
// whether they are REACHABLE. An option in a collapsed select has no
// layout box, so admission never sees it and no verb can list it;
// give the select a size or multiple and a plain read returns them
// all. Measured, one select per page: size=1 gives find 0 and read 0
// children, while size=4 and multiple give find 1 and read 40.
// (No backticks in here - this whole function is a template literal.)
          if (!opt) return { options: opts.slice(0, 30).map(o => o.label || o.text),
                             total: opts.length,
                             reachable: this.multiple === true || (this.size ?? 1) > 1 };
// Through the PROTOTYPE's native setter, for the same reason fill uses
// it: a framework that binds a control installs its own value property
// on the INSTANCE, backed by a tracker, so "this.value = x" updates the
// tracker in the same breath and the change event that follows reads as
// no change. The binding never runs.

// option_selected the DOM held "US" and the changeset still held "", so
// validate() failed on a field the page had visibly set and the submit
// did nothing at all. Frameworks without a tracker are unaffected —
// this is the setter their own selects already use.
          var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value');
          if (d && d.set) { d.set.call(this, opt.value); } else { this.value = opt.value; }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
// ok is the WRITE-TIME reading and the verdict no longer trusts it:
// the select postcondition compares the post-settle readback against
// value instead (see the minting site).
          return { ok: this.value === opt.value, label: opt.label || opt.text,
                   value: opt.value };
        }`,
      })) as {
        result: {
          value?:
            | { ok: boolean; label: string; value: string }
            | { notASelect: true }
            | { options: string[]; total: number; reachable: boolean }
            | null;
        };
      };
      return r.result.value ?? { probeFailed: true };
    } catch {
      // The THIRD failure, and it was indistinguishable from "no option
      // matched" — both returned null. A CDP error says nothing about what the
      // control contains, and reporting it as a bad value sends the model
      // hunting for a different option when nothing was ever dispatched.
      return { probeFailed: true };
    }
  }

  // The target's own caret/selection state — the mechanical signals the type
  // path needs: "did the chord select anything?" and "does the field report
  // characters after the collapsed caret?". Best-effort like readValue.
  private async readSelection(
    backendNodeId: number,
  ): Promise<{ start: number; end: number; len: number } | null> {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return null;
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          if (typeof this.selectionStart !== 'number') return null;
          return { start: this.selectionStart, end: this.selectionEnd,
                   len: (this.value ?? '').length };
        }`,
        returnByValue: true,
      })) as { result: { value?: { start: number; end: number; len: number } | null } };
      return r.result.value ?? null;
    } catch {
      return null;
    }
  }

  private async readValue(backendNodeId: number): Promise<string | null> {
    try {
      const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
        object: { objectId?: string };
      };
      if (!object.objectId) return null;
      const r = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        // A contenteditable has no `.value`; its CONTENT is its value. Without
        // this both readings are null, so `fill` compared null against the text
        // it had just written and reported contradicted/value_mismatch on a write
        // This behavior was verified during testing.
        // page's own scorer counted the edit the act had just denied.
        functionDeclaration:
          'function() { ' +
          'if (this.isContentEditable) return this.textContent ?? ""; ' +
          'return this.value ?? null; }',
        returnByValue: true,
      })) as { result: { value?: unknown } };
      return typeof r.result.value === 'string' ? r.result.value : null;
    } catch {
      return null;
    }
  }

  private async hitPoint(backendNodeId: number): Promise<{ x: number; y: number } | null> {
    try {
      const { quads } = (await this.cdp.send('DOM.getContentQuads', { backendNodeId })) as {
        quads: number[][];
      };
      const q = quads[0];
      if (!q || q.length < 8) return null;
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const y = (Math.min(...ys) + Math.max(...ys)) / 2;
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      if (w < 1 || h < 1) return null;
      return { x, y };
    } catch {
      return null;
    }
  }
}

// The AX tree signals "no role here" as '' or the literal 'none'; both mean the
// comparison has nothing to compare.
function roleIsReal(role: string): boolean {
  return role !== '' && role !== 'none';
}

function sameOriginPath(expected: string, actual: string): boolean {
  try {
    const e = new URL(expected);
    const a = new URL(actual);
    const norm = (p: string): string => p.replace(/\/+$/, '') || '/';
    return e.origin === a.origin && norm(e.pathname) === norm(a.pathname);
  } catch {
    return false;
  }
}

// fill's formatting-equivalence normalization — the rule is stated in full at
// its one call site. Unicode property classes, not [a-z0-9]: an ASCII class
// would strip a non-Latin value to "", and two DIFFERENT non-Latin strings
// would then compare equal — a false verified by construction.
function strippedOfFormatting(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '');
}

// Is the readback the request with non-alphanumeric characters INSERTED and
// nothing else? One walk over both, by code point: a readback character either
// matches the next unconsumed request character, or is dressing the field
// added — anything alphanumeric that matches nothing is content the field
// invented, and a request not fully consumed is content the field dropped.
// Both refuse. The rule and its measurement live at the call site.
function isReformattingOf(requested: string, readback: string): boolean {
  const req = [...requested];
  let i = 0;
  for (const ch of readback) {
    if (i < req.length && ch === req[i]) {
      i += 1;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(ch)) return false;
  }
  return i === req.length;
}

function stripFragment(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

function fragmentOnly(href: string, currentUrl: string): boolean {
  return stripFragment(href) === stripFragment(currentUrl);
}
