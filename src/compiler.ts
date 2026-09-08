// Facts -> graph. The browser's own computations are the source of truth:
// role/name come from the AX tree (Chromium runs the full accname algorithm,
// name-from-content included), joined to DOMSnapshot structure/state/geometry by
// backendNodeId. The same-computation rule (docs/lessons.md) is satisfied by using
// the browser's computation everywhere — compile time and act time both read AX.

import { createHash } from 'node:crypto';
import { SNAPSHOT_COMPUTED_STYLES, type RawFacts } from './host.js';
import type { UnrenderedCandidate, WirCollection, WirGraph, WirNode } from './types.js';

// The document root's ref is synthetic — it is the one ref not minted from a
// backendNodeId, so anything matching refs by SHAPE must know it by name
// (session.recordObserved silently failed to, making the root uncitable).
export const ROOT_REF = 'n_root';

const IMPLICIT_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  textarea: 'textbox',
  select: 'combobox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  form: 'form',
  article: 'article',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  img: 'img',
  input: 'textbox',
  section: 'generic',
  fieldset: 'group',
  dialog: 'dialog',
};

const NAME_FROM_CONTENT = new Set([
  'link',
  'button',
  'heading',
  'cell',
  'columnheader',
  'rowheader',
  'option',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
  'row',
]);

// Roles whose ARIA definition IS "the user activates this". Carrying one is an
// affordance on its own, independently of how the page wires its handlers.
const ACTIVATABLE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
  'combobox',
]);

const STRUCTURAL_TAGS = new Set([
  'article',
  'li',
  'tr',
  'nav',
  'main',
  'header',
  'footer',
  'form',
  'section',
  'table',
  'ul',
  'ol',
  'fieldset',
  'dialog',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'option', 'label']);
const COLLECTION_ITEM_TAGS = new Set(['article', 'li', 'tr']);

// Never content, rendered or not: nothing under these is something a page
// shows a person. `head` covers <title>, which would otherwise surface as an
// unrendered candidate on every page.
const NEVER_CONTENT_TAGS = new Set([
  'script',
  'style',
  'head',
  'meta',
  'link',
  'template',
  'noscript',
]);
// The side-list of unrendered candidates is bounded so a page hiding a 50k-row
// table cannot make every compile carry it; the exact total travels beside the
// kept slice, and find discloses the difference as not searched.
export const UNRENDERED_KEEP = 2000;
export const UNRENDERED_TEXT_BOUND = 200;

interface DomRecord {
  index: number;
  parentIndex: number;
  tag: string;
  backendNodeId: number;
  attrs: Map<string, string>;
  rendered: boolean;
  bounds: [number, number, number, number] | null;
  clickable: boolean;
  checked: boolean;
  selected: boolean;
  value: string | null;
  // Each own-text run with its DOCUMENT INDEX and its raw, un-normalised form.
  // The index is what lets a projection put the run back where it sat among the
  // element's children; the raw form is what lets source code be reconstructed.
  // Both are in scope at the push and were previously discarded.
  ownText: { index: number; text: string; raw: string }[];
}

// Fold every document in the snapshot into one index space, re-parenting each
// child document's root onto the <iframe> element that owns it.
//
// Flattening rather than compiling documents separately is what keeps the rest
// of this file untouched: one records array, one admitted map, one parent chain,
// so name-from-content, ancestor resolution and collection detection all reach
// across the frame boundary exactly as they do within a document.
//
// Coordinates: a frame's layout bounds are relative to that frame, so geometry
// for in-frame nodes is frame-local. That is projection only — `act` resolves
// its click point through DOM.getContentQuads, which is already in top-level
// viewport space for same-process frames (verified end-to-end).
function flattenDocuments(snapshot: RawFacts['snapshot']): {
  nodes: RawFacts['snapshot']['documents'][number]['nodes'];
  layout: RawFacts['snapshot']['documents'][number]['layout'];
  title: number;
  perDocument: {
    first: number;
    count: number;
    documentURL: number;
    baseURL: number;
    frameId: number;
  }[];
} {
  const docs = snapshot.documents;
  const offsets: number[] = [];
  let total = 0;
  for (const d of docs) {
    offsets.push(total);
    total += d.nodes.parentIndex.length;
  }

  const nodes = {
    parentIndex: [] as number[],
    nodeType: [] as number[],
    nodeName: [] as number[],
    nodeValue: [] as number[],
    backendNodeId: [] as number[],
    attributes: [] as number[][],
    inputValue: { index: [] as number[], value: [] as number[] },
    inputChecked: { index: [] as number[] },
    optionSelected: { index: [] as number[] },
    isClickable: { index: [] as number[] },
    shadowRootType: { index: [] as number[], value: [] as number[] },
  };
  const layout = {
    nodeIndex: [] as number[],
    bounds: [] as number[][],
    text: [] as number[],
    styles: [] as number[][],
    // Carried through the merge like every other per-layout-node array. Dropping
    // them here is silent: the scrollable computation downstream just sees
    // undefined and marks nothing, which is exactly the bug this line fixes.
    scrollRects: [] as (number[] | undefined)[],
    clientRects: [] as (number[] | undefined)[],
  };

  // Owner element (global index) for each document index, discovered from the
  // owning document's contentDocumentIndex table.
  const ownerOf = new Map<number, number>();
  for (let d = 0; d < docs.length; d++) {
    const cdi = docs[d]!.nodes.contentDocumentIndex;
    if (!cdi) continue;
    for (let k = 0; k < cdi.index.length; k++) {
      ownerOf.set(cdi.value[k]!, offsets[d]! + cdi.index[k]!);
    }
  }

  const perDocument: {
    first: number;
    count: number;
    documentURL: number;
    baseURL: number;
    frameId: number;
  }[] = [];
  for (let d = 0; d < docs.length; d++) {
    const src = docs[d]!;
    const off = offsets[d]!;
    const len = src.nodes.parentIndex.length;
    // frameId travels with the segment so the graph can say WHICH frames it
    // contains. Without that the freshness vouch cannot distinguish a frame it
    // must watch from one that contributed nothing.
    // baseURL, not documentURL. CDP defines it as "Base URL that Document or
    // FrameOwner node uses for URL completion" — it is the document's own
    // resolution base, and it is what `<base href>` changes.
    perDocument.push({
      first: off,
      count: len,
      documentURL: src.documentURL,
      baseURL: src.baseURL,
      frameId: src.frameId ?? -1,
    });
    for (let i = 0; i < len; i++) {
      const p = src.nodes.parentIndex[i]!;
      // A document's own root has no parent inside its document; hang it on the
      // element that owns the frame so the tree stays one connected structure.
      nodes.parentIndex.push(p >= 0 ? p + off : (ownerOf.get(d) ?? -1));
      nodes.nodeType.push(src.nodes.nodeType[i]!);
      nodes.nodeName.push(src.nodes.nodeName[i]!);
      nodes.nodeValue.push(src.nodes.nodeValue[i]!);
      nodes.backendNodeId.push(src.nodes.backendNodeId[i]!);
      nodes.attributes.push(src.nodes.attributes[i] ?? []);
    }
    const shift = (rare: { index: number[] } | undefined, into: { index: number[] }): void => {
      for (const i of rare?.index ?? []) into.index.push(i + off);
    };
    shift(src.nodes.inputChecked, nodes.inputChecked);
    shift(src.nodes.optionSelected, nodes.optionSelected);
    shift(src.nodes.isClickable, nodes.isClickable);
    for (let k = 0; k < (src.nodes.inputValue?.index.length ?? 0); k++) {
      nodes.inputValue.index.push(src.nodes.inputValue!.index[k]! + off);
      nodes.inputValue.value.push(src.nodes.inputValue!.value[k]!);
    }
    for (let k = 0; k < (src.nodes.shadowRootType?.index.length ?? 0); k++) {
      nodes.shadowRootType.index.push(src.nodes.shadowRootType!.index[k]! + off);
      nodes.shadowRootType.value.push(src.nodes.shadowRootType!.value[k]!);
    }
    for (let li = 0; li < src.layout.nodeIndex.length; li++) {
      layout.nodeIndex.push(src.layout.nodeIndex[li]! + off);
      layout.bounds.push(src.layout.bounds[li] ?? []);
      layout.text.push(src.layout.text?.[li] ?? -1);
      layout.styles.push(src.layout.styles?.[li] ?? []);
      layout.scrollRects.push(src.layout.scrollRects?.[li]);
      layout.clientRects.push(src.layout.clientRects?.[li]);
    }
  }
  return { nodes, layout, title: docs[0]?.title ?? -1, perDocument };
}

