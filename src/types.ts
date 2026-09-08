// Core graph types. Design: docs/vision.md (The graph); identity: docs/adr/002.

export interface WirNode {
  ref: string;
  backendNodeId: number;
  parentRef: string | null;
  role: string;
  // The RAW AX role, before the implicit-role fallback — private, like
  // backendNodeId, and never projected. Act-time revalidation must compare the
  // browser's own computation to the browser's own computation (the
  // same-computation rule); comparing the DERIVED role to a raw probe produced
  // 9 false stales in 517 live act targets, because the fallback invents roles
  // the AX tree never had.
  axRole: string;
  /** The RAW AX name, before the fallback chain below fills one in — private
   *  like axRole and backendNodeId, and never projected. `name` may come from
   *  aria-label, an img alt, name-from-content, or the post-linkage descendant
   *  fold, none of which `Accessibility.getPartialAXTree` reports back. Act-time
   *  revalidation has to compare the browser's own computation to the browser's
   *  own computation, exactly as it already does for axRole; comparing the
   *  DERIVED name to a raw probe rejects a node that never moved. */
  axName: string;
  name: string;
  description?: string;

  topLayer?: true;
  tag: string;
  state: Record<string, string | boolean>;
  affordances: string[];
  /** How many <option> elements this control owns, or null when it owns none.
   *  The only thing separating a real <select> from a styled wrapper that
   *  compiles with the same role — and `select` refuses the wrapper. */

  fieldName: string | null;
  optionCount: number | null;
  /** The options' own labels, in document order. No refs: inside a closed
   *  <select> an option is not separately addressable, and `act` selects by
   *  label. Without these the model was told to enumerate options with a
   *  query the compiler guarantees returns nothing. */
  optionLabels: string[] | null;
  geometry: { x: number; y: number; w: number; h: number } | null;
  text: string;
  /** The owned text as SEPARATE RUNS, in document order, each carrying the
   *  document index that places it among `childRefs` and the raw, un-normalised
   *  string.
   *
   *  `text` above concatenates them, which is right for an accname and wrong for
   *  reconstruction, in two measured ways. Position: an element's own text used
   *  to be emitted before all of its children, so
   *  `<p>invite a member to <strong>X</strong> or invite a group.</p>` projected
   *  as "invite a member to or invite a group." — fluent, grammatical, and
   *  missing a word (509 instances across 32 URLs). Whitespace: normalisation
   *  drops what source code needs, so a highlighted file's tokens cannot be
   *  rejoined into valid text.
   *
   *  `childRefs` is in document order too, so a projection merges two ascending
   *  sequences by index. */
  textRuns: { index: number; text: string; raw: string }[];
  /** Heading depth, as the BROWSER computes it — `null` on anything that is not
   *  a heading. Read from the AX `level` property rather than derived from the
   *  tag, so `<div role="heading" aria-level="3">` is a level 3 heading exactly
   *  as `<h3>` is. `h1`-`h6` all compile to the role `heading`, so without this
   *  the outline every caller sees is FLAT: 189 headings on one page, no
   *  indication which are sections and which are sub-items. */
  level: number | null;
  href: string | null;
  /** The link's own `rel` attribute when it has one ("next", "prev"…): the
   *  DOM's declaration, kept so a collection read can name the site's own
   *  next-page control without guessing from words. */
  rel?: string | null;
  value: string | null;
  /** The page-authored id of a hidden checkbox/radio represented by this visible
   *  label. `null` for ordinary nodes. Styled controls commonly set the real
   *  input to display:none and leave the label as the only rendered surface;
   *  preserving the association keeps the control's state joinable without
   *  inventing a semantic name for it. */
  controlId: string | null;
  childRefs: string[];
}

export interface WirCollection {
  ref: string;
  itemRefs: string[];
  provenance: 'extracted' | 'inferred';
  label: string;
}

