// Regression for defect C1 (next-level.md §3.1): the MUTATE finish gate accepted
// a link-follow as proof of mutation. Tasks 722/725 finished with the gate's
// blessing and zero POSTs in their HARs. A fixture page is justified here: the
// condition needs a real navigation act and the WebArena reddit container was
// down when the fix landed (docs/plans/v1-path-spec.md, house style rule 2).
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

test('MUTATE finish citing only a link-follow act is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-gate-'));
  writeFileSync(join(dir, 'b.html'), '<!doctype html><title>b</title><h1>Page B</h1>');
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>a</title><h1>Page A</h1><a href="file://${dir}/b.html">to page b</a>`,
  );

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    const found = await session.dispatch({ verb: 'find', name: 'to page b' });
    const ref = (found['matches'] as { ref: string }[])[0]?.ref;
    assert.ok(ref, `link not found: ${JSON.stringify(found)}`);

    const acted = await session.dispatch({ verb: 'act', ref, action: 'click' });
    const effect = acted['effect'] as { verdict: string; evidence: string };
    // Precondition, not the assertion under test: the act itself is honestly
    // verified — the browser did land on the declared href.
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'navigated_to_destination');

    const finish = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [acted['actRef'] as string],
    });
    const rejected = finish['rejected'] as { kind: string } | undefined;
    assert.equal(
      rejected?.kind,
      'finish_rejected',
      `a GET the markup declared must not prove a mutation: ${JSON.stringify(finish)}`,
    );
  } finally {
    await session.close();
  }
});
