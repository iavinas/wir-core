// Regression for the sweep's most-repeated complaint: `matched: 0` reads as "not
// present" when it only ever means "no node satisfied every filter at once".
//
// Reproduced on the live storefront before this was written (probe run
// 2026-08-11T05-47-52-441Z): `find {role:"textbox", name:"Search"}` returned
// `matched: 0 of 308` while a `combobox` named " Search" sat in the same graph.
// The name matched; `role` did the eliminating; nothing in the response said so.
// Five distinct causes produced that identical bare zero across 16 episodes of the
// hand-driven shopping sweep, and a 60-call agent has no way to tell them apart.
//
// The fix is arithmetic, not semantics: re-filter the same scope with each filter
// held out in turn and report which one emptied the result, with the literal call
// that drops it. No matcher, no new capability, no page vocabulary.
//
// The THIRD case below is the one that keeps this honest. A genuine absence must
// still read as a genuine absence — if `eliminatedBy` appeared there too, the fix
// would have replaced one misleading signal with another.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = '<!doctype html><title>attribution</title>'
  + '<h1>Store</h1>'
  // A combobox named "Search" — the exact shape that produced the live defect.
  + '<input role="combobox" aria-label="Search" aria-expanded="false">'
  + '<button>Search</button>'
  // A real textbox, so `role:textbox` alone is not itself empty.
  + '<input type="text" aria-label="Newsletter">';

test('an empty find names the filter that emptied it, and offers the call that drops it',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wir-find-attr-'));
    writeFileSync(join(dir, 'a.html'), PAGE);

    const session = await WirSession.start({
      headless: true,
      expectedAction: 'RETRIEVE',
      storageStatePath: null,
    });
    try {
      await session.goto(`file://${join(dir, 'a.html')}`);
      await session.dispatch({ verb: 'read' });

      // 1. Two filters, one of them wrong. The name matches a combobox; role does not.
      const both = await session.dispatch(
        { verb: 'find', role: 'textbox', name: 'Search' }) as Record<string, any>;
      assert.equal(both['population'].matched, 0, 'precondition: the pair matches nothing');

      const empty = both['empty'];
      assert.ok(empty, 'an empty find carries an empty block');
      assert.equal(empty.meaning, 'no node in scope satisfied every filter at once',
        'the response says what was actually checked, not that the thing is absent');

      const dropRole = (empty.eliminatedBy ?? []).find((e: any) => e.drop === 'role');
      assert.ok(dropRole, 'the response names `role` as a filter that emptied the result');
      assert.ok(dropRole.wouldMatch > 0, 'and says how many nodes survive without it');
      assert.equal(dropRole.call, '{"verb":"find","name":"Search"}',
        'the continuation is the literal next call, not prose');

      // The offered fallback must be a real continuation, not the generic browse
      // advice — that is the pagination invariant: a bound the runtime can compute
      // is offered as the next call, never returned as a bare dead end.
      assert.equal(empty.fallback, dropRole.call);

      // 2. Ranked: the filter whose removal frees the MOST candidates comes first.
      const counts = (empty.eliminatedBy ?? []).map((e: any) => e.wouldMatch);
      assert.deepEqual(counts, [...counts].sort((a: number, b: number) => b - a),
        'candidates are ordered by how much each relaxation would return');

      // 3. THE CONTROL. A genuine absence must not sprout a false lead.
      const absent = await session.dispatch(
        { verb: 'find', name: 'zzzznotonthispage' }) as Record<string, any>;
      assert.equal(absent['population'].matched, 0);
      assert.equal(absent['empty'].eliminatedBy, undefined,
        'a single filter that genuinely matches nothing offers no relaxation');
      assert.match(absent['empty'].fallback, /"verb":"read"/,
        'and falls back to browsing the structure');
    } finally {
      await session.close();
    }
  });
