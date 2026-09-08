// read — structure and text, projected. Preservation invariants (docs/lessons.md):
// page's own words verbatim; handles survive; no byte-prefix truncation presented as
// complete — over-budget content becomes pagination or an explicit continuation.

import {
  LABEL_BOUND,
  bounded,
  boundedLabel,
  collectSubtree,
  subtreeText,
  type InlineOffer,
} from './text.js';
import type { WirGraph, WirNode } from './types.js';

const CONTROLS_PAGE = 50;
// Collections were the one list in the overview with no bound at all, while
// `controls` beside them paged at 50 with an exact count and a continuation. On a
// threaded discussion the repeats-with rule mints one collection per reply nest,

// controls payload in the same response — and it stayed in context for the rest of

// the forum listing and 107,326 on a post page; the episode reached 177,453 input
// tokens and its last call took 79 seconds.
const COLLECTIONS_PAGE = 25;
// 12, not 30: 67,233 region refs were delivered across the corpus and 0.9% were ever
// used, at 10.2% of overview bytes. Paged by the `r_` cursor that already exists, so
// regionsTotal and moreRegions still reach every one of them.
const REGIONS_PAGE = 12;
const HEADINGS_PAGE = 30;
// Announcements are few or the page is shouting; either way the page beyond 4

// `.slice(0, 4)` and a silent 200-char text cut: a 5th alert, or char 201 of a
// long one, appeared nowhere in the response and no continuation reached it

const ANNOUNCEMENTS_PAGE = 4;
// The sixth list. Free-standing text — a total, a price, a status line, a route
// readout — belongs to none of the other five, so before this it was dropped
// from the overview with NO accounting: `withheld` reflects the controls pager
// alone, so a page whose controls all fit reported nothing withheld while the

// "2040 records found" — each absent from `read {}`, each returned by `find`
// on the same graph at the same epoch. That is the zero-tolerance class: the
// runtime saw it and did not show you.
const TEXT_PAGE = 25;
const ITEMS_PREVIEW = 10;
// Ranks 1-2 keep a preview, ranks 3+ keep only their ref + exact count + continuation.
// Both numbers are a cost choice over a measured 1.0% item-ref utilisation, not a
// claim about the page — every withheld item stays one stated call away.
const ITEMS_TAIL_PREVIEW = 5;
const CHILD_PAGE = 40;
// A child's subtree census (see `descendantsOf`). Per child it matches
// ITEMS_PREVIEW; per response it is capped, because the census is paid on EVERY
// child of a targeted read. Ten entries per child on a 40-child page measured
// ~24KB added to one response, against an arm-level budget of 47,891 bytes (5%
// of the failed-10 arm's 957,812).
//
// The per-response budget is shared EVENLY and may round to zero, which is the
// whole point: a ladder is a narrow-read phenomenon (the measured one descends
// nodes of 1, 3, 1 and 1 children), while a caller looking at 40 children
// already holds 40 refs and their content and is not stuck. So the census is
// spent where the caller has few places to go, and a wide read keeps the exact
// residual count and the continuation it has today — never worse than before,
// far better exactly where the stalls are. Measured over the complete

// +96 bytes per read mean, which reweighted by the arm's own children-per-read
// shapes estimates 103.0% of the OFF total against a 105% bar

const REACHABLE_PER_CHILD = 10;
const REACHABLE_PER_READ = 24;
// The exhausting read's page bound, in BYTES of row JSON rather than a row
// count, because rows are what vary: a storefront item is ~150 B of label and
// price, an admin grid row ~350 B of cells. Measured before this existed

// storefront page cost 19,836 B for one read {target} — the children
// projection's per-child `descendants` census, useful for reaching a control,
// is dead weight when the question is "what is the cheapest item". 24,000 keeps
// a 36-item page and a 20-row grid page whole and pages a 200-row grid at a
// row boundary, with the population stated up front and every row one stated
// call away — a bound is legal only as pagination (docs/vision.md).
const TABLE_BYTES = 24_000;

/** A known node the exhausting read cannot serve — it heads no collection, so
 *  there is no population to state. Distinct from `null` (unknown ref): the
 *  repair names the collection the runtime CAN exhaust from here. */
export interface ReadRejection {
  rejected: { reason: string; repair: string };
}

export interface ReadResult {
  payload: Record<string, unknown>;
  withheld: { count: number; unit: string; estimated: boolean; continuation: string } | null;
  /** Bounds minted INSIDE the payload's strings. Reported, never re-parsed. */
  inline?: InlineOffer[];
  /** For every continuation this result minted over a list of entries: the
   *  refs delivered so far through that chain — this response's page plus the
   *  record it resumed. The session keeps these keyed by the continuation
   *  call, and hands the record back when the continuation is consumed, so
   *  the next page serves what was NOT delivered rather than an offset into
   *  whatever the list has become (see rankAndPage). */
  chains?: { continuation: string; served: string[] }[];
}

// Every list in the overview obeys the same contract: named entries first (a
// caller reads names, not refs), then document order within a tier, then a page
// with an exact count of what is left and a continuation that reaches it.
// Ordering is allowed, removal is not — so an anonymous region stays reachable.
//

// 376 regions, 189 headings and 200 collections in one `read {}` — 107KB, of
// which the per-comment vote form and reply nest accounted for most — and it

// input tokens, final call 79s at 177K).
// RESUME BY IDENTITY, NEVER BY OFFSET. Every act nulls the graph cache, and a
// same-document recompile — same epoch, refs survive — can change list
// composition, so a `c_50` minted against the old ranking used to resume at
// offset 50 of a DIFFERENT list: entries that moved up below the cursor were
// never delivered, with zero disclosure. The zero-tolerance recall class,

