// Regression for the D5b defect: on an accepted finish, absent `scope` meant BOTH
// "checked, nothing partial" AND "there was no compiled graph to check against".
// Every act nulls the cached graph (doAct) and finish never compiles, so a finish
// right after a same-document act was silently uncheckable — and it read exactly
// like checked-clean.
//
// Reproduced on a real page before the fix (debug/probe_scope_unknowable.mjs,
// debug/runs/probe/2026-08-13-scope-unknowable): the same finish that reported a
// 10-of-92 population went silent after one hover, then spoke again after a
// re-read. The fix is a disclosure, never a judgment: `scopeUnchecked: true`,
// flat and additive, only when the check could not run. Unknown is not clean.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// A list longer than one page of items, so a cited row names a population the
// episode was shown only part of — the state where `scope` must speak.
const rows = Array.from({ length: 24 }, (_, i) => `<li>row ${i + 1}</li>`).join('');
const PAGE = `<!doctype html><title>unchecked</title><h1>Host</h1><ul>${rows}</ul>`;

test('unknowable scope is disclosed, and stays distinct from checked-clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-unchecked-'));
  writeFileSync(join(dir, 'a.html'), PAGE);

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const ov = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const delivered = new Set(
      [...JSON.stringify(ov).matchAll(/n_[0-9a-f]{12,40}/g)].map((m) => m[0]),
    );

    const list = [...(session as any).graph.collections].sort(
      (a: any, b: any) => b.itemRefs.length - a.itemRefs.length,
    )[0];
    const cited = list.itemRefs.find((r: string) => delivered.has(r));
    assert.ok(cited, 'precondition: the overview delivered an item of the list');
    const finish = { verb: 'finish' as const, answer: 'row 1', evidenceRefs: [cited] };

    // Checked and partial: the graph is compiled, so `scope` speaks.
    const before = (await session.dispatch(finish)) as Record<string, any>;
    assert.equal(before['accepted'], true, JSON.stringify(before));
    assert.ok(Array.isArray(before['scope']), JSON.stringify(before));
    assert.equal(
      before['scopeUnchecked'],
      undefined,
      'a checked finish must not claim it was unchecked',
    );

    // A same-document act nulls the graph; the act must SUCCEED, because a
    // rejected act returns before the null.
    const act = (await session.dispatch({ verb: 'act', ref: cited, action: 'hover' })) as Record<
      string,
      any
    >;
    assert.equal(act['rejected'], undefined, JSON.stringify(act));

    // THE PIN. Same finish, same refs — the check cannot run, and the envelope
    // says so instead of impersonating checked-clean.
    const after = (await session.dispatch(finish)) as Record<string, any>;
    assert.equal(after['accepted'], true, JSON.stringify(after));
    assert.equal(
      after['scopeUnchecked'],
      true,
      `no compiled graph at finish time must be DISCLOSED: ${JSON.stringify(after)}`,
    );
    assert.equal(
      after['scope'],
      undefined,
      'and no facts are invented for a graph that does not exist',
    );

    // Checked-clean control: recompile, cite a ref in no partial population.
    const ov2 = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const heading = (ov2['headings'] ?? [])[0]?.ref;
    assert.ok(heading, 'precondition: the overview delivered a heading ref');
    const clean = (await session.dispatch({
      verb: 'finish',
      answer: 'Host',
      evidenceRefs: [heading],
    })) as Record<string, any>;
    assert.equal(clean['accepted'], true, JSON.stringify(clean));
    assert.equal(
      clean['scopeUnchecked'],
      undefined,
      'checked-clean stays silent — the flag marks unknowable, never clean',
    );
    assert.equal(clean['scope'], undefined, JSON.stringify(clean));
  } finally {
    await session.close();
  }
});
