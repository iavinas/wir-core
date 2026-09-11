// A scrollable region is compiled and says it scrolls.
//
// PROVEN RECALL DEFECT. The admission rule keeps a node when it is an
// interactive tag, structural, clickable, AX-named/roled, or has OWN text. A
// scroll container is typically a bare <div> whose text belongs to the
// paragraphs inside it — so it matched none of them and was dropped, while
// `act scroll` could reach it perfectly well by walking the DOM.
//
// Seen, usable, and not shown: the recall class, stated exactly.
//
// Measured on the browser-use stress test: `read target` on the legal-text
// container answered `unknown_ref`; an agent told to scroll it scrolled the PAGE
// instead (scroll walks to the nearest scrollable ancestor, and the caller cannot
// see which boxes those are); and the accept button that container gates stayed
// `disabled` on every run. After this: role generic, affordances ["scrollable"],
// one `scroll value:"end"` takes it 0 -> 432 and the button enables.
//
// HOW IT IS KNOWN: DOMSnapshot's scrollRects vs clientRects, which CDP already
// returns per layout node. Enabling includeDOMRects cost 0 ms and +7 KB on that
// page (66 -> 73 KB), measured before it was turned on.
//
// THE CONTROL IS THE SECOND TEST, and it is what keeps this from being bloat: an
// ordinary <div> that does NOT scroll must still be pruned. On real sites this
// admits 3-16 nodes against 63-2,597 controls (ikea, pbs, coursera, plato,
// caniuse) — bounded, because a document that scrolls everything is one whose
// boxes the caller needs anyway.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// The shape that was dropped: a scrolling box whose text is all in its children,
// beside a plain box of the same construction that does not scroll.
const PAGE = '<!doctype html><title>scrollers</title><h1>Scrollers</h1>'
  + '<div id="box" style="height:100px;overflow-y:scroll">'
  + Array.from({ length: 30 }, (_, i) => `<p>line ${i} of the long text</p>`).join('')
  + '</div>'
  + '<div id="plain"><p>a short paragraph in a box that does not scroll</p></div>';

async function withPage(fn: (s: WirSession) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-scrollable-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });
    await fn(session);
  } finally { await session.close(); }
}

/** Every compiled node carrying an affordance, via find across the graph. */
const scrollables = async (s: WirSession): Promise<any[]> => {
  const out: any[] = [];
  for (const role of ['generic', 'group', 'region']) {
    const r = await s.dispatch({ verb: 'find', role }) as Record<string, any>;
    for (const m of (r['matches'] ?? [])) {
      if ((m.affordances ?? []).includes('scrollable')) out.push(m);
    }
  }
  return out;
};

test('a scrolling box is compiled, and its affordance says so', async () => {
  await withPage(async (s) => {
    const found = await scrollables(s);
    assert.ok(found.length >= 1,
      'the scroll container is in the graph at all — it used to be unknown_ref');

    // And it is USABLE, which is the whole point of admitting it.
    const before = await s.host.page.evaluate(() =>
      Math.round((document.getElementById('box') as HTMLElement).scrollTop));
    assert.equal(before, 0, 'precondition: at the top');

    const r = await s.dispatch(
      { verb: 'act', ref: found[0].ref, action: 'scroll', value: 'end' }) as Record<string, any>;
    assert.equal(r['rejected'], undefined, `it scrolls: ${JSON.stringify(r['rejected'])}`);

    const after = await s.host.page.evaluate(() => {
      const e = document.getElementById('box') as HTMLElement;
      return { top: Math.round(e.scrollTop), max: Math.round(e.scrollHeight - e.clientHeight) };
    });
    assert.ok(after.top >= after.max - 4,
      `and the ORACLE agrees it reached the bottom: ${JSON.stringify(after)}`);
  });
});

test('CONTROL — a box that does NOT scroll is still pruned', async () => {
  // Without this, every <div> on every page would be admitted and the projection
  // would drown. The affordance must mark the few, not relabel the many.
  await withPage(async (s) => {
    const found = await scrollables(s);
    for (const m of found) {
      const detail = await s.dispatch({ verb: 'read', target: m.ref }) as Record<string, any>;
      const text = String(detail['node']?.text ?? '');
      assert.doesNotMatch(text, /does not scroll/,
        `the non-scrolling box must not be marked: ${text}`);
    }
    // The plain div carries no scrollable affordance anywhere in the graph.
    const r = await s.dispatch({ verb: 'find', name: 'does not scroll' }) as Record<string, any>;
    for (const m of (r['matches'] ?? [])) {
      assert.ok(!(m.affordances ?? []).includes('scrollable'),
        `nothing about the plain box scrolls: ${JSON.stringify(m)}`);
    }
  });
});