// act between page 1 and its continuation left a control on the page that no
// page ever delivered).
//
// So a continuation resumes against the record of what its chain has actually
// delivered (`prior`, kept by the session keyed on the continuation call):
// the page is the first pageSize entries NOT yet delivered, in current rank
// order. Complete by construction under any recomposition — survivors are
// neither re-served nor skipped, new entries surface in later pages. The
// cursor's number is the count delivered so far, kept for shape (`c_<n>`),
// trusted never.
//
// A well-formed cursor with NO delivery record — minted against a replaced
// document, or never minted — cannot resume anything: it serves from the
// start and DISCLOSES (`reset`, surfaced as cursorReset in the payload).
// Before, it silently served offset n of a list whose first n entries the
// caller had never seen; past the end, an empty page indistinguishable from
// completeness.
function rankAndPage<T>(
  items: T[],
  named: (x: T) => boolean,
  weight: (x: T) => number,
  cursor: string | null,
  prefix: string,
  pageSize: number,
  unit: string,
  refOf: (x: T) => string,
  prior: ReadonlySet<string> | null,
): {
  page: T[];
  total: number;
  more: { count: number; unit: string; estimated: boolean; continuation: string } | null;
  chain: { continuation: string; served: string[] } | null;
  reset: boolean;
} {
  const ranked = items
    .map((x, i) => ({ x, i }))
    .sort(
      (a, b) => Number(named(b.x)) - Number(named(a.x)) || weight(b.x) - weight(a.x) || a.i - b.i,
    )
    .map((v) => v.x);
  const resumes = cursor !== null && new RegExp(`^${prefix}_\\d+$`).test(cursor);
  let page: T[];
  let left: number;
  let servedCount: number;
  let reset = false;
  if (resumes && prior !== null) {
    const undelivered = ranked.filter((x) => !prior.has(refOf(x)));
    page = undelivered.slice(0, pageSize);
    left = undelivered.length - page.length;
    servedCount = prior.size + page.length;
  } else {
    reset = resumes;
    page = ranked.slice(0, pageSize);
    left = Math.max(0, ranked.length - pageSize);
    servedCount = page.length;
  }
  const more =
    left > 0
      ? {
          count: left,
          unit,
          estimated: false,
          continuation: JSON.stringify({ verb: 'read', cursor: `${prefix}_${servedCount}` }),
        }
      : null;
  return {
    page,
    total: ranked.length,
    more,
    reset,
    // The chain record folds `prior` in only when THIS list resumed it: on a
    // fresh page the prior belongs to whichever list the cursor addressed,
    // and unioning another list's refs into this chain could mark an entry
    // delivered that never was.
    chain:
      more === null
        ? null
        : {
            continuation: more.continuation,
            served: [...(resumes && prior !== null ? prior : []), ...page.map(refOf)],
          },
  };
}

// A cursor that matches NONE of this call shape's namespaces is a steering
// rejection, never a silent page 1. parseCursor answers a foreign prefix with
// offset 0 — which is exactly right for the overview's five independent lists
// sharing one cursor argument (`c_50` must not advance regions), and exactly
// wrong when the cursor matches no list at all: a `t_x` typo re-served page 1
// byte-identical, apparent non-progress the caller could not tell from a
// This behavior was verified during testing.
// repair is the literal valid continuation for the list, computed by running
// the call un-cursored; an unknown target returns null so the caller's own
// unknown_ref path answers. An absent cursor still means page 1.
export function badCursor(
  g: WirGraph,
  target: string | null,
  cursor: string,
  all = false,
  fields = false,
): { reason: string; repair: string } | null {
  // The exhausting read has ONE list — rows — and one cursor for it. A `c_`
  // or `t_` cursor on an all:true call would page the plain read's children
  // or text under the table's name, and the caller could not tell the two
  // apart; so it is a foreign cursor here, answered with the table's own
  // continuation.
  if ((all ? /^i_\d+$/ : target ? /^[tc]_\d+$/ : /^[rahkcp]_\d+$/).test(cursor)) return null;
  const fresh = target ? readTarget(g, target, null, null, all, fields) : readOverview(g, null);
  if (fresh === null || 'rejected' in fresh) return null;
  const reason = all
    ? `cursor ${JSON.stringify(cursor)} is not one an all:true read mints — i_<n> pages the table's rows`
    : target
      ? `cursor ${JSON.stringify(cursor)} is not one this target's read mints — t_<n> pages its text, c_<n> its children`
      : `cursor ${JSON.stringify(cursor)} is not one the overview mints — its cursors look like r_/a_/h_/k_/c_/p_<n>`;
  return {
    reason,
    repair:
      fresh.withheld?.continuation ??
      (all
        ? `{"verb":"read","target":"${target}","all":true${fields ? ',"fields":true' : ''}}`
        : target
          ? `{"verb":"read","target":"${target}"}`
          : '{"verb":"read"}'),
  };
}