export interface WirGraph {
  epoch: string;
  url: string;
  title: string;
  nodes: Map<string, WirNode>;
  byBackendId: Map<number, string>;
  rootRef: string;
  collections: WirCollection[];
  headings: string[];
  coverage: { complete: boolean; gaps: { region: string; estimatedNodes: number }[] };
  // Whether the document's mutation stream can vouch for THIS graph: false when the
  // graph holds nodes a MutationObserver cannot watch (shadow trees — DOMSnapshot
  // compiles them, open and closed alike; the observer reaches neither). A graph
  // that cannot be vouched for is never served from cache, so `freshness: "live"`
  // keeps meaning what it says.
  mutationObservable: boolean;
  /** Frame ids that contributed admitted nodes to this graph — the main document
   *  plus every same-process child whose content is actually in here. The
   *  freshness vouch must read a mutation token from EACH of them: it used to
   *  read the main frame alone while the graph folded in every document, so a
   *  stale iframe was re-served stamped `live`. Frames that contributed nothing
   *  are deliberately absent; an out-of-process frame is a coverage gap, and
   *  letting its unreadable token poison the vouch would force a recompile every
   *  call on any page carrying an ad. */
  contributingFrames: string[];
  compiledAt: number;
  compileMs: number;

  unrendered: { candidates: UnrenderedCandidate[]; total: number };
}

export interface UnrenderedCandidate {
  tag: string;
  /** The role admission WOULD have given it: the role attribute, else the tag's
   *  implicit role. No AX join — the accessibility tree does not report nodes
   *  the browser is not rendering. */
  role: string;
  /** aria-label / alt, then the node's own text and the text of descendants
   *  that are not candidates themselves, whitespace-normalised. Bounded at
   *  UNRENDERED_TEXT_BOUND characters; `textComplete` says whether it was cut. */
  text: string;
  textComplete: boolean;
  /** The nearest admitted (rendered) ancestor's ref — ROOT_REF when none. */
  containerRef: string;
}

export interface Envelope {
  documentEpoch: string;
  // What the runtime can PROVE about this result's currency — never "was it a cache
  // hit" (that was the published-vs-implemented drift the freshness defect exposed:
  // a graph of unbounded age was stamped `live`).
  //   recompiled — compiled from a capture taken during this call.
  //   live       — served from cache, AND the document's mutation stream is readable
  //                and has not moved since that compile.
  //   dirty      — no compiled graph stands behind this response: an act or a
  //                navigation just invalidated it, and the next find/read recompiles.
  //                Every finish reply says this too: the finish gate reads the
  //                evidence ledger, never a projection, so it has checked nothing
  //                about the document's currency and must not claim `live`.
  freshness: 'live' | 'recompiled' | 'dirty';
  coverageIncomplete: boolean;
  // A gap names what the runtime CANNOT see (a typed coverage gap), so it never
  // carries a continuation — a continuation is a promise the runtime can keep,
  // and for an uncompiled region there is none (defect C4: the old continuation
  // always rejected as unknown_ref).
  gaps?: { region: string; estimatedNodes: number; reason: string }[];
  // `unit` names WHAT the count counts — characters, items, matches, controls.
  // Every mint site (core/find.ts, core/read.ts) has emitted it since the
  // confrontation ledger needed it; only this declaration lagged, so the wire
  // shape and the type disagreed.
  withheld?: { count: number; unit: string; estimated: boolean; continuation: string };
  // WHERE THE BROWSER IS STANDING. Until now this reached the model only in the
  // overview read's payload (core/read.ts), so a targeted read, any find, and
  // most acts carried none — and an episode could spend its last several
  // observations with no idea what page it was on. That matters because a
  // A NAVIGATE request is graded on the LAST document navigation of the episode:
  // arriving and then leaving can score zero.
  // Purely additive — no acceptance condition reads it.
  url: string;

  resolvedDifferently?: { youTyped: string; nowReads: string }[];
  /** SERVED versus SHOWN — see core/host.ts DocumentLedger. `servedUrl` is the
   *  document behind `documentEpoch`: the address the site last served a
   *  document at, loaderId-backed and fragment-free. `shownUrl` is what the
   *  address bar reads now. When they differ, everything since that load was
   *  drawn in the browser — the page fetched in the background and wrote the
   *  address itself — and the site has no record of serving what is shown.
   *  `callsSinceServed` is how many dispatched calls ago that document was
   *  loaded (0: this call loaded it); `routesSinceServed` counts the
   *  same-document address changes since, `lastRoute` the kind of the latest.
   *  Facts only: whether the request needs the site to SERVE the shown page or
   *  needs the served page to stay is the model's call. */
  document: DocumentBlock;
}

/** What a successful navigate REPLACED: the document block as it stood
 *  before the load, plus whether the address had ever been shown. Every
 *  navigate result carries it — a hard load off a client-side route is the
 *  move that loses NAVIGATE tasks, and the model should see it happen even
 *  when the runtime had no grounds to refuse. */
