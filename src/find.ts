// find — deterministic, generous resolution (docs/adr/001-structure-over-search.md).
// Normalized substring over the node's browser-computed name, its owned text
// AND its browser-computed description, filtered by role/state/scope. The

// control is a nameless generic whose only word — "Close Full Screen" — is its
// description, and `find {name:"close"}` answered 0 while the model spent 15
// clicks refused as blocked_by_overlay. Never fuzzy, never learned, never exact-AND.
// Population accounting is unconditional; empties are typed and carry the fallback.

import { boundedLabel, collectSubtree, subtreeText, type InlineOffer } from './text.js';
import { collectionLabels, containersOf, readTarget, type Container } from './read.js';
export { collectSubtree };

// The width a match's own text is cut at. Identical to buildItemIndex's below, on
// purpose: one node must never mint two continuation chains at two widths.
const MATCH_TEXT_BOUND = 80;
import type { Rejection, WirGraph, WirNode } from './types.js';

const FIND_PAGE = 20;

export interface FindOk {
  payload: Record<string, unknown>;
  withheld: { count: number; unit: string; estimated: boolean; continuation: string } | null;
  /** Bounds minted INSIDE the payload's strings. Reported, never re-parsed. */
  inline?: InlineOffer[];
  /** The refs delivered so far through the continuation this result minted —
   *  the session's delivery record for identity resume (see core/read.ts,
   *  rankAndPage: offsets skip re-ranked survivors, identity cannot). */
  chains?: { continuation: string; served: string[] }[];
}
export type FindRejected = Rejection;