export function readOverview(
  g: WirGraph,
  cursor: string | null,
  prior: ReadonlySet<string> | null = null,
): ReadResult {
  // Collected, not re-parsed. See InlineOffer in core/text.ts for why.
  const inline: InlineOffer[] = [];
  const all = [...g.nodes.values()];
  // Landmarks, plus whatever the browser holds in its TOP LAYER (a modal
  // <dialog>, an open popover): an open modal is the region the page is
  // showing RIGHT NOW, and until it was listed here a caller learned of it
  // only by having a click refused as blocked_by_overlay. Marked `topLayer`
  // and ranked first — one short entry per open layer, usually none.
  const regionsAll = all
    .filter(
      (n) =>
        n.topLayer === true ||
        ['banner', 'navigation', 'main', 'contentinfo', 'search', 'form'].includes(n.role),
    )
    .map((n) => ({
      ref: n.ref,
      role: n.role,
      name: n.name || undefined,
      ...(n.description ? { description: n.description } : {}),
      ...(n.topLayer ? { topLayer: true as const } : {}),
    }));
  // `prior` belongs to exactly one list — the one whose prefix the cursor
  // carries — and rankAndPage only reads it when the prefix matches, so
  // passing the same record to every list is safe.
  const r = rankAndPage(
    regionsAll,
    (x) => Boolean(x.name) || x.topLayer === true,
    (x) => (x.topLayer ? 1 : 0),
    cursor,
    'r',
    REGIONS_PAGE,
    'regions',
    (x) => x.ref,
    prior,
  );
  const regions = r.page;
  // A live region is the page TELLING YOU SOMETHING, and the overview did not
  // carry it. `alert` and `status` exist in ARIA for exactly one purpose — an
  // announcement the user must receive now — and after an action that
  // announcement IS the answer: what the form rejected, or that it was accepted.
  //
  // This behavior was verified during testing.
  // "Form submitted successfully! The secret is: …" into a role=alert node,
  // `find` matched it, and `read {}` returned regionsTotal 1 with no trace of it.
  // The episode searched, found nothing, and gave up on a request it had completed.
  //
  // The TEXT travels with it, not just a ref: an alert's accessible name is
  // usually empty — content is not a name source for the role — so a bare ref
  // would announce that something was announced and charge another call to learn
  // what. Bounded like every other list here, and disclosed like one: entries
  // page under their own `a_` cursor with an exact total, and the text is
  // `bounded`, not `boundedLabel` — the text is delivered content, so the
  // continuation must reach the withheld characters of the SAME reconstruction
  // the marker cut, and a plain read of the node returns its structure, never
  // those characters (the C4 class, core/text.ts). At LABEL_BOUND, not a
  // private width: bounding one node's text at two widths mints two `t_`
  // chains that never consume each other (boundedLabel's measured defect).
  const announcementsAll = all
    .filter((n) => n.role === 'alert' || n.role === 'alertdialog' || n.role === 'status')
    .map((n) => ({ n, text: subtreeText(n, g) }))
    .filter((x) => x.text !== '');
  const a = rankAndPage(
    announcementsAll,
    () => false,
    () => 0,
    cursor,
    'a',
    ANNOUNCEMENTS_PAGE,
    'announcements',
    (x) => x.n.ref,
    prior,
  );
  const announcements = a.page.map(({ n, text }) => ({
    ref: n.ref,
    role: n.role,
    text: bounded(text, n.ref, 0, LABEL_BOUND, inline),
  }));
  const headingsAll = g.headings
    .map((ref) => g.nodes.get(ref)!)
    // `level` is what makes a list of headings an OUTLINE. Without it a reader
    // gets 189 names in document order with no way to tell a section from a
    // sub-item — every `h1`-`h6` compiles to the same role, and no projection
    // emitted the tag. Omitted rather than guessed when the browser did not
    // compute one.
    .map((h) => ({
      ref: h.ref,
      name: h.name || h.text,
      ...(h.level !== null ? { level: h.level } : {}),
    }));
  const h = rankAndPage(
    headingsAll,
    (x) => Boolean(x.name),
    () => 0,
    cursor,
    'h',
    HEADINGS_PAGE,
    'headings',
    (x) => x.ref,
    prior,
  );
  const headings = h.page;
  // Order before paging, never filter: a named collection of 25 comments is worth
  // more to a reader than an anonymous pair, but the pair is still real structure
  // and dropping it would be loss. Ranking may order, never remove — so the
  // anonymous ones sort last and stay reachable through the continuation.
  const ranked = g.collections
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const labelled = Number(Boolean(b.c.label)) - Number(Boolean(a.c.label));
      if (labelled !== 0) return labelled;
      const size = b.c.itemRefs.length - a.c.itemRefs.length;
      if (size !== 0) return size;
      return a.i - b.i; // stable: document order within a tier
    })
    .map((x) => x.c);

  // The same identity resume rankAndPage performs, on the collections list's
  // own slice (its previews are rank-graded, so it never joined rankAndPage).
  const kResumes = cursor !== null && /^k_\d+$/.test(cursor);
  let kPage: typeof ranked;
  let collectionsLeft: number;
  let kServed: number;
  let kReset = false;
  if (kResumes && prior !== null) {
    const undelivered = ranked.filter((c) => !prior.has(c.ref));
    kPage = undelivered.slice(0, COLLECTIONS_PAGE);
    collectionsLeft = undelivered.length - kPage.length;
    kServed = prior.size + kPage.length;
  } else {
    kReset = kResumes;
    kPage = ranked.slice(0, COLLECTIONS_PAGE);
    collectionsLeft = Math.max(0, ranked.length - COLLECTIONS_PAGE);
    kServed = kPage.length;
  }
  const collections = kPage.map((c, rank) => {
    // ITEM PREVIEWS ARE GRADED BY THE RANK ABOVE, not issued flat.
    //
    // Measured over 96,104 collection-item refs delivered across the recorded
    // corpus: 1.0% were ever used — as an act target, a read target, a find scope
    // or an evidence ref. Collections at rank 10+ cost 2.64 MB at 0.06% use. The
    // overview is 80.6% of all observation bytes and collections are 46% of it, so
    // this one slice is ~37% of everything the runtime has ever shipped, at a 1-in-100
    // hit rate.
    //
    // The ranking already knows which collection is worth previewing — labelled
    // first, then largest — so spend the preview where the rank says, rather than
    // flat across 25 collections whose tail nobody reads.
    //
    // NOTHING IS REMOVED, and that is the whole legality of it. Every collection
    // keeps its ref, its EXACT itemCount, its provenance, and a continuation that
    // reaches every withheld item. The cut is at an item boundary, so no partial
    // item is presented as whole. Ranking still only orders — a rank-3 collection
    // is one call away, exactly as a rank-0 collection's item 11 always was.
    //
    // Grading, not deleting, is what protects the scar this preview exists for:
    // This behavior was verified during testing.
    // (see itemSummary below). The collection the ranking puts FIRST keeps its full
    // preview, so the cheap path on the page's main list is untouched.
    const preview = rank === 0 ? ITEMS_PREVIEW : rank <= 2 ? ITEMS_TAIL_PREVIEW : 0;
    const shown = c.itemRefs.slice(0, preview);
    return {
      ref: c.ref,
      label: c.label || undefined,
      itemCount: c.itemRefs.length,
      provenance: c.provenance,
      ...(shown.length > 0
        ? { items: shown.map((r) => itemSummary(g.nodes.get(r)!, g, inline)) }
        : {}),
      ...(c.itemRefs.length > shown.length
        ? // `estimated` is not decoration: it is what tells the continuation ledger
          // this count accounts for withheld content rather than describing the node.
          {
            moreItems: {
              count: c.itemRefs.length - shown.length,
              unit: 'items',
              estimated: false,
              continuation: `{"verb":"read","target":"${c.ref}"}`,
            },
          }
        : {}),
    };
  });
  const kMore =
    collectionsLeft > 0
      ? {
          count: collectionsLeft,
          unit: 'collections',
          estimated: false,
          continuation: JSON.stringify({ verb: 'read', cursor: `k_${kServed}` }),
        }
      : null;
  const kChain =
    kMore === null
      ? null
      : {
          continuation: kMore.continuation,
          // Same rule as rankAndPage's chain: prior folds in only when this
          // list is the one the cursor resumed.
          served: [...(kResumes && prior !== null ? prior : []), ...kPage.map((c) => c.ref)],
        };

  // `controls` was the one overview list still in raw graph order, while the
  // contract stated above — and obeyed by regions, headings and collections —
  // is named entries first. On a page whose modal opens at the end of the
  // This behavior was verified during testing.
  // 57 controls, ending on four anonymous dialog wrappers, with the textbox the
  // episode then spent five calls hunting inside the withheld 7.
  const c = rankAndPage(
    all.filter((n) => n.affordances.length > 0).map(controlSummary),
    (x) => Boolean(x['name']),
    () => 0,
    cursor,
    'c',
    CONTROLS_PAGE,
    'controls',
    (x) => String(x['ref']),
    prior,
  );

  // Everything with OWNED text that no other list delivered. `text` on a node is
  // its DIRECT text children only (core/types.ts:44), so a parent and its child
  // never both carry the same words and this cannot double-count. Excluded by
  // REF against each list's full population rather than its delivered page —
  // otherwise paging one list would silently change what this one contains.
  // Collection items are excluded too: a collection already gives a route to
  // them, and re-listing 25 comments here would bury the free-standing text this
  // exists to surface. Document order, no ranking claim: ordering may reorder,
  // never remove, and every entry is reachable through the continuation.
  const deliveredElsewhere = new Set<string>([
    ...regionsAll.map((x) => x.ref),
    ...announcementsAll.map((x) => x.n.ref),
    ...headingsAll.map((x) => x.ref),
    ...all.filter((n) => n.affordances.length > 0).map((n) => n.ref),
  ]);
  for (const col of g.collections) for (const ref of col.itemRefs) deliveredElsewhere.add(ref);
  // Exclude by ANCESTRY, not just by the node itself. A link's inner span is a
  // generic node with owned text and no affordance of its own, so a ref-only
  // test admitted every one of them — the first page of a storefront overview
  // came back as "Skip to Content", "Beauty & Personal Care", "Sports &
  // Outdoors": the nav link labels, which `controls` already delivers by name.
  // If a delivered node is above you, your words are already on the page
  // somewhere the reader can act on.
  // NOISE IS AN ORDERING PROBLEM, NOT A FILTERING ONE. A link's inner span is a
  // generic node with owned text, so the first page of a storefront overview came
  // back as "Skip to Content", "Beauty & Personal Care" — nav labels `controls`
  // already delivers. The obvious repair was to exclude anything under a
  // delivered ancestor; measured, that emptied the list on all three pages,
  // because on a real page almost every text node sits under SOMETHING delivered.
  // So rank instead: chrome sorts last, substance first, and nothing is removed —
  // ordering may reorder, never remove.
  const chromeRegions = new Set<string>(
    all.filter((n) => ['navigation', 'banner', 'contentinfo'].includes(n.role)).map((n) => n.ref),
  );
  const inChrome = (n: WirNode): boolean => {
    let cur = n.parentRef ? g.nodes.get(n.parentRef) : undefined;
    let hops = 0;
    while (cur && hops < 32) {
      if (chromeRegions.has(cur.ref)) return true;
      cur = cur.parentRef ? g.nodes.get(cur.parentRef) : undefined;
      hops += 1;
    }
    return false;
  };
  const textAll = all
    .filter((n) => n.text !== '' && !deliveredElsewhere.has(n.ref))
    .map((n) => ({ ref: n.ref, role: n.role, text: n.text, chrome: inChrome(n) }));
  const t = rankAndPage(
    textAll,
    (x) => !x.chrome,
    () => 0,
    cursor,
    'p',
    TEXT_PAGE,
    'text',
    (x) => x.ref,
    prior,
  );
  const text = t.page.map((x) => ({
    ref: x.ref,
    role: x.role,
    text: bounded(x.text, x.ref, 0, LABEL_BOUND, inline),
  }));

  return {
    payload: {
      title: g.title,
      url: g.url,
      // Before regions: when the page has just announced something, that is the
      // most important thing in the overview, not the least. The total and the
      // continuation appear only when an entry was withheld — the common case
      // is one banner, and a count equal to the list's own length is noise.
      ...(announcements.length > 0 ? { announcements } : {}),
      ...(a.more ? { announcementsTotal: a.total, moreAnnouncements: a.more } : {}),
      regions,
      regionsTotal: r.total,
      ...(r.more ? { moreRegions: r.more } : {}),
      headings,
      headingsTotal: h.total,
      ...(h.more ? { moreHeadings: h.more } : {}),
      collections,
      collectionsTotal: ranked.length,
      // Its own continuation rather than the envelope's `withheld`, which already
      // carries the controls page: two independent lists cannot share one cursor,
      // and a single number covering both would be an accounting the caller
      // cannot act on. Same shape as a collection's own `moreItems`.
      ...(kMore ? { moreCollections: kMore } : {}),
      controls: c.page,
      controlsTotal: c.total,
      // Its own total and continuation, like every other list. Present only when
      // the page has such text at all, so a page with none says nothing rather
      // than carrying an empty list.
      ...(text.length > 0 ? { text, textTotal: t.total } : {}),
      ...(t.more ? { moreText: t.more } : {}),
      // The disclosure. Only the cursor's own list can reset, and it does so
      // exactly when there is no delivery record to resume — the cursor was
      // minted against a replaced document, or never minted. The re-serve
      // costs bytes; the silent skip it replaces cost recall.
      ...(r.reset || a.reset || h.reset || kReset || c.reset
        ? {
            cursorReset: {
              received: cursor,
              note:
                'no delivery record for this continuation against the current document ' +
                '(it was minted against a replaced document, or never minted) — ' +
                'serving the list from the start so nothing is skipped',
            },
          }
        : {}),
    },
    withheld: c.more,
    inline,
    chains: [r.chain, a.chain, h.chain, kChain, c.chain, t.chain].filter(
      (x): x is { continuation: string; served: string[] } => x !== null,
    ),
  };
}