export interface ReplacedBlock extends DocumentBlock {
  clientSideRoute: boolean;
  addressShown: boolean;
}

export interface DocumentBlock {
  servedUrl: string;
  shownUrl: string;
  callsSinceServed: number;
  routesSinceServed: number;
  lastRoute: 'fragment' | 'historyApi' | 'other' | null;
}

export type VerbRequest =
  // all: for a collection target, exhaust it — every item the runtime compiled,
  // as one typed table, paged only by the byte budget with an exact population
  // stated up front. Earned by the aggregation class: ~22 of Opus 5's RETRIEVE
  // failures were min/max/count over a list the model paged by hand through
  // read {target} + c_<n> and got the arithmetic or the coverage wrong.
  // fields: with all:true, each row also carries `links` — every link under it
  // with ref, name and href. Opt-in because measured on three live lists the
  // hrefs alone tripled the row bytes (core/read.ts, recordOf), while the
  // row's `numbers` and `values` — the fields the aggregation failures needed —
  // stayed under the doubling bound and ride by default.
  | {
      verb: 'read';
      target?: string | null;
      cursor?: string | null;
      all?: boolean | null;
      fields?: boolean | null;
    }
  | {
      verb: 'find';
      role?: string | null;
      name?: string | null;
      within?: string | null;
      state?: string | null;
      limit?: number | null;
      cursor?: string | null;
    }
  | {
      verb: 'act';
      ref: string;
      action: 'click' | 'fill' | 'select' | 'type' | 'key' | 'upload' | 'scroll' | 'hover';
      value?: string | null;
      expect?: ActExpect | null;
      until?: ActUntil | null;
    }
  | { verb: 'navigate'; url: string; force?: boolean | null }
  | {
      verb: 'finish';
      answer: string;
      evidenceRefs: string[];
      status?:
        | 'success'
        | 'not_found_error'
        | 'action_not_allowed_error'
        | 'permission_denied_error'
        | null;
    };

// ONE union per contract (defect C5: three divergent rejection unions and a
// stringly-typed evidence field let published and implemented drift apart).
// blocked_by_overlay is its own kind rather than a flavour of stale_ref because
// the two demand opposite responses: a stale ref is repaired by re-resolving,
// and a blocked one cannot be — the ref is still good, the page is still where
// it was, and only dismissing the overlay changes anything. Collapsing them is
// what sent two recorded episodes into a re-read loop until the budget ran out.
export type RejectionKind =
  | 'stale_ref'
  | 'unknown_ref'
  | 'invalid_args'
  | 'finish_rejected'
  | 'blocked_by_overlay'
  // navigation_failed: the browser refused or could not complete a navigation the
  // model asked for — the host blocked it, the name did not resolve, the connection
  // was refused, or the load timed out. Fixed local containers may never produce
  // this, while live tasks can encounter it immediately.
  //
  // A navigation that does not happen is ordinary and recoverable: the page has not
  // moved, every ref is still valid, and the model can go back to a search result or
  // try another link. Making it fatal converts a site hiccup into a guaranteed zero.
  | 'navigation_failed'
  // navigate_would_replace_served_document: the bar shows a client-side route
  // — the site never served a document for it (envelope `document.shownUrl`
  // differs from `document.servedUrl`) — and the requested URL is any address
  // a load of which would make IT the last document the site served, replacing
  // the record of the page actually loaded and discarding what is shown. Earned
  // first by ten map episodes (356, 757-767) that navigated to the shown

  // a different path from the closure and slipped past a guard keyed on the
  // shown address only. Refused, never forbidden: `force: true` does it anyway.
  | 'navigate_would_replace_served_document'
  // navigate_constructed_address: the URL's path was seen but THIS address —
  // its query string — never was: the model composed it. Refused only while
  // the current document is a client-side route (shown != served), because
  // that is the one case where a hard load of an invented address destroys
  // what the site had been recording. Measured before the rule: a corpus gate
  // found 25 passing episodes that navigated to a constructed query URL on

  // /directions?route=<coords> twice, once with the wrong city, and each load
  // became the last document served. `force: true` does it anyway.
  | 'navigate_constructed_address'
  // navigate_would_discard_shown_state: the requested URL is the address of
  // the document the site DID serve, while the bar shows a client-side route
  // on top of it (shown != served). A load would reach the same served
  // address and discard everything the page reached since without a load.

  // served "/" with "/directions?…&route=…" shown, the model navigated to "/"
  // — admitted, the directions state gone, the address then rebuilt by hand
  // and loaded as a document. Refused, never forbidden: `force: true` does it
  // anyway; a reload with nothing routed (shown == served) is not refused.
  | 'navigate_would_discard_shown_state';