export function normalize(sv: string): string {
  return sv.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function find(
  g: WirGraph,
  req: {
    role?: string | null;
    name?: string | null;
    within?: string | null;
    state?: string | null;
    limit?: number | null;
    cursor?: string | null;
  },
  prior: ReadonlySet<string> | null = null,
): FindOk | FindRejected {
  // Guard on the public surface too, not just in session: an embedder calling
  // find({}) directly would otherwise match every node on the page.
  if (!req.role && !req.name && !req.state) {
    return {
      rejected: {
        kind: 'invalid_args',
        reason: 'find needs at least one of role/name/state',
        repair: '{"verb":"find","name":"<substring of the page\'s own words>"}',
      },
    };
  }
  // A cursor that is not one this list mints is a steering rejection, never a
  // silent page 1: parseCursor answered `c_2O` (a typo) and `k_25` (another
  // list's cursor) with offset 0, so the caller got page 1 byte-identical to
  // the un-cursored call — apparent non-progress it could not tell from a

  // repair is the literal valid continuation for THIS query, computed by
  // running it un-cursored; an absent cursor still means page 1.
  if (req.cursor != null && !/^c_\d+$/.test(req.cursor)) {
    const fresh = find(g, { ...req, cursor: null });
    if ('rejected' in fresh) return fresh;
    const bare: Record<string, unknown> = { verb: 'find' };
    for (const k of ['role', 'name', 'within', 'state', 'limit'] as const) {
      if (req[k] != null) bare[k] = req[k];
    }
    return {
      rejected: {
        kind: 'invalid_args',
        reason: `cursor ${JSON.stringify(req.cursor)} is not one this find minted — its cursors look like c_<n>`,
        repair: fresh.withheld?.continuation ?? JSON.stringify(bare),
      },
    };
  }
  let scope: WirNode[] = [...g.nodes.values()];
  if (req.within) {
    const root = g.nodes.get(req.within);
    if (!root) {
      return {
        rejected: {
          kind: 'unknown_ref',
          reason: `within: no node ${req.within} in this document version`,
          repair: '{"verb":"read"} to re-resolve refs',
        },
      };
    }
    scope = collectSubtree(root, g);
  }
  const searched = scope.length;
  const scopeRefs = new Set(scope.map((n) => n.ref));

  const needle = req.name ? normalize(req.name) : null;
  const matches = scope.filter((n) => {
    if (req.role && n.role !== req.role) return false;
    // The state filter matches the state being TRUE, not merely present:
    // state:"expanded" must not return collapsed elements (expanded:false).
    if (req.state) {
      const value = n.state[req.state];
      if (value !== true && value !== 'true') return false;
    }
    if (needle !== null) {
      const hay = `${normalize(n.name)} ${normalize(n.text)} ${normalize(n.description ?? '')}`;
      if (!hay.includes(needle)) return false;
    }
    // a pure role/state query without a name matches everything with that role/state
    return req.role !== null || req.state !== null || needle !== null;
  });

  // RANK, NEVER REMOVE (docs/vision.md). A node whose OWN name carries the needle
  // is a better answer than one that merely contains it in descendant text, and
  // serving the latter first sends `act` at the wrong node.
  //
  // This behavior was verified during testing.
  // the date field's Arabic label returned TWO matches — an inert `LabelText` with
  // `name: ""` that matched through its text, and the `Date` input itself, whose
  // own name is that label. The label came first, the agent filled it, and the act
  // rejected with "Element is not focusable". The field was fillable the whole
  // time; `page.fill` on it works.
  //
  // Stable sort, so document order still decides within each group. Nothing is
  // dropped: the text-matched nodes follow, they do not disappear.
  const ranked =
    needle === null
      ? matches
      : [...matches].sort(
          (a, b) =>
            Number(normalize(b.name).includes(needle)) - Number(normalize(a.name).includes(needle)),
        );

  // Identity resume, never offset (the rankAndPage rule, core/read.ts): a
  // recompile between mint and consume re-ranks the matches, and an offset
  // into the new ranking skips whatever moved up below it. The page is the
  // first `limit` matches the chain has not delivered; a well-formed cursor
  // with no delivery record serves from the start and DISCLOSES.
  const limit = Math.min(Math.max(req.limit ?? FIND_PAGE, 1), 100);
  const resumes = req.cursor != null; // shape validated above
  let page: WirNode[];
  let remaining: number;
  let served: number;
  let reset = false;
  if (resumes && prior !== null) {
    const undelivered = ranked.filter((n) => !prior.has(n.ref));
    page = undelivered.slice(0, limit);
    remaining = undelivered.length - page.length;
    served = prior.size + page.length;
  } else {
    reset = resumes;
    page = ranked.slice(0, limit);
    remaining = Math.max(0, ranked.length - limit);
    served = page.length;
  }

  const inline: InlineOffer[] = [];
  const chains: { continuation: string; served: string[] }[] = [];
  const itemOf = buildItemIndex(g);
  // An item's bound-label offer is reported only when the item actually rides
  // this payload, once per item. buildItemIndex used to push every offer into
  // the shared sink while INDEXING — page-wide, delivered or not — so one
  // narrow find ledgered an offer for every unnamed over-length item on the
  // page, and the finish confrontation told the model "the runtime is holding
  // content you have not read" about things it was never shown (defect D1,
  // This behavior was verified during testing.
  // characters-offers undelivered across 51 confrontations; reproduced on
  // gnu.org — one find, 16 phantoms of 21 offers).
  const offeredItems = new Set<string>();
  // WHERE EACH MATCH SITS (containersOf, core/read.ts — the one place that
  // computes it). Printed on AMBIGUOUS matches only: two or more that would
  // print with the same role, name, text, description, affordances and state.
  // This behavior was verified during testing.
  // 20-link find +35.5% (7,887 → 10,689 bytes), so a unique match does not
  // carry it (read {target} always does). Within an ambiguous group whose
  // nearest containers read the same — same role and name; refs are opaque to
  // the reader — the chain is extended one ancestor at a time until they
  // differ or no deeper ancestor can differ. Never dropped, never reordered:
  // ranking stays exactly as above.
  const labels = collectionLabels(g);
  const offeredContainers = new Set<string>();
  const chainOf = new Map<string, Container[]>();
  const rows: Record<string, unknown>[] = page.map((n) => {
    const out: Record<string, unknown> = { ref: n.ref, role: n.role, name: n.name };
    // The description is part of the haystack, so it is shown for the same
    // reason `text` is below — and for a nameless control it is the only
    // word the caller gets (Page Builder's exit icon: name "", description
    // "Close Full Screen"). Omitted when it is byte-identical to the name —
    // This behavior was verified during testing.
    // the same word twice is a redump, not a disclosure.
    if (n.description && n.description !== n.name) out['description'] = n.description;
    // SHOW WHAT THE MATCH WAS MADE ON. The haystack above is name + own text, so
    // a match can be decided entirely by text this projection then discarded —
    // and 1,247 of 4,666 recorded matches (26.7%) came back with `name: ""`,
    // of which 522 carried neither a name nor an item label: a ref, a role, and
    // nothing readable. 196 of 1,481 productive finds returned matches that were
    // ALL nameless. That is the recall class stated plainly: the runtime saw it,
    // used it, and did not show you.
    //
    // Not a matcher — the opposite. It shows the caller the string the
    // deterministic substring rule already used to decide.
    //
    // The spliced rule is nodeDetail's, verbatim (core/read.ts): own text is runs
    // CONCATENATED, so with a child between them "invite a member to X or invite
    // a group" reads back as "invite a member to or invite a group" — fluent,
    // grammatical, missing a word. A garbled string gets caught; a plausible one
    // gets quoted, and find results are what `finish` cites as evidence.
    const spliced = n.textRuns.filter((t) => t.text !== '').length > 1 && n.childRefs.length > 0;
    if (n.text && n.text !== n.name && !spliced) {
      // boundedLabel, the same call and the same width buildItemIndex uses below.
      // Two widths over one node mint two independent continuation chains: six
      // ledger entries for three nodes, and a confrontation still claiming 1,139
      // withheld per item after every character had been read (core/text.ts).
      out['text'] = boundedLabel(n.text, n.ref, MATCH_TEXT_BOUND, inline);
    }
    // href WHOLE OR NOT AT ALL. A truncated URL is byte-prefix truncation
    // presented as complete, and worse than omission: the model will navigate it
    // and get invalid_args. Nothing in the runtime projects href today — six
    // random real sites returned zero reachable hrefs to a caller trying to tell
    // an internal link from an off-site one, and one recorded request was won only
    // by GUESSING a URL no verb had ever displayed. This does not widen
    // `navigate`'s closure: seenUrls is already seeded from every compiled href.
    if (n.href !== null) out['href'] = n.href;
    if (n.value !== null && n.value !== '') out['value'] = n.value;
    if (n.controlId !== null) out['controlId'] = n.controlId;
    // The chooser's own options, where they exist. `find` is where a caller
    // goes looking for a control, and the system prompt sends it here to pick
    // a destination — so a select whose options are invisible in a find result
    // is a select the caller cannot choose from. read carries these too; both
    // projections need them or the caller must already know which verb to ask.
    if (n.fieldName !== null && n.name === '') out['fieldName'] = n.fieldName;
    if (n.optionCount !== null) out['optionCount'] = n.optionCount;
    if (n.optionLabels !== null && n.optionLabels.length > 0) {
      out['optionLabels'] = n.optionLabels;
    }
    if (n.role === 'heading' && n.level !== null) out['level'] = n.level;
    if (n.affordances.length > 0) out['affordances'] = n.affordances;
    if (Object.keys(n.state).length > 0) out['state'] = n.state;
    const item = itemOf.get(n.ref);
    if (item && item.ref !== n.ref) {
      out['item'] = { ref: item.ref, label: item.label };
      if (item.offer && !offeredItems.has(item.ref)) {
        offeredItems.add(item.ref);
        inline.push(item.offer);
      }
    }
    return out;
  });
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = JSON.stringify(
      ['role', 'name', 'text', 'description', 'affordances', 'state'].map((k) => row[k] ?? null),
    );
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const chains = group.map((row) => {
      const n = g.nodes.get(row['ref'] as string)!;
      const c = containersOf(n, g, labels, inline, offeredContainers);
      chainOf.set(n.ref, c);
      return c;
    });
    const read = (c: Container[], depth: number): string =>
      JSON.stringify(c.slice(0, depth).map((x) => [x.role, x.name ?? '']));
    let depth = 1;
    for (;;) {
      const keys = chains.map((c) => read(c, depth));
      const dup = new Set(keys.filter((k, i) => keys.indexOf(k) !== i));
      if (dup.size === 0) break;
      // Deeper can only separate two chains that read the same but stand on
      // DIFFERENT nodes at this depth — siblings under one container share
      // every ancestor above it, and printing that chain would say nothing.
      const worth = chains.some(
        (c, i) =>
          dup.has(keys[i]!) &&
          c.length > depth &&
          chains.some(
            (d, j) => j !== i && keys[j] === keys[i] && d[depth - 1]?.ref !== c[depth - 1]?.ref,
          ),
      );
      if (!worth) break;
      depth += 1;
    }
    group.forEach((row, i) => {
      const c = chains[i]!;
      if (c.length === 0) return;
      row['in'] = depth > 1 ? c.slice(0, depth) : c[0];
    });
  }
  const payload: Record<string, unknown> = {
    matches: rows,
    population: { searched, matched: matches.length, estimated: false },
  };
  // ONE MATCH IS AN ANSWER, SO DELIVER IT. When the whole population matched
  // exactly one node, the caller's next call is `read {target: thatRef}` — a
  // turn spent to learn what the runtime already knows. So the find carries
  // that read's result inline, verbatim (`readTarget`: the node's detail, its
  // children with content and the census beneath each, the exact count and the
  // continuation when they page), under `detail`. The match list keeps its
  // shape; with two or more matches nothing changes, because which one to open
  // is the model's decision. Its inline offers and chains ride this response's
  // so the ledger accounts for them exactly as the separate read would have.
  if (matches.length === 1 && page.length === 1) {
    const d = readTarget(g, page[0]!.ref, null, null, false);
    if (d !== null && !('rejected' in d)) {
      payload['detail'] = { ...d.payload, ...(d.withheld ? { withheld: d.withheld } : {}) };
      inline.push(...(d.inline ?? []));
      chains.push(...(d.chains ?? []));
    }
  }
  // PRESENT BUT UNREVEALED. The same substring rule, run over the compiler's
  // side-list of nodes that are in the document and not rendered (a collapsed
  // flyout, a closed <details>, a hidden tab panel), grouped by the nearest
  // rendered container. Disclosed when the rendered scope matched nothing, or
  // when more of the page's copies of this text are hidden than shown — so a
  // find that already has a good answer is not widened by hidden duplicates.
  // The repair is the literal act on the container: opening it is the model's
  // This behavior was verified during testing.
  // on `review` while "All Reviews" sat under the collapsed Marketing item.
  const unrendered = unrenderedDisclosure(g, req, needle, scopeRefs, inline);
  if (unrendered !== null && (matches.length === 0 || unrendered.count > matches.length)) {
    payload['unrendered'] = unrendered;
  }
  if (matches.length === 0) {
    // WHICH filter emptied the result? A bare `matched: 0` reads as "not present"
    // when it only ever means "no node satisfied ALL of these at once" — and the
    // two are indistinguishable to the caller. Measured on the live storefront:
    // `find {role:"textbox", name:"Search"}` returns 0 of 308 while a `combobox`
    // named " Search" sits in the same graph; the name matched, `role` did the
    // eliminating, and nothing said so.
    //
    // Re-filter the SAME scope with each filter held out in turn. No semantics, no
    // new capability — arithmetic over a pass already made, and it converts a dead
    // end into the literal next call the pagination invariant asks for.
    const holds: Record<string, (n: WirNode) => boolean> = {
      role: (n) => !req.role || n.role === req.role,
      state: (n) => {
        if (!req.state) return true;
        const value = n.state[req.state];
        return value === true || value === 'true';
      },
      name: (n) =>
        needle === null ||
        `${normalize(n.name)} ${normalize(n.text)} ${normalize(n.description ?? '')}`.includes(
          needle,
        ),
    };
    const active = (['role', 'name', 'state'] as const).filter((k) => req[k]);
    const callWithout = (drop: string): string => {
      const out: Record<string, unknown> = { verb: 'find' };
      if (req.role && drop !== 'role') out['role'] = req.role;
      if (req.name && drop !== 'name') out['name'] = req.name;
      if (req.state && drop !== 'state') out['state'] = req.state;
      if (req.within) out['within'] = req.within;
      return JSON.stringify(out);
    };
    const eliminatedBy =
      active.length > 1
        ? active
            .map((drop) => ({
              drop,
              wouldMatch: scope.filter((n) => active.every((k) => k === drop || holds[k]!(n)))
                .length,
              call: callWithout(drop),
            }))
            .filter((r) => r.wouldMatch > 0)
            .sort((a, b) => b.wouldMatch - a.wouldMatch)
        : [];
    payload['empty'] = {
      filters: {
        role: req.role ?? null,
        name: req.name ?? null,
        state: req.state ?? null,
        within: req.within ?? null,
      },
      normalization: 'NFKC, case-folded, whitespace-collapsed substring over name+text+description',
      // Say what was actually checked. This is NOT a claim that the thing is absent.
      meaning: 'no node in scope satisfied every filter at once',
      ...(eliminatedBy.length > 0 ? { eliminatedBy } : {}),
      fallback:
        eliminatedBy.length > 0
          ? eliminatedBy[0]!.call
          : unrendered !== null && unrendered.containers.length > 0
            ? unrendered.containers[0]!.open
            : req.within
              ? `{"verb":"read","target":"${req.within}"}`
              : '{"verb":"read"} — browse the structure instead',
    };
  }
  if (reset) {
    payload['cursorReset'] = {
      received: req.cursor,
      note:
        'no delivery record for this continuation against the current document ' +
        '(it was minted against a replaced document, or never minted) — ' +
        'serving the matches from the start so nothing is skipped',
    };
  }
  const continuation =
    remaining > 0 ? JSON.stringify({ ...req, verb: 'find', cursor: `c_${served}` }) : null;
  if (continuation !== null) {
    chains.push({
      continuation,
      served: [...(resumes && prior !== null ? prior : []), ...page.map((n) => n.ref)],
    });
  }
  return {
    payload,
    withheld:
      continuation !== null
        ? { count: remaining, unit: 'matches', estimated: false, continuation }
        : null,
    inline,
    ...(chains.length > 0 ? { chains } : {}),
  };
}