export function readTarget(
  g: WirGraph,
  target: string,
  cursor: string | null,
  prior: ReadonlySet<string> | null = null,
  all = false,
  fields = false,
): ReadResult | ReadRejection | null {
  const inline: InlineOffer[] = [];
  const node = g.nodes.get(target);
  if (!node) return null;
  if (all) return readCollectionAll(g, node, cursor, prior, fields);
  // A `t_` cursor pages the node's own TEXT, which is what the bound above
  // promises. Answering it with children would repeat the defect it fixes.
  if (cursor !== null && /^t_\d+$/.test(cursor)) {
    const from = parseCursor(cursor, 't');
    const whole = subtreeText(node, g);
    const rest = Math.max(0, whole.length - from - LABEL_BOUND);
    return {
      // `reconstructedTotal`, not `textTotal`. This number is the length of the
      // string THIS VERB BUILDS by walking the subtree and joining its runs: it
      // includes the separators the join inserts and excludes the run that
      // sourced the label. That makes it the correct denominator for this
      // cursor, and NOT the page's own text length. Calling it `textTotal`
      // invited exactly the reading `d542915` had to remove from `act`, where a
      // window length was presented as a document length.
      payload: {
        node: nodeDetail(node, { g, inline }),
        content: bounded(whole, node.ref, from, LABEL_BOUND, inline),
        textOffset: from,
        reconstructedTotal: whole.length,
      },
      // The envelope's own accounting agrees with the inline marker, so a caller
      // that reads `withheld` and a caller that reads the text see one truth.
      withheld:
        rest > 0
          ? {
              count: rest,
              unit: 'characters',
              estimated: false,
              continuation: `{"verb":"read","target":"${node.ref}","cursor":"t_${from + LABEL_BOUND}"}`,
            }
          : null,
      inline,
    };
  }
  // Children page by the same identity resume rankAndPage performs: the page
  // is the first CHILD_PAGE children the chain has not delivered, so a
  // same-epoch recompile between pages cannot silently skip one.
  const children = node.childRefs.map((r) => g.nodes.get(r)!);
  const resumes = cursor !== null && /^c_\d+$/.test(cursor);
  let page: WirNode[];
  let remaining: number;
  let served: number;
  let reset = false;
  if (resumes && prior !== null) {
    const undelivered = children.filter((c) => !prior.has(c.ref));
    page = undelivered.slice(0, CHILD_PAGE);
    remaining = undelivered.length - page.length;
    served = prior.size + page.length;
  } else {
    reset = resumes;
    page = children.slice(0, CHILD_PAGE);
    remaining = Math.max(0, children.length - CHILD_PAGE);
    served = page.length;
  }
  const withSubtree = page.filter((c) => c.childRefs.length > 0).length;
  // At least ONE per child, always. The even-share rule alone hits zero at 25
  // children-with-subtrees (floor(24/25)), and CHILD_PAGE is 40 — so an ordinary
  // nav strip or comment list silently turned the census OFF, emitting the words
  // for every child and the handle for none. That is verbatim the ladder this
  // census exists to kill, reappearing on exactly the crowded pages that need it
  // most, with no signal: `reachable` is simply absent while `moreReachable`
  // promises everything. A floor of 1 costs ~40 short entries on the widest page
  // and saves the 40 model calls the ladder charges.
  const perChild = Math.max(
    1,
    Math.min(REACHABLE_PER_CHILD, Math.floor(REACHABLE_PER_READ / Math.max(1, withSubtree))),
  );
  return {
    payload: {
      node: nodeDetail(node, { g, inline }),
      children: page.map((c) => {
        // Children carry their own bounded subtree content, exactly as collection
        // items do. Without it a container of N items costs N reads: proven on
        // This behavior was verified during testing.
        // time, surfaced 2 of 4 required reviewers, and the episode gave up.
        const content = subtreeText(c, g);
        const detail = nodeDetail(c);
        return {
          ...detail,
          ...(content && content !== detail['name'] && content !== detail['text']
            ? { content: bounded(content, c.ref, 0, LABEL_BOUND, inline) }
            : {}),
          ...(c.childRefs.length > 0 ? { descendants: descendantsOf(c, g, perChild) } : {}),
        };
      }),
      childrenTotal: children.length,
      ...(reset
        ? {
            cursorReset: {
              received: cursor,
              note:
                'no delivery record for this continuation against the current document ' +
                '(it was minted against a replaced document, or never minted) — ' +
                'serving the list from the start so nothing is skipped',
            },
          }
        : {}),
    },
    withheld:
      remaining > 0
        ? {
            count: remaining,
            unit: 'children',
            estimated: false,
            continuation: JSON.stringify({ verb: 'read', target, cursor: `c_${served}` }),
          }
        : null,
    inline,
    ...(remaining > 0
      ? {
          chains: [
            {
              continuation: JSON.stringify({ verb: 'read', target, cursor: `c_${served}` }),
              served: [...(resumes && prior !== null ? prior : []), ...page.map((c) => c.ref)],
            },
          ],
        }
      : {}),
  };
}

