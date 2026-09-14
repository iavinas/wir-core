// The finish gate reports the POPULATION behind the refs a finish cites: how big it
// is, how much of it this episode was ever shown, and the call that reaches the rest.
// Facts only — the runtime never judges whether the scope is right, because that is a
// comparator over meaning and correctness belongs to the official evaluator.
//
// Replaces byte-ranked "unread continuations", which fired on 98% of episodes and
// changed the answer in ~2% (n=57, one substantive change). TAXONOMY.md named this
// lever with all three coders agreeing.
//
// Two behaviours are pinned, and the second is what stops this becoming the 98%
// problem again:
//
//   1. NESTED COLLECTIONS RESOLVE TO THE INNERMOST. Earned on Hacker News, which
//      wraps its 92-row table inside a 4-row layout table. First-collection-wins
//      credited a cited row to the OUTER one, which read "4 of 4, delivered whole"
//      and silenced the gate on a population the caller had seen 10 of 92 of.
//      WebArena and Wikipedia both passed with the wrong rule — only a site outside
//      the benchmark exposed it.
//
//   2. SILENCE WHEN THERE IS NOTHING TO SAY. A collection delivered whole is not
//      news, and a gate that speaks every episode carries the same information as
//      one that never speaks.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// An outer list of 2 items; the first of them holds an inner list of 24. Both are
// collections, and the inner one is the population a row belongs to.
const rows = Array.from({ length: 24 }, (_, i) => `<li>inner row ${i + 1}</li>`).join('');
const PAGE =
  '<!doctype html><title>scope</title><h1>Nested</h1>' +
  `<ul><li><ul>${rows}</ul></li><li>outer tail</li></ul>`;

test('the finish gate names the innermost population, and stays silent otherwise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-scope-'));
  writeFileSync(join(dir, 'a.html'), PAGE);

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const overview = (await session.dispatch({ verb: 'read' })) as Record<string, any>;

    // The biggest compiled collection is the inner list; cite one of its items.
    const cols = [...(session as any).graph.collections].sort(
      (a: any, b: any) => b.itemRefs.length - a.itemRefs.length,
    );
    const inner = cols[0];
    assert.ok(
      inner.itemRefs.length > 10,
      `precondition: a collection larger than one page (${inner.itemRefs.length})`,
    );

    const cited = inner.itemRefs[0];
    const fin = (await session.dispatch({
      verb: 'finish',
      answer: 'inner row 1',
      evidenceRefs: [cited],
    })) as Record<string, any>;
    assert.equal(fin['accepted'], true, JSON.stringify(fin));

    const scope = fin['scope'];
    assert.ok(
      Array.isArray(scope) && scope.length === 1,
      `expected one fact: ${JSON.stringify(fin)}`,
    );
    assert.equal(
      scope[0].collection,
      inner.ref,
      'the cited row belongs to the INNERMOST collection containing it, not the ' +
        'outer list that happens to enclose everything',
    );
    assert.equal(scope[0].items, inner.itemRefs.length, 'the true size, exact');
    assert.ok(scope[0].delivered < scope[0].items, 'and how much of it was actually handed over');
    assert.equal(
      scope[0].continuation,
      JSON.stringify({ verb: 'read', target: inner.ref }),
      'with the literal call that reaches the rest, never prose',
    );

    // CONTROL. A ref in no partly-seen population must produce no fact at all.
    const heading = (overview['headings'] ?? [])[0]?.ref;
    assert.ok(heading, 'precondition: the overview delivered a heading ref');
    const quiet = (await session.dispatch({
      verb: 'finish',
      answer: 'Nested',
      evidenceRefs: [heading],
    })) as Record<string, any>;
    assert.equal(quiet['accepted'], true, JSON.stringify(quiet));
    assert.equal(
      quiet['scope'],
      undefined,
      'nothing partial was cited, so the gate says nothing — a gate that speaks ' +
        'on every episode is no gate',
    );
  } finally {
    await session.close();
  }
});