export interface Rejection {
  rejected: { kind: RejectionKind; reason: string; repair?: string };
}

export type EffectVerdict = 'verified' | 'contradicted' | 'unknown';

/** What an act was DECLARED to do — the caller's intent, in four mechanical
 *  claims (core/expect.ts). Every key optional, any combination.
 *    text        the page's own words, newly present in the rendered document
 *                after settle (normalized substring, find's rule).
 *    state       the target's own state after the act — the AX vocabulary the
 *                graph exposes; value compared exactly after trim.
 *    navigation  origin+path (or a path on the current origin) the document
 *                must be SERVED at afterwards — document.servedUrl, never the
 *                address bar.
 *    sent        a request the receipt must hold: method (default any
 *                non-GET), path (trailing slashes trimmed), and every field
 *                name=value (string compare after trim), not refused. */
export interface ActExpect {
  text?: string | null;
  state?: {
    checked?: boolean | null;
    selected?: boolean | null;
    expanded?: boolean | null;
    disabled?: boolean | null;
    value?: string | null;
  } | null;
  navigation?: string | null;
  sent?: {
    method?: string | null;
    path?: string | null;
    fields?: Record<string, string> | null;
  } | null;
}

/** The declaration confronted with what the runtime observed. Reported beside
 *  the mechanical verdict, never folded into it: `held: false` does not make
 *  an act contradicted, and a held `sent` or `navigation` is what lets a
 *  local-only act satisfy the MUTATE gate — the receipt or the served address
 *  proved the declared intent. Every failed key carries what was observed,
 *  verbatim. */
export interface ActExpectation {
  declared: ActExpect;
  held: boolean;
  failed?: { key: string; wanted: unknown; observed: string }[];
}

/** A condition an act's settle extends to. Flat, closed keys, and EXACTLY ONE of
 *  the five condition keys when present; `withinMs` bounds the extension
 *  (default 5000, at most 15000). Never a sleep: the runtime polls the
 *  condition — the page's mutation stream for text/gone/role, the browser's own
 *  AX computation for state, this act's own request ledger for network — and the
 *  result says whether it held. A condition that never held is `timed_out`, a
 *  fact beside the act's own verdict, which it never changes.
 *
 *    text    — the string appears in the document: the same NFKC / case-folded /
 *              whitespace-collapsed substring `find` uses over a rendered node's
 *              accessible name, owned text and description (core/find.ts
 *              normalize). The page's own words, never a pattern.
 *    gone    — no rendered node carries the string any more (a spinner's label,
 *              "Loading…").
 *    role    — a rendered node with that role (find's own role equality) and,
 *              when given, that name substring, exists.
 *    state   — the target's — or the given ref's — own state after
 *              revalidation: checked / selected / expanded / disabled as the
 *              accessibility tree reports them, value as the control holds it.
 *    network — "idle": no request this act's window recorded is still in
 *              flight, held for 500 ms (core/act.ts UNTIL_IDLE_MS). Attribution
 *              is by window, exactly as the receipt's: a timer's request counts. */
export interface ActUntil {
  text?: string;
  gone?: string;
  role?: { role: string; name?: string };
  state?: {
    ref?: string;
    checked?: boolean;
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    value?: string;
  };
  network?: 'idle';
  withinMs?: number;
}

/** What the extension observed. `afterMs` counts from the act's dispatch, so it
 *  is comparable with the receipt's `atMs` — and since `withinMs` bounds only
 *  the EXTENSION, which begins after the act's own settle, a `timed_out` reads
 *  afterMs = settle + withinMs (measured: 2,419 ms for withinMs 2000 on a
 *  same-document click). `observed` is what the LAST check
 *  saw — the matched node, the texts still present, the requests still open,
 *  the state the control holds — plus the accounting: how many times the
 *  document was recompiled against the cap (core/act.ts UNTIL_RECOMPILE_CAP). */
export interface ActUntilResult {
  declared: ActUntil;
  verdict: 'condition_met' | 'timed_out';
  afterMs: number;
  observed: string;
}