const PAGE_PARAMS = new Set([
  'p',
  'page',
  'pg',
  'paged',
  'page_number',
  'pagenum',
  'offset',
  'start',
]);
/** The site's own next-page control for the current document, by structure alone:
 *  `rel="next"` on a compiled link, else a link whose href is this address with
 *  one page-like query parameter advanced by exactly one (or `offset`/`start`
 *  advanced by any positive step). Returns the control to click, or null. */
export function nextPageControl(
  g: WirGraph,
): { ref: string; name: string; href: string; by: 'rel' | 'param' } | null {
  let byParam: { ref: string; name: string; href: string; by: 'param' } | null = null;
  let here: URL | null = null;
  try {
    here = new URL(g.url);
  } catch {
    here = null;
  }
  for (const n of g.nodes.values()) {
    if (n.role !== 'link' || !n.href) continue;
    if (n.rel && n.rel.split(/\s+/).includes('next'))
      return { ref: n.ref, name: n.name, href: n.href, by: 'rel' };
    if (byParam || !here) continue;
    let u: URL;
    try {
      u = new URL(n.href);
    } catch {
      continue;
    }
    if (u.origin !== here.origin || u.pathname !== here.pathname) continue;
    const a = new Map(here.searchParams),
      b = new Map(u.searchParams);
    let advanced = 0,
      other = 0;
    for (const [k, v] of b) {
      const w = a.get(k);
      if (w === v) continue;
      if (PAGE_PARAMS.has(k) && /^\d+$/.test(v)) {
        const from =
          w !== undefined && /^\d+$/.test(w) ? Number(w) : k === 'offset' || k === 'start' ? 0 : 1;
        const step = Number(v) - from;
        if (k === 'offset' || k === 'start' ? step > 0 : step === 1) {
          advanced++;
          continue;
        }
      }
      other++;
    }
    for (const k of a.keys()) if (!b.has(k)) other++;
    if (advanced === 1 && other === 0)
      byParam = { ref: n.ref, name: n.name, href: n.href, by: 'param' };
  }
  return byParam;
}