interface UnrenderedDisclosure {
  count: number;
  estimated: false;
  meaning: string;
  containers: {
    ref: string;
    role: string;
    name: string;
    affordances: string[];
    matches: string[];
    matchesTotal: number;
    open: string;
  }[];
  notSearched?: { count: number; unit: 'unrendered nodes'; estimated: false; note: string };
}

// How many of a container's matching texts ride the disclosure. The container
// is ONE act away from showing all of them as ordinary nodes, so the count is
// the accounting and opening it is the continuation.
const UNRENDERED_SAMPLE = 5;

function unrenderedDisclosure(
  g: WirGraph,
  req: { role?: string | null; state?: string | null; within?: string | null },
  needle: string | null,
  scopeRefs: ReadonlySet<string>,
  inline: InlineOffer[],
): UnrenderedDisclosure | null {
  // An unrendered node has no state the runtime can vouch for — a state query
  // over it would be a claim made of nothing. Say nothing rather than guess.
  if (req.state) return null;
  const { candidates, total } = g.unrendered;
  const hits = candidates.filter(
    (c) =>
      (!req.role || c.role === req.role) &&
      (needle === null || normalize(c.text).includes(needle)) &&
      scopeRefs.has(c.containerRef),
  );
  const notSearched = total - candidates.length;
  if (hits.length === 0 && notSearched <= 0) return null;
  const byContainer = new Map<string, string[]>();
  for (const h of hits)
    byContainer.set(h.containerRef, [...(byContainer.get(h.containerRef) ?? []), h.text]);
  const containers = [...byContainer].map(([ref, texts]) => {
    const node = g.nodes.get(ref)!;
    const clickable = node.affordances.includes('clickable');
    return {
      ref,
      role: node.role,
      name: node.name || boundedLabel(subtreeText(node, g), ref, 80, inline),
      affordances: node.affordances,
      matches: texts.slice(0, UNRENDERED_SAMPLE),
      matchesTotal: texts.length,
      // Clickable: the literal act. Otherwise the container's own controls are
      // one read away, and that read is the call.
      open: clickable
        ? JSON.stringify({ verb: 'act', ref, action: 'click' })
        : JSON.stringify({ verb: 'read', target: ref }),
    };
  });
  return {
    count: hits.length,
    estimated: false,
    meaning:
      hits.length > 0
        ? `${hits.length} node(s) in the document carry this text but are not rendered — ` +
          'inside a collapsed menu, a closed section, a hidden panel. Each is listed under ' +
          'its nearest rendered container; open the container, then find again'
        : 'no unrendered node searched carries this text',
    containers,
    ...(notSearched > 0
      ? {
          notSearched: {
            count: notSearched,
            unit: 'unrendered nodes' as const,
            estimated: false as const,
            note: `past the compile bound of ${candidates.length} unrendered candidates; not searched`,
          },
        }
      : {}),
  };
}