export interface ActReceipt {
  /** How the requests were attributed to this act. `window`: everything the
   *  browser sent between dispatch and the end of the settle. The runtime cannot
   *  separate a request the act caused from one a timer caused; it reports the
   *  timing and the initiator and lets the reader decide. `unarmed`: this action
   *  installs no network observers (scroll, upload), so nothing was watched. */
  attribution: 'window' | 'unarmed';
  /** The span observed, in ms after dispatch. */
  windowMs: number;
  /** How many requests the window held in all, every type included. */
  total: number;
  requests: ReceiptRequest[];
  withheld?: { count: number; estimated: false; unit: 'requests'; continuation: string };
  note?: string;
  /** Sent field values the page had not shown before the caller typed them
   *  (`field=value`, verbatim, bounded) — core/session.ts GateEligibleAct.unseen,
   *  the same block, delivered at act time so the model sees it before finish. */
  unseen?: string[];
  /** The check could not be made honestly (a ledger overflowed); says which. */
  unseenUnchecked?: string;
}

export interface ReceiptRequest {
  atMs: number;
  type: string;
  method: string;
  /** origin + path + query. The fragment never reaches the wire. */
  url: string;
  /** null: no response was observed inside the window. */
  status: number | null;
  /** The browser's own reason a request did not complete (net::ERR_…). */
  failed?: string;
  frame?: 'child';
  initiator: string;
  body?: ReceiptBody;
}

export interface ReceiptBody {
  encoding: 'form' | 'json' | 'multipart' | 'text';
  fields: Record<string, string>;
  withheld?: { count: number; estimated: false; unit: 'fields'; continuation: string };
  note?: string;
}

// The closed set the executor emits — every arm exists in core/act.ts, nowhere
// else. Grown only with the act paths that mint them, never speculatively.
export type EffectEvidence =
  | 'value_set'
  | 'value_mismatch'
  // text_typed: a `type` act observed its change (window value moved, or
  // mutation records in the settle window). Never an equality claim — a
  // virtualized editor's readable value is a window, not the document — and
  // the type path never mints `contradicted` for the same reason (a window

  // fill's comparator reading contradicted on a correct mechanism).
  | 'text_typed'
  | 'option_selected'
  | 'selection_mismatch'
  // selection_changed: a `key` act moved the target's own caret or selection
  // WITHOUT changing how much content is there. LOCAL: where a caret sits is
  // browser state, never a site change. It exists because the key the artifact
  // earned — Control+a — moves nothing else at all, so its only alternative was
  // `no_observable_change_yet` on a press that worked.
  | 'selection_changed'
  // text_edited: a `key` act changed the AMOUNT of content in the target. Split

  // `Control+h` is delete-backward, so the model pressed what it believed was
  // find-and-replace and ate the leading `<` of index.html — window 383 -> 382
  // characters — and the runtime answered `verified/selection_changed`. True of
  // the field inspected, a lie about what happened; the same shape as
  // `type "Control+a"` reporting `verified/text_typed`. A keypress that changes
  // content must say so, and the delta names direction and size. LOCAL, like
  // text_typed: editing a buffer proves nothing about the site.
  | 'text_edited'
  | 'navigated_to_destination'
  | 'navigated_elsewhere'
  | 'no_navigation_observed'
  | 'navigation_post'
  | 'navigation_get'
  | 'navigation'
  | 'target_state_changed'
  | 'no_observable_change_yet'
  | 'dom_mutated'
  // request_committed: a click's local rendering (dom_mutated territory) was
  // accompanied by a same-origin non-GET XHR/Fetch request answered 2xx inside

  // read-via-POST in-window mints it too (measured, not separable, owned).
  | 'request_committed'
  // file_attached: a file input now holds the named file. Attaching is a LOCAL
  // effect — the bytes have gone nowhere until the form is submitted — so this
  // is never gate-eligible, exactly like value_set. The submit that follows
  // carries the gate.
  | 'file_attached'
  // scrolled: a scroll act moved its container AND the page rendered content it
  // had not rendered before. LOCAL: what changed is what the browser has drawn,
  // never the site, so this can no more satisfy the MUTATE gate than value_set.
  | 'scrolled'
  | 'scrolled_no_new_content'
  | 'dialog_dismissed'
  | 'dialog_accepted'
  | 'download_started'
  | 'popup_opened';