// A read that EXHAUSTS a collection: every item the compiler attributed to the
// container, as one typed table, in document order — one row per item carrying
// the item's ref, label and owned text exactly as `itemSummary` projects it in
// the overview. Deterministic, no semantics, no summary: the arithmetic stays
// with the model, but the population it computes over is now stated once,
// exactly, rather than assembled by hand across `read {target}` pages of
// CHILDREN (which are not items — a 25-post forum listing has 28 children) with
// each child's `descendants` census riding along.
//
// It walks the continuation the runtime itself mints for a collection — the
// items behind the overview's `moreItems` — and nothing else. A list the site
// splits across server pages is several documents, and each is its own
// collection; the page's next-page control is a control like any other, and
// this verb never presses it. The table says so (`scope: 'this document'`)
// rather than letting "every item" read as "every item the site has".
//
// Bounded by BYTES, never by loss: the population (`itemCount`) is exact and
// first; when the rows exceed TABLE_BYTES the cut falls at a row boundary,
// `rowsAfter` is exact, the continuation reaches them, and `complete` is true
// only when this response holds every row. Resume is by identity through the
// session's delivery record, like every other chain here — a same-document
// recompile between pages can neither re-serve nor skip a row.
function readCollectionAll(
  g: WirGraph,
  node: WirNode,
  cursor: string | null,
  prior: ReadonlySet<string> | null,
  fields: boolean,
): ReadResult | ReadRejection {
  // A container can head more than one collection — the repeats-with rule
  // groups by tag, so a parent with three <li> and two <tr> children heads
  // two. The table is the union, in the container's own child order.
  const heads = g.collections.filter((c) => c.ref === node.ref);
  if (heads.length === 0) {
    // Not a container: steer to the collection this node belongs to, or the
    // largest one beneath it, before falling back to the plain read.
    const owner = g.collections.find((c) => c.itemRefs.includes(node.ref));
    const under = new Set(collectSubtree(node, g).map((n) => n.ref));
    const beneath = g.collections
      .filter((c) => c.ref !== node.ref && under.has(c.ref))
      .sort((a, b) => b.itemRefs.length - a.itemRefs.length)[0];
    const to = owner ?? beneath;
    return {
      rejected: {
        reason:
          `read all: ${node.ref} heads no collection on this page` +
          (owner
            ? ` — it is an item of ${owner.ref}`
            : beneath
              ? ` — the largest collection beneath it is ${beneath.ref} (${beneath.itemRefs.length} items)`
              : '') +
          '; the overview lists every collection with its ref and itemCount',
        repair: to
          ? `{"verb":"read","target":"${to.ref}","all":true${fields ? ',"fields":true' : ''}}`
          : `{"verb":"read","target":"${node.ref}"}`,
      },
    };
  }
  const itemSet = new Set(heads.flatMap((c) => c.itemRefs));
  const items = node.childRefs.filter((r) => itemSet.has(r)).map((r) => g.nodes.get(r)!);
  const label = heads.find((c) => c.label)?.label ?? '';
  const provenance = heads.every((c) => c.provenance === 'extracted') ? 'extracted' : 'inferred';

  const resumes = cursor !== null && /^i_\d+$/.test(cursor);
  const reset = resumes && prior === null;
  const before = resumes && prior !== null ? prior : new Set<string>();
  const undelivered = items.filter((it) => !before.has(it.ref));
  // Pack rows until the next one would cross the budget — but never zero rows:
  // a page that delivers nothing and offers itself again is a loop, not a
  // bound. Each row's inline offers are minted into a private sink and merged
  // only when the row is admitted; an offer for a row this page withholds
  // would claim content rode a payload it never rode (defect D1's shape).
  const inline: InlineOffer[] = [];
  const rows: Record<string, unknown>[] = [];
  let used = 0;
  for (const it of undelivered) {
    const sink: InlineOffer[] = [];
    const row = recordOf(it, g, sink, fields);
    const cost = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (rows.length > 0 && used + cost > TABLE_BYTES) break;
    rows.push(row);
    inline.push(...sink);
    used += cost;
  }
  const rowsAfter = undelivered.length - rows.length;
  const served = before.size + rows.length;
  // The continuation restates `fields`, so the next page is the same table and
  // the chain key (the call, verbatim) resumes the delivery record.
  const continuation = JSON.stringify({
    verb: 'read',
    target: node.ref,
    all: true,
    ...(fields ? { fields: true } : {}),
    cursor: `i_${served}`,
  });
  const more =
    rowsAfter > 0 ? { count: rowsAfter, unit: 'rows', estimated: false, continuation } : null;
  // THE SITE'S OWN NEXT PAGE, NAMED, NEVER PRESSED. A collection the site
  // splits across pages is this page's collection plus that page's; the table
  // This behavior was verified during testing.

  // page that held the maximum, because nothing told it the population
  // continued. Two structural signals, no words matched: a link whose own
  // `rel` declares next, or a link whose href is this address with a page-like
  // parameter advanced by one. Disclosed as a control to click; the verb never
  // follows it (a document load is the model's decision, and its consequences
  // for a NAVIGATE request are the model's to weigh).
  const nextPage = nextPageControl(g);
  return {
    payload: {
      node: nodeDetail(node, { g, inline }),
      table: {
        collection: { ref: node.ref, ...(label ? { label } : {}), provenance },
        ...(nextPage ? { nextPage } : {}),
        // The population, first and exact: every item the compiler attributed
        // to this container in THIS document.
        itemCount: items.length,
        scope:
          "this document — a list the site continues on another page is that page's own collection",
        rows,
        rowsBefore: before.size,
        rowsAfter,
        // What the rows carry beyond their text, and the call that widens
        // them — so a row without `links` is never read as a row without links.
        record: fields
          ? { fields: ['links', 'values', 'numbers'] }
          : {
              fields: ['values', 'numbers'],
              moreFields: {
                fields: ['links'],
                continuation: `{"verb":"read","target":"${node.ref}","all":true,"fields":true}`,
              },
            },
        // Literally true only when this one response is the whole table.
        complete: before.size === 0 && rowsAfter === 0,
        // The chain — this page plus the pages it resumed — has now delivered
        // every row. Stated separately so neither word is ever stretched.
        ...(rowsAfter === 0 && before.size > 0 ? { chainComplete: true } : {}),
        ...(more ? { moreRows: more, pagedBy: { bytes: TABLE_BYTES, used } } : {}),
        // Children of the container that are not items (a header row, a
        // "load more" affordance) stay one plain read away, and are counted so
        // the table's silence about them is never mistaken for their absence.
        ...(node.childRefs.length > items.length
          ? {
              otherChildren: {
                count: node.childRefs.length - items.length,
                continuation: `{"verb":"read","target":"${node.ref}"}`,
              },
            }
          : {}),
      },
      ...(reset
        ? {
            cursorReset: {
              received: cursor,
              note:
                'no delivery record for this continuation against the current document ' +
                '(it was minted against a replaced document, or never minted) — ' +
                'serving the table from the start so nothing is skipped',
            },
          }
        : {}),
    },
    withheld: more,
    inline,
    ...(more
      ? { chains: [{ continuation, served: [...before, ...rows.map((r) => String(r['ref']))] }] }
      : {}),
  };
}

// What is UNDER a child, not merely how many. `read {target}` is depth-1: it maps
// the target's children and says of everything below each one only
// `descendants: {count: N}`. A caller holding `count:1` on an anonymous `generic`
// cannot tell a textbox from a spacer, so it reads that child, and the child
// below it, one rung of wrappers per model call — while the WORDS it is hunting
// were already printed in the parent's `content`. Only the handle was missing.
// This behavior was verified during testing.
// adjacent read→read pairs in the failed-10 arm, 20 are this ladder; the
// This behavior was verified during testing.
// 164,180 input tokens to turn the string "Username or email address", printed at
// call 30, into a ref.
//
// The filter is name-OR-affordance, and the OR is load-bearing: a
// "controls under here" census would filter `read` through `act`'s vocabulary and
// break `the graph is strictly upstream of action affordances` (docs/vision.md).
// A named read-only node must appear. No new vocabulary — the roles and accnames
// are the compiler's, and the population is the one a scoped `find` already walks.
//
// Bounded, never lossy: the residual is exact and carries the call that reaches
// it. That continuation is a `read` of the child, NOT the `find {within}` the
// research note proposed — bare `find {within}` is rejected by find's own guard
// (core/find.ts:27, needs one of role/name/state), and a continuation that
// answers with a rejection is not a continuation. Descending one rung is
// terminating and complete: every node under the child sits in exactly one
// grandchild's subtree, and that read censuses each of them in turn.
function descendantsOf(c: WirNode, g: WirGraph, bound: number): Record<string, unknown> {
  const continuation = `{"verb":"read","target":"${c.ref}"}`;
  // The child itself is already projected in full beside this block; re-listing
  // it here would be duplication, so the census is its strict descendants.
  const all = collectSubtree(c, g).filter(
    (n) => n.ref !== c.ref && (n.name !== '' || n.affordances.length > 0),
  );
  const shown = all.slice(0, bound);
  const left = all.length - shown.length;
  return {
    // `children`, not `count`. This is how many children the node has — it
    // describes the node and withholds nothing — and sitting next to a bare
    // `continuation` under the name `count` is what made the ledger read it as
    // withheld content.
    children: c.childRefs.length,
    ...(shown.length > 0
      ? {
          reachable: shown.map((n) => ({
            ref: n.ref,
            role: n.role,
            ...(n.name ? { name: n.name } : {}),
            ...(n.description && n.description !== n.name ? { description: n.description } : {}),
          })),
        }
      : {}),
    ...(left > 0
      ? { moreReachable: { count: left, unit: 'nodes', estimated: false, continuation } }
      : {}),
    continuation,
  };
}

