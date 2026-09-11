// Regressions for two session-layer contract defects found in the post-merge
// review. Both are cases where the session's own bookkeeping disagreed with the
// verb it wraps, so a legal call died before reaching the code that implements it.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

async function startOn(html: string, expectedAction: 'RETRIEVE' | 'MUTATE' = 'RETRIEVE'): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-session-'));
  writeFileSync(join(dir, 'a.html'), html);
  const session = await WirSession.start({
    headless: true, expectedAction, storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  await session.goto(`file://${dir}/a.html`);
  return session;
}

// Review finding: recordObserved matched refs by SHAPE (/^n_[0-9a-f]{12,40}$/),
// and the document root's ref is the synthetic 'n_root' — minted from no
// backendNodeId, matching no digest. A model that read the root and cited it was
// told the ref was "never observed this episode", which was false.
test('a finish citing the document root ref is accepted', async () => {
  const session = await startOn('<!doctype html><title>root</title><h1>Heading</h1><p>Body text</p>');
  try {
    const read = await session.dispatch({ verb: 'read', target: 'n_root' });
    assert.equal((read['node'] as { ref: string }).ref, 'n_root', JSON.stringify(read));

    const finished = await session.dispatch({
      verb: 'finish', answer: 'Heading', evidenceRefs: ['n_root'],
    });
    assert.equal(finished['accepted'], true,
      `the root ref was shown by read and must be citable: ${JSON.stringify(finished)}`);
    // Every verb reply carries the envelope; finish was the one that did not,
    // so the last thing an episode saw named no document at all.
    assert.equal(typeof finished['documentEpoch'], 'string',
      `a finish reply carries documentEpoch like every other verb: ${JSON.stringify(finished)}`);
    assert.equal(finished['freshness'], 'dirty');
  } finally { await session.close(); }
});

// Review finding: the session duplicated find's argument guard and was STRICTER —
// it required role or name, while find.ts implements role, name OR state. A
// state-only query is legal and must reach the verb, whose typed empty result
// carries the filters and the fallback.
test('a state-only find reaches the verb instead of being rejected', async () => {
  const session = await startOn(`<!doctype html><title>state</title>
    <button aria-expanded="true">Open menu</button>
    <button aria-expanded="false">Closed menu</button>`);
  try {
    const found = await session.dispatch({ verb: 'find', state: 'expanded' });
    assert.ok(!('rejected' in found), `state-only find must not be rejected: ${JSON.stringify(found)}`);
    const names = (found['matches'] as { name: string }[]).map(m => m.name);
    assert.deepEqual(names, ['Open menu'],
      `state filters on the state being TRUE: ${JSON.stringify(found)}`);
  } finally { await session.close(); }
});
