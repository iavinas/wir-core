// The overview grades its item previews by rank instead of issuing them flat.
//
// Measured over the recorded corpus: 96,104 collection-item refs were delivered and
// **1.0%** were ever used — as an act target, a read target, a find scope, or an
// evidence ref. Collections at rank 10+ cost 2.64 MB at 0.06% use. The bare overview
// is 80.6% of all observation bytes and collections are 46% of it, so this one slice
// is roughly 37% of everything the runtime has ever shipped, at a 1-in-100 hit rate.
//
// Measured after, on four real pages (two outside the benchmark): WebArena shopping
// 9,010 -> 7,436 B, WebArena search 10,691 -> 8,508 B, Wikipedia 22,835 -> 13,327 B.
// Hacker News is unchanged at 6,316 B because it has two collections and one region —
// the cut only bites where the tail is long, which is the intended shape.
//
// THE LEGALITY, and what this test exists to pin: nothing is removed. Every
// collection keeps its ref, its EXACT itemCount, its provenance, and a continuation
// that reaches every withheld item. The cut falls on an item boundary, so no partial
// item is presented as whole. Ranking still only orders.
//
// The control case is the no-loss property, asserted over EVERY collection rather
// than the one the test is about: a smaller preview that dropped a continuation
// anywhere would be exactly the "limits are pagination, never loss" violation this
// change is otherwise careful to respect.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Six lists of 12. Ranked labelled-first then largest, so list A is rank 0 and the
// unlabelled ones fall to the tail.
const list = (n: number, label: string) =>
  `<h2>${label}</h2><ul aria-label="${label}">`
  + Array.from({ length: n }, (_, i) => `<li>${label} item ${i + 1}</li>`).join('')
  + '</ul>';
const PAGE = '<!doctype html><title>graded</title><h1>Graded</h1>'
  + ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map(n => list(12, n)).join('');

test('item previews are graded by rank, and every withheld item stays reachable',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wir-graded-'));
    writeFileSync(join(dir, 'a.html'), PAGE);

    const session = await WirSession.start({
      headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
    try {
      await session.goto(`file://${join(dir, 'a.html')}`);
      const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
      const cols = ov['collections'] as any[];
      assert.ok(cols.length >= 4, `precondition: several collections (${cols.length})`);

      // 1. GRADED, not flat. The first collection keeps a full preview; the tail
      //    keeps none. A flat projection would show the same count for both.
      const shown = cols.map(c => (c.items ?? []).length);
      assert.equal(shown[0], 10, `rank 0 keeps the full preview: ${JSON.stringify(shown)}`);
      assert.ok(shown[shown.length - 1] === 0,
        `the tail keeps no preview: ${JSON.stringify(shown)}`);
      assert.ok(shown[0]! > shown[shown.length - 1]!,
        'previews decrease with rank — otherwise nothing was graded');

      // 2. THE CONTROL — no loss, checked on EVERY collection, not just the graded
      //    ones. This is the invariant the byte saving must not buy.
      for (const c of cols) {
        const n = (c.items ?? []).length;
        assert.equal(typeof c.itemCount, 'number', 'the exact size is always stated');
        assert.ok(c.ref, 'the ref is always kept, so the collection stays addressable');
        if (n < c.itemCount) {
          assert.ok(c.moreItems, `withheld items must carry a continuation: ${JSON.stringify(c)}`);
          assert.equal(c.moreItems.count, c.itemCount - n,
            'and the count must be exact, not an estimate of what was cut');
          assert.equal(c.moreItems.estimated, false);
          assert.match(c.moreItems.continuation, /"verb":"read","target":/);
        }
      }

      // 3. The continuation actually reaches the withheld items — a promise the
      //    runtime can compute is worthless if the call it names does not work.
      const tail = cols.find(c => (c.items ?? []).length === 0 && c.itemCount > 0);
      assert.ok(tail, 'precondition: a collection with no preview');
      const drilled = await session.dispatch(
        JSON.parse(tail.moreItems.continuation)) as Record<string, any>;
      assert.equal(drilled['rejected'], undefined,
        `the offered call must be honourable: ${JSON.stringify(drilled['rejected'])}`);
      assert.ok((drilled['children'] ?? []).length > 0,
        'and it must deliver the items the overview withheld');
    } finally {
      await session.close();
    }
  });