export function compile(facts: RawFacts): WirGraph {
  const t0 = Date.now();
  const s = facts.snapshot.strings;
  if (!facts.snapshot.documents[0]) throw new Error('empty snapshot');
  const str = (i: number | undefined): string => (i === undefined || i < 0 ? '' : (s[i] ?? ''));

  const flat = flattenDocuments(facts.snapshot);
  // The top layer, from the census (core/host.ts captureTopLayer). Marks the
  // node and admits it: see WirNode.topLayer.
  const topLayer = new Set<number>(facts.topLayer ?? []);
  // Which document segment a node belongs to, so its href resolves against that
  // document's own base. Segments are contiguous and ascending, so one linear
  // fill answers every lookup; a per-node search would be O(nodes x documents)
  // on the hot path.
  const docOf = new Int32Array(flat.nodes.parentIndex.length).fill(0);
  for (let d = 0; d < flat.perDocument.length; d++) {
    const seg = flat.perDocument[d]!;
    docOf.fill(d, seg.first, seg.first + seg.count);
  }
  const baseFor = (i: number): string => {
    const seg = flat.perDocument[docOf[i] ?? 0];
    // Fall back through the document's own URL to the page's: an empty base is
    // what a snapshot gives for a document that has none, and resolving against
    // '' would throw away an otherwise-good relative href.
    return str(seg?.baseURL ?? -1) || str(seg?.documentURL ?? -1) || facts.url;
  };
  const doc = { title: flat.title, layout: flat.layout, nodes: flat.nodes };
  const n = doc.nodes;
  const count = n.parentIndex.length;

  // layout join: nodeIndex -> bounds; a node present in layout is rendered.
  // `visibility: hidden` (and `collapse`) OCCUPY layout but the browser paints
  // them nowhere — admitting them let a hidden control compile named+clickable
  // while the oracle's checkVisibility said invisible (review R1; reproduced on

  // compiled as {role:link, name:"Search for project", clickable}).
  // The test is PER LAYOUT NODE, never subtree pruning: visibility is inherited
  // but overridable, so a visible descendant of a hidden ancestor carries
  // `visibility: visible` in its own entry and must survive — dropping the
  // subtree would be the zero-tolerance recall class.
  // `display: none` needs no handling here: such elements never enter the layout
  // tree at all, so they are already absent. Do not double-handle it.
  //
  // JUDGEMENT, stated because it sits on the zero-tolerance recall boundary: this
  // drop is SILENT. coverage.gaps is built only from cross-document regions, so a
  // page whose menu items are visibility:hidden until :hover reports
  // coverage.complete with those controls absent and uncounted. That is the
  // intended reading — a node the browser paints nowhere is not something "the
  // runtime saw and did not show you", it is something the page is not currently
  // showing, and it becomes visible (and compiled) once the model opens the menu.
  // The alternative — counting every hidden node as a coverage gap — would report
  // a gap on almost every real page and make the signal useless. Recorded here so
  // the choice is visible rather than implicit.
  const VISIBILITY_COLUMN = SNAPSHOT_COMPUTED_STYLES.indexOf('visibility');
  const layoutOf = new Map<number, [number, number, number, number]>();
  for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
    const styles = doc.layout.styles?.[li];
    // Absent styles (the document node carries an empty entry) read as visible:
    // a missing measurement must never delete a node.
    const visibility = styles === undefined ? '' : str(styles[VISIBILITY_COLUMN]);
    if (visibility === 'hidden' || visibility === 'collapse') continue;
    const ni = doc.layout.nodeIndex[li]!;
    const b = doc.layout.bounds[li]!;
    if (!layoutOf.has(ni)) layoutOf.set(ni, [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0]);
  }
  // WHICH REGIONS SCROLL. CDP gives a scroll rect and a client rect per layout
  // node; content past the fold makes the former larger. Nothing else in the
  // runtime can answer this, and the caller pays for the silence: measured on the

  // PAGE instead — `scroll` walks to the nearest scrollable ancestor, but the
  // caller cannot see which boxes those are — and the accept button that
  // container gates stayed `disabled` on every run.
  //
  // A 4px slack, the same tolerance scrollContainer's own vRoom test uses, so a
  // sub-pixel rounding difference does not advertise a scroller that cannot move.
  const scrollableNodes = new Set<number>();
  for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
    const sr = doc.layout.scrollRects?.[li];
    const cr = doc.layout.clientRects?.[li];
    if (sr === undefined || cr === undefined) continue;
    const sH = sr[3] ?? 0,
      cH = cr[3] ?? 0,
      sW = sr[2] ?? 0,
      cW = cr[2] ?? 0;
    if (sH - cH > 4 || sW - cW > 4) scrollableNodes.add(doc.layout.nodeIndex[li]!);
  }
  // HOW MANY OPTIONS A CONTROL HAS. The <option> elements are in the DOM but
  // never compiled: inside a closed <select> they render nothing, so the
  // admission rule drops them — correctly, since they are not separately
  // addressable. But their COUNT is the only thing that distinguishes the real
  // dropdown from the styled wrapper beside it.
  //

  // and exactly one is a <select>. An agent asked to choose an option tried two
  // of them, got "this control has no <option> elements", and never reached the
  // third — the dropdown request failed on every run for want of one integer.
  //
  // AND WHAT THOSE OPTIONS SAY. The count alone was not enough, and the gap was
  // a contradiction inside this system: agent/loop.ts told the model to
  // "enumerate the chooser's own options (find with role option over the
  // select)" while this compiler guaranteed that query returns nothing.

  // find(role=option) matched 0 of 117, read(the select) returned childrenTotal
  // 0, and page_ground_truth (a direct page.evaluate, no WIR) showed both
  // "Email" and "ZIP Code" sitting there. That is the zero-tolerance class in
  // CLAUDE.md: the runtime saw it and did not show you.
  //
  // The options still get no refs — inside a closed <select> they are genuinely
  // not separately addressable, and `act` selects by LABEL, not by ref. So the
  // labels travel on the select itself, which is the node the model acts on.
  const optionCounts = new Map<number, number>();
  const optionLabels = new Map<number, string[]>();
  const textOf = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    if (n.nodeType[i] !== 3) continue;
    const parent = n.parentIndex[i] ?? -1;
    if (parent < 0) continue;
    const t = str(n.nodeValue[i]).replace(/\s+/g, ' ').trim();
    if (t) textOf.set(parent, (textOf.get(parent) ?? '') + t);
  }
  for (let i = 0; i < count; i++) {
    if (str(n.nodeName[i]).toLowerCase() !== 'option') continue;
    const parent = n.parentIndex[i] ?? -1;
    if (parent < 0) continue;
    optionCounts.set(parent, (optionCounts.get(parent) ?? 0) + 1);
    // The rendered label first — that is what a person reads and what `act`
    // matches. `label`/`value` are the fallbacks for an option with no text.
    const flat = n.attributes[i] ?? [];
    const at = new Map<string, string>();
    for (let a = 0; a + 1 < flat.length; a += 2)
      at.set(str(flat[a]).toLowerCase(), str(flat[a + 1]));
    const label = textOf.get(i) || at.get('label') || at.get('value') || '';
    if (label) optionLabels.set(parent, [...(optionLabels.get(parent) ?? []), label]);
  }
  const flagged = (rare: { index: number[] } | undefined): Set<number> =>
    new Set(rare?.index ?? []);
  const clickableSet = flagged(n.isClickable);
  const checkedSet = flagged(n.inputChecked);
  const selectedSet = flagged(n.optionSelected);
  const valueOf = new Map<number, string>();
  if (n.inputValue)
    for (let i = 0; i < n.inputValue.index.length; i++) {
      valueOf.set(n.inputValue.index[i]!, str(n.inputValue.value[i]));
    }

  // pass 1: decode elements and rendered text ownership
  const records: (DomRecord | null)[] = new Array(count).fill(null);
  // Every text node's normalised text, keyed by its parent element, WITHOUT the
  // layout condition below. This is the only text an unrendered element has —
  // a display:none subtree's text nodes never enter layout — and the
  // unrendered side-list reads it; nothing admitted does.
  const directText = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const type = n.nodeType[i]!;
    if (type === 3) {
      const p3 = n.parentIndex[i] ?? -1;
      if (p3 >= 0) {
        const t3 = str(n.nodeValue[i]).replace(/\s+/g, ' ').trim();
        if (t3) directText.set(p3, `${directText.get(p3) ?? ''} ${t3}`.trim());
      }
      if (!layoutOf.has(i)) continue;
      const raw = str(n.nodeValue[i]);
      const text = raw.replace(/\s+/g, ' ').trim();
      // A whitespace-only node is kept, with an EMPTY normalised text. It is not
      // content — every normalised consumer must skip it, and the ones that
      // count runs do — but between two highlighted tokens it is the only
      // record that a space was there. Dropping it is why `<span>lang</span>`
      // and `<span>=</span>` could not be told apart from `<span> </span>`
      // between them, and so why source could not be rebuilt.
      if (!text && !raw) continue;
      const p = records[n.parentIndex[i]!];
      // `i` is the run's global document index — the only thing that can put it
      // back among the element's children, which are also in document order.
      if (p) p.ownText.push({ index: i, text, raw });
      continue;
    }
    if (type !== 1) continue;
    const attrs = new Map<string, string>();
    const flat = n.attributes[i] ?? [];
    for (let a = 0; a + 1 < flat.length; a += 2)
      attrs.set(str(flat[a]).toLowerCase(), str(flat[a + 1]));
    records[i] = {
      index: i,
      parentIndex: n.parentIndex[i]!,
      tag: str(n.nodeName[i]).toLowerCase(),
      backendNodeId: n.backendNodeId[i]!,
      attrs,
      rendered: layoutOf.has(i),
      bounds: layoutOf.get(i) ?? null,
      clickable: clickableSet.has(i),
      checked: checkedSet.has(i),
      selected: selectedSet.has(i),
      value: valueOf.get(i) ?? null,
      ownText: [],
    };
  }

  // A styled checkbox/radio often hides the real <input> with display:none and
  // paints a <label> instead. The input still exists in DOMSnapshot — including
  // its exact checked bit and value — but the rendered-only admission rule
  // correctly gives it no ref. Without joining the label to that hidden control,
  // all five stars in a rating widget become five identical clickable labels and
  // the selected value disappears.
  //
  // This is the HTML platform's labeled-control relation, not a visual or
  // site-specific guess: explicit `for`/`id` and the wrapping-label form are the
  // two standard associations. Only hidden radio/checkbox inputs are proxied.
  // A visible input already compiles with the browser's own role/name/state, and
  // proxying its label as well would duplicate one control into two.
  // FIRST-WINS, because that is what an id MEANS. getElementById and a label's
  // `control` both resolve to the FIRST element in tree order carrying the id;
  // a duplicate id later in the document is invalid HTML the browser ignores.
  // Last-wins made a duplicated id shadow the real control, so one radio
  // compiled as TWO nodes — the rendered input, and a label proxying a hidden
  // namesake — whose `checked` then disagreed permanently after a click.
  // This behavior was verified during testing.
  // SIX nodes for THREE options, the controlId family froze on the pre-click
  // value while the other flipped correctly, and truth was only reachable by
  // leaving the form. The oracle confirms the browser's own `label.control` is
  // the first rendered input for all three labels.
  const byId = new Map<string, DomRecord>();
  for (const r of records) {
    const id = r?.attrs.get('id');
    if (r && id && !byId.has(id)) byId.set(id, r);
  }
  const labelControl = new Map<number, DomRecord>();
  const proxyable = (r: DomRecord | null | undefined): r is DomRecord => {
    if (!r || r.rendered || r.tag !== 'input') return false;
    const type = (r.attrs.get('type') ?? 'text').toLowerCase();
    return type === 'radio' || type === 'checkbox';
  };
  for (const label of records) {
    if (!label || !label.rendered || label.tag !== 'label') continue;
    const target = byId.get(label.attrs.get('for') ?? '');
    if (proxyable(target)) labelControl.set(label.index, target);
  }
  // The implicit form is <label>words <input hidden></label>. Walk each eligible
  // input's ancestor chain once; explicit `for` wins when both are present.
  for (const control of records) {
    if (!proxyable(control)) continue;
    let p = control.parentIndex;
    while (p >= 0) {
      const ancestor = records[p];
      if (ancestor?.tag === 'label' && ancestor.rendered) {
        if (!labelControl.has(ancestor.index)) labelControl.set(ancestor.index, control);
        break;
      }
      p = n.parentIndex[p] ?? -1;
    }
  }

  // AX join: backendDOMNodeId -> browser-computed role/name/disabled
  const axByBackend = new Map<
    number,
    {
      role: string;
      name: string;
      description: string;
      disabled: boolean;
      required: boolean;
      invalid: boolean;
      level: number | null;
      value: string;
    }
  >();
  for (const ax of facts.ax) {
    if (ax.ignored || ax.backendDOMNodeId === undefined) continue;
    const role = ax.role?.value ?? '';
    const name = ax.name?.value ?? '';
    // The browser's own description, beside its name — the page's words,
    // trimmed, never synthesized. `getFullAXTree` has always returned it; the
    // AXNodeRaw declaration is what hid it (core/host.ts).
    const description = (ax.description?.value ?? '').trim();
    // The browser's own value, kept because DOMSnapshot's `inputValue` does not
    // cover a <select> — it carries INPUT values only. So every combobox in the
    // graph read as valueless: measured across 23 recorded episodes, 197 combobox
    // nodes appeared in read/find responses and NOT ONE carried a value, while
    // radio (271), textbox (66), Date (42) and button (37) all carried theirs.
    // A model that cannot see what a dropdown is set to selects it again — 27
    // turns across three episodes did exactly that, and one then blamed its own
    // correct selection for the failure it could not explain.
    const axValue = typeof ax.value?.value === 'string' ? ax.value.value : '';
    // The SAME computation act.ts makes at dispatch time, made once here. Act
    // refuses a disabled target outright; if the projection reaches that
    // conclusion by a different route, the model is told a control is live and
    // then refused when it uses it.
    const disabled = (ax.properties ?? []).some(
      (p) => p.name === 'disabled' && p.value?.value === true,
    );
    // `required` and `invalid` for the same reason `disabled` is here: the
    // browser has already computed them and the caller cannot see them.
    //
    // Constraint validation blocks a submit SILENTLY as far as the DOM is
    // concerned — no mutation, no message, `act` honestly reports
    // no_observable_change_yet — while Chrome knows exactly which control it
    // This behavior was verified during testing.
    // whose accessible name is empty (its label sits outside the shadow root)
    // took the text "Test", the submit did nothing at all, and nothing in any
    // response said which field was at fault or why.
    const required = (ax.properties ?? []).some(
      (p) => p.name === 'required' && p.value?.value === true,
    );
    const invalid = (ax.properties ?? []).some(
      (p) => p.name === 'invalid' && p.value?.value !== 'false' && p.value?.value !== false,
    );
    const lvl = (ax.properties ?? []).find((p) => p.name === 'level')?.value?.value;
    const level = typeof lvl === 'number' ? lvl : null;
    if (!axByBackend.has(ax.backendDOMNodeId)) {
      axByBackend.set(ax.backendDOMNodeId, {
        role,
        name,
        description,
        disabled,
        required,
        invalid,
        level,
        value: axValue,
      });
    }
  }

  // admission: a DOM element becomes a graph node if it is rendered AND
  // (interactive | structural | named-by-AX | owns text)
  const admitted = new Map<number, WirNode>();
  // 12 hex chars (48 bits): at ~3,000 nodes/page the 8-char space had ≈0.1%
  // per-compile collision odds — an eventual silent subtree drop across a long
  // suite (review finding C1, zero-tolerance class). On the residual collision,
  // fall back to the full digest — distinct backendIds can never share it — and
  // memoize so a ref is stable for the life of the compile regardless of call
  // order.
  const refByBackend = new Map<number, string>();
  const usedRefs = new Set<string>();
  const refOf = (backendId: number): string => {
    const memo = refByBackend.get(backendId);
    if (memo !== undefined) return memo;
    const digest = createHash('sha1').update(`${facts.epoch}:${backendId}`).digest('hex');
    let ref = 'n_' + digest.slice(0, 12);
    if (usedRefs.has(ref)) ref = 'n_' + digest;
    usedRefs.add(ref);
    refByBackend.set(backendId, ref);
    return ref;
  };

  const mkNode = (r: DomRecord): WirNode => {
    const ax = axByBackend.get(r.backendNodeId);
    const representedControl = labelControl.get(r.index) ?? null;
    let role = ax?.role && ax.role !== 'generic' ? ax.role : (IMPLICIT_ROLE[r.tag] ?? 'generic');
    if (representedControl) {
      const type = (representedControl.attrs.get('type') ?? '').toLowerCase();
      role = type === 'radio' ? 'radio' : 'checkbox';
    }
    if (r.tag === 'a' && !r.attrs.has('href')) role = 'generic';
    if (r.tag === 'input') {
      const t = (r.attrs.get('type') ?? 'text').toLowerCase();
      if (!ax?.role)
        role =
          t === 'checkbox'
            ? 'checkbox'
            : t === 'radio'
              ? 'radio'
              : t === 'submit' || t === 'button' || t === 'image'
                ? 'button'
                : 'textbox';
    }
    // The normalised join is UNCHANGED in behaviour: same order, same separator,
    // same result. read.ts's label dedup compares a run to node.name by exact
    // string equality, and for name-from-content roles node.name IS this string,
    // so any drift here silently duplicates the label into content.
    const ownText = r.ownText
      .map((t) => t.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Fallback accname when the AX join is missing (review C3): follow the
    // algorithm's precedence — aria-label, then img alt, then name-from-content.
    // Content here is DIRECT text only; descendants are folded in by the
    // post-linkage pass below (<a><span>Submit</span></a> must not be nameless —
    // "every plain link has an empty name" is the named invariant failure).
    let name = ax?.name ?? '';
    if (!name) name = r.attrs.get('aria-label')?.trim() ?? '';
    if (!name && r.tag === 'img') name = r.attrs.get('alt')?.trim() ?? '';
    if (!name && NAME_FROM_CONTENT.has(role)) name = ownText;
    const state: Record<string, string | boolean> = {};
    const stateRecord = representedControl ?? r;
    // EXPLICIT false for a control that HAS a checked concept, exactly as
    // `expanded` is emitted true|false below. The set behind stateRecord.checked
    // is a DOMSnapshot rare-index of the nodes that ARE checked, so absence
    // conflates "unchecked" with "not checkable at all", and a caller cannot read
    // a boolean out of a missing key.
    //
    // This behavior was verified during testing.
    // {role:"checkbox", name:"Notify Customer by Email", value:"1"} with NO state
    // field — and that "1" is the HTML value ATTRIBUTE, which reads as "on" at a
    // glance. The episode reached the right order, wrote the right message, and
    // the site committed it, then rendered "Not Notified" because Notify was left
    // at its default on a request whose verb is "Notify".
    const checkableRole =
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'switch' ||
      role === 'menuitemcheckbox' ||
      role === 'menuitemradio';
    const checkableType = (stateRecord.attrs.get('type') ?? '').toLowerCase();
    const checkableTag =
      stateRecord.tag === 'input' && (checkableType === 'checkbox' || checkableType === 'radio');
    if (stateRecord.checked) state['checked'] = true;
    else if (checkableRole || checkableTag) state['checked'] = false;
    if (stateRecord.selected) state['selected'] = true;
    // The browser's own AX `disabled` property, and ONLY that. It covers all
    // three ways to be disabled — the attribute, `aria-disabled="true"`, and
    // inheritance from a `<fieldset disabled>` — and it is the same computation
    // `act` makes at dispatch, which is the whole point.
    //
    // Reading the ATTRIBUTE as well was wrong in the other direction, and the
    // first version of this fix did exactly that. `disabled` is not a valid
    // attribute on `<a>`, so the browser ignores it — but React renders
    // `<a disabled={true}>` as one, and hand-written menus carry it. Measured:
    // `<a href="/x" disabled>` projected `state.disabled = true` while `act`
    // clicked it happily. A control marked dead that the executor treats as
    // live is the same disagreement this fix exists to remove, pointing the
    // other way.
    if (ax?.disabled ?? false) state['disabled'] = true;
    if (ax?.required ?? false) state['required'] = true;
    if (ax?.invalid ?? false) state['invalid'] = true;
    const exp = r.attrs.get('aria-expanded');
    if (exp) state['expanded'] = exp === 'true';
    const affordances: string[] = [];
    // An ARIA widget role is an affordance in its own right. `r.clickable` is
    // Chrome's isClickable, which keys on a handler bound TO THE NODE — and every
    // major component library delegates instead, binding one listener at a root
    // container. So Material UI's `<div role="button">` select carried no
    // affordance, and `read` dropped it from `controls` while `find {role:
    // "button"}` returned it and `act click` on it verified: controlsTotal said 20
    // with nothing withheld, and the country field was simply not in the list.
    // That is "the runtime saw it and did not show you" — the zero-tolerance
    // class — reached through the affordance filter at read.ts:175.

    if (
      r.clickable ||
      (r.tag === 'a' && r.attrs.has('href')) ||
      r.tag === 'button' ||
      ACTIVATABLE_ROLES.has(role)
    )
      affordances.push('clickable');
    // `file` belongs in this exclusion list for the same reason checkbox does:
    // its value is not writable text. The browser refuses assignment outright
    // (only a user gesture or setFileInputFiles may set it), so advertising
    // `editable` promised a capability the runtime does not have — `act fill`
    // on one returns contradicted/value_mismatch every time. A file input takes
    // a file, and says so.
    const inputType = (r.attrs.get('type') ?? 'text').toLowerCase();
    const isFileInput = r.tag === 'input' && inputType === 'file';
    if (
      r.tag === 'textarea' ||
      (r.tag === 'input' &&
        !['checkbox', 'radio', 'submit', 'button', 'image', 'hidden', 'file'].includes(
          inputType,
        )) ||
      r.attrs.get('contenteditable') === 'true'
    )
      affordances.push('editable');
    if (isFileInput) affordances.push('uploadable');
    if (r.tag === 'select') affordances.push('selectable');
    // SCROLLABLE, from the layout rects above. This is the one affordance the
    // caller cannot infer from role or tag: a scrollable box is usually a bare
    // <div>, indistinguishable from every other <div> in the projection. Without
    // it, "scroll the legal text" becomes "scroll something and hope" — measured

    // button that container gates never enabled.
    if (scrollableNodes.has(r.index)) affordances.push('scrollable');
    const b = r.bounds;
    // Resolve against the OWNING DOCUMENT's base, not the top page URL. A
    // relative href inside an iframe resolves against the frame's document, and
    // any page carrying `<base href>` redirects resolution for its whole

    // a URL the page would never navigate to.
    //
    // This is not cosmetic. `href` feeds act's navigation verdict (act.ts:773),
    // and a verdict computed against a URL the click could not produce is a
    // false `contradicted` — the failure lessons.md records as having poisoned
    // attempt 6's world model.
    let href = r.attrs.get('href') ?? null;
    if (href !== null) {
      try {
        href = new URL(href, baseFor(r.index)).toString();
      } catch {
        /* keep raw */
      }
    }
    return {
      ref: refOf(r.backendNodeId),
      backendNodeId: r.backendNodeId,
      parentRef: null,
      role,
      axRole: ax?.role ?? '',
      axName: ax?.name ?? '',
      name,
      ...(ax?.description ? { description: ax.description } : {}),
      ...(topLayer.has(r.backendNodeId) ? { topLayer: true as const } : {}),
      tag: r.tag,
      state,
      affordances,
      // The control's own HTML name, for the controls that have one. A filter
      // input the accname algorithm leaves anonymous is unaddressable: find
      // matches on name, and there is nothing to match. Measured on a live

      // name "" and an item label of literally "undefined undefined", while the
      // oracle showed the same inputs carrying name="title", "nickname",
      // "detail". A strong model recovered by counting columns; that is
      // structural bookkeeping the runtime should not be pushing onto a caller.
      fieldName:
        r.tag === 'input' || r.tag === 'select' || r.tag === 'textarea'
          ? r.attrs.get('name')?.trim() || null
          : null,
      optionCount: optionCounts.get(r.index) ?? null,
      optionLabels: optionLabels.get(r.index) ?? null,
      geometry: b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null,
      text: ownText,
      // The runs themselves, in document order, each with the index that places
      // it among childRefs and the raw form that survives whitespace. `text`
      // above stays exactly what it was — this is additional, not a replacement.
      textRuns: r.ownText.map((t) => ({ index: t.index, text: t.text, raw: t.raw })),
      level: role === 'heading' ? (ax?.level ?? null) : null,
      href,
      rel: r.attrs.get('rel')?.trim() || null,
      // DOMSnapshot first, the browser's AX value second. The order matters:
      // inputValue is the census reading for INPUT elements and stays
      // authoritative there; AX fills the hole it does not cover, which is a
      // <select>'s current option.
      value:
        stateRecord.value !== null && stateRecord.value !== ''
          ? stateRecord.value
          : ax?.value
            ? ax.value
            : null,
      controlId: representedControl?.attrs.get('id') ?? null,
      childRefs: [],
    };
  };

  // PRESENT BUT UNREVEALED (types.ts UnrenderedCandidate). An element that is
  // in the document and not rendered is dropped here — correctly: a node the
  // browser paints nowhere is not addressable and gets no ref. But the drop was
  // SILENT, and on a page whose navigation lives in collapsed flyouts that

  // dashboard answered 0 of 229 with no lead while "All Reviews" sat one menu

  // keeps a bounded side-list of what was dropped for that reason alone — no
  // refs, no admission, no matcher — so find can say "N unrendered nodes carry
  // this text, inside these rendered containers".
  //
  // STRONG: would have been admitted on tag, role or label had it been
  // rendered. Text-owning elements with no strong unrendered ancestor are
  // candidates too (a hidden paragraph in a closed <details>); one WITH a
  // strong ancestor folds its text upward into it, so `<a><span>All
  // Reviews</span></a>` is one candidate — the link — not two.
  const excludedSubtree = new Uint8Array(count);
  const strongAncestor = new Uint8Array(count);
  // `title` counts as a label here for the same reason it reaches the graph
  // as `description` above: it is the only word an icon control like Page
  // Builder's `<i title="Close Full Screen">` carries, and hidden it would
  // otherwise be neither a candidate nor searchable.
  const isStrong = (r: DomRecord): boolean =>
    INTERACTIVE_TAGS.has(r.tag) ||
    STRUCTURAL_TAGS.has(r.tag) ||
    ACTIVATABLE_ROLES.has((r.attrs.get('role') ?? '').toLowerCase()) ||
    (r.attrs.get('aria-label') ?? '').trim() !== '' ||
    (r.attrs.get('title') ?? '').trim() !== '' ||
    (r.tag === 'img' && (r.attrs.get('alt') ?? '').trim() !== '');
  for (let i = 0; i < count; i++) {
    const r = records[i];
    const p = n.parentIndex[i] ?? -1;
    if (p >= 0 && excludedSubtree[p]) excludedSubtree[i] = 1;
    if (r && NEVER_CONTENT_TAGS.has(r.tag)) excludedSubtree[i] = 1;
    if (p >= 0) {
      const pr = records[p];
      if (pr && !pr.rendered && (isStrong(pr) || strongAncestor[p])) strongAncestor[i] = 1;
    }
  }

  for (const r of records) {
    if (!r || !r.rendered) continue;
    if (
      r.tag === 'script' ||
      r.tag === 'style' ||
      r.tag === 'head' ||
      r.tag === 'meta' ||
      r.tag === 'link'
    )
      continue;
    const ax = axByBackend.get(r.backendNodeId);
    const interesting =
      INTERACTIVE_TAGS.has(r.tag) ||
      STRUCTURAL_TAGS.has(r.tag) ||
      r.clickable ||
      (ax !== undefined &&
        (ax.name !== '' || (ax.role !== '' && ax.role !== 'generic' && ax.role !== 'none'))) ||
      r.ownText.some((t) => t.text !== '') ||
      // A SCROLLABLE BOX IS AN INTERACTIVE SURFACE, and one of the eight actions
      // addresses it. Without this it is admitted by none of the tests above: a
      // scroll container is typically a bare <div> with no name, no AX role and
      // no OWN text — its text belongs to the paragraphs inside it.
      //
      // So the runtime could scroll it and could not name it, which is the recall

      // stress test — `read target` on the legal-text container answered
      // `unknown_ref`, an agent told to scroll it scrolled the PAGE instead, and
      // the accept button that container gates stayed disabled on every run.
      //
      // Bounded by construction: scrollRects exceed clientRects on 3 of 238 layout
      // nodes on that page, and a document that scrolls everything is a document
      // whose boxes the caller needs to see anyway.
      scrollableNodes.has(r.index) ||
      // A top-layer element is a region by construction — it is what the
      // page has put over everything else — and it stays visible even when
      // it is a bare div with no name of its own (an open `[popover]`).
      topLayer.has(r.backendNodeId);
    if (interesting) admitted.set(r.index, mkNode(r));
  }

  // containment: parentRef = nearest admitted ancestor (contains edges)
  const nodes = new Map<string, WirNode>();
  const byBackendId = new Map<number, string>();
  const rootRef = ROOT_REF;
  const root: WirNode = {
    ref: rootRef,
    backendNodeId: -1,
    parentRef: null,
    role: 'document',
    axRole: '',
    axName: '',
    name: str(doc.title),
    tag: '#document',
    state: {},
    affordances: [],
    geometry: null,
    fieldName: null,
    optionCount: null,
    optionLabels: null,
    text: '',
    textRuns: [],
    level: null,
    href: null,
    value: null,
    controlId: null,
    childRefs: [],
  };
  nodes.set(rootRef, root);
  for (const [idx, node] of admitted) {
    // Climb the RAW parent chain, not the records one: records holds elements
    // only, and a frame's content hangs beneath a Document node (nodeType 9).
    // Reading the chain through records stopped dead there, so every node inside
    // an iframe re-parented to the graph root — present, but outside the element
    // that owns it, which makes `within` scoping and ancestor context silently
    // wrong for exactly the content frames were opened to reach.
    let p = records[idx]?.parentIndex ?? -1;
    while (p >= 0 && !admitted.has(p)) p = n.parentIndex[p] ?? -1;
    const parent = p >= 0 ? admitted.get(p)! : root;
    node.parentRef = parent.ref;
    parent.childRefs.push(node.ref);
    nodes.set(node.ref, node);
    byBackendId.set(node.backendNodeId, node.ref);
  }

  // The unrendered side-list, resolved now that `admitted` is final. One pass
  // in REVERSE document order (DOMSnapshot is preorder, so every child index is
  // greater than its parent's): each unrendered element's pending text is its
  // own direct text plus what non-recorded descendants passed up; a recorded
  // candidate consumes its pending text and passes nothing further, so text is
  // counted once. Rendered descendants (a visibility:visible island under a
  // hidden ancestor) are already in the graph and pass nothing either.
  const pendingText = new Map<number, string>();
  const pendingCut = new Set<number>();
  const collected: UnrenderedCandidate[] = [];
  let unrenderedTotal = 0;
  for (let i = count - 1; i >= 0; i--) {
    const r = records[i];
    if (!r || r.rendered || excludedSubtree[i]) continue;
    const own = directText.get(i) ?? '';
    let text = `${own} ${pendingText.get(i) ?? ''}`.replace(/\s+/g, ' ').trim();
    let cut = pendingCut.has(i);
    if (text.length > UNRENDERED_TEXT_BOUND) {
      text = text.slice(0, UNRENDERED_TEXT_BOUND);
      cut = true;
    }
    const label =
      (r.attrs.get('aria-label') ?? '').trim() ||
      (r.tag === 'img' ? (r.attrs.get('alt') ?? '').trim() : '');
    const candidate = isStrong(r) || (own !== '' && !strongAncestor[i]);
    // The title joins what the disclosure shows and matches on — the only word
    // This behavior was verified during testing.
    // title="Save & Close">Save & Close</span>` read back doubled.
    const title = (r.attrs.get('title') ?? '').trim();
    const withTitle =
      title !== '' && !`${label} ${text}`.includes(title)
        ? `${label} ${title} ${text}`
        : `${label} ${text}`;
    const shown = withTitle.replace(/\s+/g, ' ').trim();
    if (candidate && shown !== '') {
      unrenderedTotal++;
      let role = (r.attrs.get('role') ?? '').toLowerCase() || (IMPLICIT_ROLE[r.tag] ?? 'generic');
      if (r.tag === 'a' && !r.attrs.has('href')) role = 'generic';
      if (r.tag === 'input' && !r.attrs.has('role')) {
        const t = (r.attrs.get('type') ?? 'text').toLowerCase();
        role =
          t === 'checkbox'
            ? 'checkbox'
            : t === 'radio'
              ? 'radio'
              : t === 'submit' || t === 'button' || t === 'image'
                ? 'button'
                : 'textbox';
      }
      let p = r.parentIndex;
      while (p >= 0 && !admitted.has(p)) p = n.parentIndex[p] ?? -1;
      collected.push({
        tag: r.tag,
        role,
        text: shown,
        textComplete: !cut,
        containerRef: p >= 0 ? admitted.get(p)!.ref : rootRef,
      });
      continue; // consumed: nothing passes up
    }
    const p = r.parentIndex;
    if (p >= 0 && text !== '') {
      const parentRec = records[p];
      if (parentRec && !parentRec.rendered) {
        pendingText.set(p, `${pendingText.get(p) ?? ''} ${text}`.trim());
        if (cut) pendingCut.add(p);
      }
    }
  }
  // Reverse order in, document order out; the first UNRENDERED_KEEP survive
  // and the exact total travels beside them.
  collected.reverse();
  const unrendered = { candidates: collected.slice(0, UNRENDERED_KEEP), total: unrenderedTotal };

  // AX-ONLY NODES: controls the accessibility tree reports on backend ids the
  // DOM snapshot never delivered. The join above assumed DOMSnapshot was the
  // superset of the AX tree; Chrome's CSS carousel pseudo-elements break that —
  // `::scroll-button()` is a focusable `button`, `::scroll-marker` a `tab`,
  // `::scroll-marker-group` a `tablist`, each with a real backend node id that
  // DOM.describeNode, DOM.getContentQuads and Accessibility.getPartialAXTree all
  // answer for, and none of them in the snapshot's node walk. Measured on
  // This behavior was verified during testing.
  // "Scroll Left"/"Scroll Right" buttons and five named tabs; `find role=button`
  // returned 0 and `read` said controlsTotal 48 with nothing withheld. The
  // runtime saw them and did not show them — the zero-tolerance recall class —
  // and a coordinate click on the button's quad scrolled the carousel, so they
  // are also exactly as actionable as any DOM button.
  //
  // IDENTITY. Bound the same way every other node is: refOf(backendNodeId). The
  // id is the browser's own binding for the pseudo-element, minted by Chrome's
  // DOM agent and stable for the pseudo-element's life, so the ref is opaque,
  // runtime-minted, and revalidated at act time by the same getPartialAXTree
  // probe every DOM ref gets (verified: the probe returns the same role/name
  // for these ids). Nothing here is constructed from names or positions.
  //
  // CONTAINMENT. Their only parent chain is the AX tree's own parentId links
  // (a tab hangs under the tablist pseudo, which hangs under the carousel
  // element), so `contains` follows those until it reaches a DOM element and
  // then the ordinary nearest-admitted-ancestor climb. Two passes: every node
  // is minted first, then linked, because getFullAXTree's order does not put
  // parents before children (the tablist was id 25, its tabs 8-12, the buttons
  // 487-488).
  //
  // ADMISSION is the same rule as for a DOM element: rendered (a box) AND named
  // or carrying a real role. `tag` holds the DOM domain's own nodeName for the
  // node (`::scroll-button(inline-end)`); it is compiler-private, so no caller
  // sees a tag that is not an element name.
  const axById = new Map<string, RawFacts['ax'][number]>();
  for (const a of facts.ax) axById.set(a.nodeId, a);
  const recordIndexByBackend = new Map<number, number>();
  for (const r of records) if (r) recordIndexByBackend.set(r.backendNodeId, r.index);
  const axOnlyNodes = new Map<number, WirNode>();
  for (const fact of facts.axOnly ?? []) {
    if (fact.bounds === null) continue;
    const ax = axByBackend.get(fact.backendNodeId);
    if (!ax) continue;
    const role =
      ax.role !== '' && ax.role !== 'generic' && ax.role !== 'none' ? ax.role : 'generic';
    if (role === 'generic' && ax.name === '') continue;
    const raw = facts.ax.find((a) => a.backendDOMNodeId === fact.backendNodeId && !a.ignored);
    const prop = (name: string): unknown =>
      (raw?.properties ?? []).find((p) => p.name === name)?.value?.value;
    const state: Record<string, string | boolean> = {};
    const checked = prop('checked');
    if (checked === true || checked === 'true') state['checked'] = true;
    else if (checked === false || checked === 'false') state['checked'] = false;
    if (prop('selected') === true) state['selected'] = true;
    if (ax.disabled) state['disabled'] = true;
    const expanded = prop('expanded');
    if (typeof expanded === 'boolean') state['expanded'] = expanded;
    const affordances: string[] = [];
    // The browser's own `focusable` is the pseudo-element's whole handler
    // story — there is no isClickable, no tag, no href to consult.
    if (ACTIVATABLE_ROLES.has(role) || prop('focusable') === true) affordances.push('clickable');
    const [x, y, w, h] = fact.bounds;
    axOnlyNodes.set(fact.backendNodeId, {
      ref: refOf(fact.backendNodeId),
      backendNodeId: fact.backendNodeId,
      parentRef: null,
      role,
      axRole: ax.role,
      axName: ax.name,
      name: ax.name,
      ...(ax.description ? { description: ax.description } : {}),
      tag: fact.nodeName.toLowerCase(),
      state,
      affordances,
      fieldName: null,
      optionCount: null,
      optionLabels: null,
      geometry: { x, y, w, h },
      text: '',
      textRuns: [],
      level: role === 'heading' ? ax.level : null,
      href: null,
      value: ax.value ? ax.value : null,
      controlId: null,
      childRefs: [],
    });
  }
  const axOnlyParent = (backendNodeId: number): WirNode => {
    let pid = facts.ax.find((a) => a.backendDOMNodeId === backendNodeId && !a.ignored)?.parentId;
    for (let guard = 0; guard < 10_000 && pid !== undefined; guard++) {
      const p = axById.get(pid);
      if (!p) break;
      const b = p.backendDOMNodeId;
      if (b !== undefined) {
        const own = axOnlyNodes.get(b);
        if (own) return own;
        const idx = recordIndexByBackend.get(b);
        if (idx !== undefined) {
          let q: number = idx;
          while (q >= 0 && !admitted.has(q)) q = n.parentIndex[q] ?? -1;
          return q >= 0 ? admitted.get(q)! : root;
        }
      }
      pid = p.parentId;
    }
    return root;
  };
  for (const [backendNodeId, node] of axOnlyNodes) {
    const parent = axOnlyParent(backendNodeId);
    node.parentRef = parent.ref;
    parent.childRefs.push(node.ref);
    nodes.set(node.ref, node);
    byBackendId.set(backendNodeId, node.ref);
  }

  // C3 fallback, second half: a name-from-content role still nameless after the
  // direct-text pass takes its subtree's text, verbatim and unbounded (a byte
  // cap on a NAME would be truncation presented as complete).
  for (const node of nodes.values()) {
    if (node.name === '' && NAME_FROM_CONTENT.has(node.role) && node.childRefs.length > 0) {
      const parts: string[] = [];
      const walk = (ref: string): void => {
        const c = nodes.get(ref);
        if (!c) return;
        if (c.text) parts.push(c.text);
        for (const cr of c.childRefs) walk(cr);
      };
      walk(node.ref);
      node.name = parts.join(' ').replace(/\s+/g, ' ').trim();
    }
  }

  // repeats-with: >=2 sibling items of the same collection tag under one parent (inferred)
  const collections: WirCollection[] = [];
  for (const node of nodes.values()) {
    const groups = new Map<string, WirNode[]>();
    for (const cRef of node.childRefs) {
      const c = nodes.get(cRef)!;
      if (COLLECTION_ITEM_TAGS.has(c.tag)) {
        const g = groups.get(c.tag) ?? [];
        g.push(c);
        groups.set(c.tag, g);
      }
    }
    for (const items of groups.values()) {
      if (items.length >= 2) {
        collections.push({
          ref: node.ref,
          itemRefs: items.map((i) => i.ref),
          provenance: 'inferred',
          label: node.name || firstHeadingText(node, nodes) || '',
        });
      }
    }
  }

  const headings = [...nodes.values()].filter((x) => x.role === 'heading').map((x) => x.ref);

  // Frame documents are now compiled into the graph above, so a gap no longer
  // means "this is a frame" — it means "this document had element nodes and none
  // of them reached you". That happens when the frame's accessibility tree could
  // not be pulled (an out-of-process frame this session cannot reach), and it is
  // exactly the case the caller must be told about, with an exact count.
  //
  // A frame that legitimately holds nothing (about:blank spacers, tracking
  // pixels — the overwhelming majority on a real page) reports no gap, because
  // there is nothing withheld. Reporting those was noise that made a
  // load-bearing gap indistinguishable: measured 96.4% of gap regions.
  const admittedPerDoc = new Map<number, number>();
  for (const idx of admitted.keys()) {
    for (let d = 0; d < flat.perDocument.length; d++) {
      const seg = flat.perDocument[d]!;
      if (idx >= seg.first && idx < seg.first + seg.count) {
        admittedPerDoc.set(d, (admittedPerDoc.get(d) ?? 0) + 1);
        break;
      }
    }
  }
  const gaps = flat.perDocument
    .slice(1)
    .map((seg, i) => ({ seg, d: i + 1 }))
    .filter(({ seg, d }) => {
      if ((admittedPerDoc.get(d) ?? 0) > 0) return false; // compiled: no gap
      // Count only element nodes: a document of nothing but text and comments
      // has nothing to withhold.
      let elements = 0;
      for (let i = seg.first; i < seg.first + seg.count; i++) {
        if (n.nodeType[i] === 1) elements++;
      }
      return elements > 0;
    })
    .map(({ seg }) => ({
      region: str(seg.documentURL) || '(frame)',
      estimatedNodes: seg.count,
    }));

  // Can the mutation stream vouch for this graph? DOMSnapshot flattens shadow
  // trees — open and closed — into this document's nodes, so their content is
  // compiled and projected; a MutationObserver reaches neither (measured). One
  // node inside a shadow tree is enough to make cached reuse unprovable, so the
  // session recompiles every call on such a document rather than claiming `live`.
  //
  // AX-only nodes are the second thing the observer cannot see: a pseudo-element
  // is not a DOM node, so its appearance, its box and its `selected` (which
  // follows scroll position on a carousel, with no mutation record anywhere)
  // move nothing the counter counts. A graph holding one is not vouched for
  // either — measured cost is one describeNode + getBoxModel per such node per
  // call, on the pages that have them, and none anywhere else.
  const mutationObservable = (n.shadowRootType?.index.length ?? 0) === 0 && axOnlyNodes.size === 0;

  // WHICH frames this graph actually contains. The vouch is a mutation-stream
  // reading, and it was taken from the main frame alone while the graph folded in
  // every same-process document (flattenDocuments). So an iframe that loaded or
  // mutated after a compile moved no counter, changed no epoch — the epoch is the
  // MAIN frame's loaderId — and the stale graph was re-served stamped `live`.
  // That is verbatim the defect session.ts records this whole mechanism as having
  // been built to kill, returning through the frame door.
  //
  // Only frames that CONTRIBUTED admitted nodes belong here. An out-of-process
  // frame compiles to nothing and is already reported as a coverage gap; making
  // its unreadable token poison the vouch would recompile every call forever on
  // any page with an ad iframe, for content the graph never claimed to hold.
  const contributingFrames: string[] = [];
  for (let d = 0; d < flat.perDocument.length; d++) {
    const seg = flat.perDocument[d]!;
    if ((admittedPerDoc.get(d) ?? 0) === 0) continue;
    const fid = seg.frameId >= 0 ? str(seg.frameId) : '';
    if (fid !== '' && !contributingFrames.includes(fid)) contributingFrames.push(fid);
  }

  return {
    epoch: facts.epoch,
    url: facts.url,
    title: str(doc.title),
    nodes,
    byBackendId,
    rootRef,
    collections,
    headings,
    coverage: { complete: gaps.length === 0, gaps },
    mutationObservable,
    contributingFrames,
    unrendered,
    compiledAt: t0,
    compileMs: Date.now() - t0,
  };
}

function firstHeadingText(node: WirNode, nodes: Map<string, WirNode>): string {
  for (const cRef of node.childRefs) {
    const c = nodes.get(cRef)!;
    if (c.role === 'heading') return c.name || c.text;
    const deeper = firstHeadingText(c, nodes);
    if (deeper) return deeper;
  }
  return '';
}