// which collection item owns each node — "ten Reply fields are distinguishable only
// by whose comment owns them" (docs/vision.md)
function buildItemIndex(
  g: WirGraph,
): Map<string, { ref: string; label: string; offer: InlineOffer | null }> {
  const out = new Map<string, { ref: string; label: string; offer: InlineOffer | null }>();
  for (const c of g.collections) {
    for (const itemRef of c.itemRefs) {
      const item = g.nodes.get(itemRef)!;
      // An unnamed item was labelled with a bare 80-character prefix — no
      // marker, no count, no continuation. Nothing distinguished a short item
      // from a cut one, which is the byte-prefix truncation the pagination
      // invariant forbids outright, sitting beside `read`'s `itemSummary` that
      // already routed the same kind of string through `bounded`.
      //
      // `boundedLabel`, not `bounded`. Both cut the same string, but `bounded`
      // mints a `t_<offset>` cursor — and cutting one node's text at 80 here
      // while `read`'s itemSummary cuts it at 320 minted two independent chains
      // for the same node, neither of which consumed the other. A label points;
      // it does not deliver. Width stays 80 because this repeats on every match
      // in a collection.
      //
      // The offer is HELD, not sunk: an offer is a claim that withheld content
      // rode a payload, so the index — which labels every item page-wide,
      // matched or not — must not report it. The caller pushes it into the
      // sink only when the item actually rides a response (defect D1: a
      // page-wide sink here put every unmatched over-length item into the
      // finish confrontation's budget).
      const pending: InlineOffer[] = [];
      const label = item.name || boundedLabel(subtreeText(item, g), itemRef, 80, pending);
      const entry = { ref: itemRef, label, offer: pending[0] ?? null };
      const stamp = (n: WirNode): void => {
        out.set(n.ref, entry);
        for (const r of n.childRefs) stamp(g.nodes.get(r)!);
      };
      stamp(item);
    }
  }
  return out;
}