// A collection item must carry enough of its own content that the model does not
// This behavior was verified during testing.
// reads — one per post — because items showed only a label. The bound is per item
// and always carries its continuation, so this is denser, never lossier.
function itemSummary(item: WirNode, g: WirGraph, inline: InlineOffer[]): Record<string, unknown> {
  const label = item.name || firstNamedDescendant(item, g) || '';
  const content = subtreeText(item, g);
  const out: Record<string, unknown> = {
    ref: item.ref,
    label: label || bounded(content, item.ref, 0, LABEL_BOUND, inline),
  };
  // Only when it differs from the label actually CHOSEN. An unnamed item's
  // label already IS bounded(content), so the old guard — `content !== label`,
  // against the pre-fallback variable, empty in exactly that case — shipped the
  // same string twice byte-for-byte and pushed its inline offer twice (probe:
  // getbootstrap.com footer li, label and content both "Currently v5.3.8.").
  if (label && content && content !== label)
    out['content'] = bounded(content, item.ref, 0, LABEL_BOUND, inline);
  return out;
}

// A ROW IS A RECORD, not a sentence. `itemSummary` folds a storefront item into
// one prose string — "SONY WH1000XM3 … · 87% · 12 · Reviews · $244.97 · Add to
// Cart" — and the model re-parses it to aggregate: which token is the price,
// This behavior was verified during testing.

// three `read {all:true}` episodes that read exact tables and then aggregated
// wrongly — a non-Sony item counted into a Sony price range, a category-wide
// maximum reported for one product, a wrong food total. The rows were right;
// the parse was the model's, and it lost.
//
// So beside the text, the same row carries what the GRAPH already holds about
// it, mechanically: its link descendants (ref, name, href — the handle to open
// the item and the address to cite), its form-control descendants that hold a
// value (a quantity box, a per-row select), and every numeric token in its own
// text runs with the page's own characters around it. Derived, never inferred —
// no field is called "price" or "title", because that would be the runtime
// deciding meaning; the model reads `numbers[].unit === "$"` and decides.
// Empty arrays are omitted so a row with no links costs nothing extra.
//
// `links` is OPT-IN (`fields: true`), and that is a measurement, not a taste:
// This behavior was verified during testing.
// This behavior was verified during testing.
// 3.2-3.9x their previous bytes — three links a row, two with the same
// 110-byte address — while `numbers` and `values` together came to 1.09x,
// 1.43x and 1.97x, under the doubling bound the change was allowed. So the
// fields the aggregation failures needed ride by default, and the table says
// what it withheld and the call that adds it (`record.moreFields`). Nothing
// is removed: the item link's REF is one `read {target: row}` away as it
// always was, and one `fields:true` away as a column.
function recordOf(
  item: WirNode,
  g: WirGraph,
  inline: InlineOffer[],
  fields = false,
): Record<string, unknown> {
  const out = itemSummary(item, g, inline);
  const under = collectSubtree(item, g).filter((n) => n.ref !== item.ref);
  const links = !fields
    ? []
    : under
        .filter((n) => n.role === 'link')
        .map((n) => ({
          ref: n.ref,
          name: n.name,
          ...(n.href !== null ? { href: n.href } : {}),
        }));
  const values = under
    .filter((n) => n.value !== null && n.value !== '')
    .map((n) => ({
      ref: n.ref,
      role: n.role,
      ...(n.name ? { name: n.name } : {}),
      value: n.value,
    }));
  const numbers: NumberToken[] = [];
  for (const n of collectSubtree(item, g))
    for (const run of n.textRuns) numbers.push(...scanNumbers(run.text));
  if (links.length > 0) out['links'] = links;
  if (values.length > 0) out['values'] = values;
  if (numbers.length > 0) out['numbers'] = numbers;
  return out;
}

export interface NumberToken {
  raw: string;
  number: number;
  unit?: string;
}

// A LEXICAL scan over the page's own characters — never a locale guess, never
// a conversion. The grammar, stated so the reader knows exactly what a token
// is and is not:
//   - not preceded by a letter or digit (so "WH1000XM3" and "CH710N" yield
//     nothing: a model number is not a number);
//   - an optional leading currency symbol, adjacent ($ € £ ¥ ₹);
//   - digits with optional comma thousands-groups and an optional `.` fraction
//     ("1,299.00" → 1299; "0.01" → 0.01; a leading-zero id "000000189" → 189
//     with its raw form beside it);
//   - an optional trailing `%` or a run of at most three letters, adjacent
//     ("87%", "18W", "8.3km");
//   - not followed by a letter or digit.
// `raw` is the matched characters verbatim; `unit` is the leading symbol when
// there is one, else the trailing token; omitted when neither. A comma-decimal
// locale ("1.299,00") is not guessed at: it scans as two tokens under this
// grammar, and the raw strings say so.
const NUMBER_TOKEN =
  /(?<![\p{L}\p{N}])([$€£¥₹])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(%|\p{L}{1,3})?(?![\p{L}\p{N}])/gu;
export function scanNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    const [raw, lead, digits, trail] = m;
    const number = Number(digits!.replace(/,/g, ''));
    if (!Number.isFinite(number)) continue;
    const unit = lead ?? trail;
    out.push({ raw, number, ...(unit ? { unit } : {}) });
  }
  return out;
}

function controlSummary(n: WirNode): Record<string, unknown> {
  const out: Record<string, unknown> = { ref: n.ref, role: n.role, name: n.name };
  // The browser's description beside the name, wherever the page gave one. For
  // a control whose accname is empty it is the only word that identifies it —
  // the icon `<i title="Close Full Screen">` printed as `generic ""` and the
  // This behavior was verified during testing.
  // This behavior was verified during testing.
  // nav link with its own text, and the same word twice is a redump.
  if (n.description && n.description !== n.name) out['description'] = n.description;
  if (Object.keys(n.state).length > 0) out['state'] = n.state;
  if (n.value !== null && n.value !== '') out['value'] = n.value;
  if (n.controlId !== null) out['controlId'] = n.controlId;
  // Which combobox is the REAL one. Three can compile with the same role and
  // only one owns <option> elements; `select` refuses the others. Without this
  // This behavior was verified during testing.
  // every run. One integer, only where it is non-null.
  // Only where the accname is empty. A control that already has a name does not
  // need a second handle, and printing both on every field would be noise on
  // every form in the corpus.
  if (n.fieldName !== null && n.name === '') out['fieldName'] = n.fieldName;
  if (n.optionCount !== null) out['optionCount'] = n.optionCount;
  if (n.optionLabels !== null && n.optionLabels.length > 0) {
    out['optionLabels'] = n.optionLabels;
  }
  // AFFORDANCES TRAVEL WITH THE CONTROL. `scrollable` in particular is
  // unguessable from role or name — a scroll container is a bare div — and
  // putting it only in `find` means the caller must already suspect it exists to
  // ask. Measured: with the affordance in find alone, an agent given the whole
  // page in one read still scrolled the wrong box and the button it gates stayed
  // disabled. The overview is where the caller decides what to act on.
  if (n.affordances.length > 0) out['affordances'] = n.affordances;
  return out;
}

// WHERE A NODE SITS. Two matches can print byte-identical apart from the ref
// This behavior was verified during testing.
// rows 76-82) returned two `generic "" text:"Content"` for `find
// {name:"Content"}` — the admin nav flyout's label, under the `navigation`
// landmark, and the product form's collapsible section header, under `main`.
// The model clicked the first, the flyout opened, and the description field
// the request needed was never found. The parent chain was in the graph the whole
// time; the projection did not say.
//
// A container is the nearest ancestor that is a landmark role, or that has a
// name — its accname, or the label the compiler gave the collection it anchors
// (a heading-labelled section). Mechanical: the parent chain, no inference,
// nothing renamed. The document root is never one. Every container up the
// chain is returned, nearest first, so a caller that finds two nodes still
// colliding at the nearest one can print the next.
const CONTAINER_ROLES = new Set([
  'navigation',
  'main',
  'form',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'search',
  'dialog',
]);
const CONTAINER_NAME_BOUND = 80;

export interface Container {
  ref: string;
  role: string;
  name?: string;
}

/** The compiler's own labels for collection containers, once per call. */
export function collectionLabels(g: WirGraph): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of g.collections) if (c.label && !out.has(c.ref)) out.set(c.ref, c.label);
  return out;
}

/** Every enclosing container of `n`, nearest first; empty when none but the
 *  document root encloses it. A container's name is a pointer, not a delivery,
 *  so it is cut with `boundedLabel` at the same width an item label is — a
 *  `row` named by its whole content would otherwise redump the row on every
 *  match inside it — and the offer rides `sink` once per container. */
export function containersOf(
  n: WirNode,
  g: WirGraph,
  labels: Map<string, string>,
  sink?: InlineOffer[],
  offered?: Set<string>,
): Container[] {
  const out: Container[] = [];
  let cur = n.parentRef ? g.nodes.get(n.parentRef) : undefined;
  let hops = 0;
  while (cur && cur.ref !== g.rootRef && hops < 64) {
    const name = cur.name || labels.get(cur.ref) || '';
    if (CONTAINER_ROLES.has(cur.role) || name !== '') {
      if (name === '') out.push({ ref: cur.ref, role: cur.role });
      else {
        const pending: InlineOffer[] = [];
        const label = boundedLabel(name, cur.ref, CONTAINER_NAME_BOUND, pending);
        if (pending[0] && sink && !offered?.has(cur.ref)) {
          sink.push(pending[0]);
          offered?.add(cur.ref);
        }
        out.push({ ref: cur.ref, role: cur.role, name: label });
      }
    }
    cur = cur.parentRef ? g.nodes.get(cur.parentRef) : undefined;
    hops += 1;
  }
  return out;
}

function nodeDetail(
  n: WirNode,
  ctx?: { g: WirGraph; inline: InlineOffer[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ref: n.ref, role: n.role };
  if (n.name) out['name'] = n.name;
  if (n.description && n.description !== n.name) out['description'] = n.description;
  // `text` is the element's own runs CONCATENATED, which is required for the
  // accname and misleading as a reading whenever a child sat between them:
  // "<p>invite a member to <strong>X</strong> or invite a group.</p>" has own
  // text "invite a member to or invite a group." — fluent, grammatical, and
  // missing a word. A garbled string gets caught; a plausible one gets quoted.
  //
  // When the runs are spliced, the honest reading is `content` (subtreeText),
  // which is emitted alongside this and now walks document order. So say nothing
  // here rather than say it wrongly.
  const spliced = n.textRuns.filter((t) => t.text !== '').length > 1 && n.childRefs.length > 0;
  if (n.text && n.text !== n.name && !spliced) out['text'] = n.text;
  if (n.affordances.length > 0) out['affordances'] = n.affordances;
  if (Object.keys(n.state).length > 0) out['state'] = n.state;
  if (n.value !== null && n.value !== '') out['value'] = n.value;
  if (n.controlId !== null) out['controlId'] = n.controlId;
  // The target's own place, the same field a find match carries (one place
  // computes it: containersOf). Children do not repeat it — they sit where the
  // target sits, or under it.
  if (ctx) {
    const nearest = containersOf(n, ctx.g, collectionLabels(ctx.g), ctx.inline)[0];
    if (nearest) out['in'] = nearest;
  }
  return out;
}

// first named descendant, headings preferred, then any named node, then owned text
function firstNamedDescendant(n: WirNode, g: WirGraph): string {
  let fallback = '';
  const walk = (x: WirNode): string => {
    for (const r of x.childRefs) {
      const c = g.nodes.get(r)!;
      if (c.role === 'heading' && (c.name || c.text)) return c.name || c.text;
      if (!fallback && (c.name || c.text)) fallback = c.name || c.text;
      const deeper = walk(c);
      if (deeper) return deeper;
    }
    return '';
  };
  return walk(n) || fallback;
}

// paging one never silently truncates the other.
function parseCursor(cursor: string | null, prefix = 'c'): number {
  if (!cursor) return 0;
  const m = new RegExp(`^${prefix}_(\\d+)$`).exec(cursor);
  return m ? Number(m[1]) : 0;
}
