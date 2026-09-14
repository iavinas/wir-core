// Earned by failing tasks 22/24 (shopping-32 analysis, 2026-08-04): the model
// correctly concluded "no such review exists", had no channel to say it,
// improvised ('[]' scored 0; 'None' crashed the official evaluator upstream).
// not_found_error waives the non-empty answer, never the evidence bar.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

test('not_found_error finish: evidence still required, empty answer allowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-nf-'));
  writeFileSync(
    join(dir, 'a.html'),
    '<!doctype html><title>a</title><h1>Reviews</h1><p>Great product, love it.</p>',
  );
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const heading = (overview['headings'] as { ref: string }[] | string[])[0];
    const ref = typeof heading === 'string' ? heading : heading?.ref;
    assert.ok(ref, JSON.stringify(overview).slice(0, 300));

    const bare = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [],
      status: 'not_found_error',
    });
    assert.equal(
      (bare['rejected'] as { kind: string } | undefined)?.kind,
      'finish_rejected',
      `"it isn't there" must still cite where the model looked: ${JSON.stringify(bare)}`,
    );

    const cited = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [ref],
      status: 'not_found_error',
    });
    assert.equal(cited['accepted'], true, JSON.stringify(cited));
    assert.equal(cited['status'], 'not_found_error');
  } finally {
    await session.close();
  }
});

// The same status, structurally unreachable on the other half of the benchmark:
// the MUTATE branch returned before the status was ever read, so a mutation
// episode whose target does not exist had no channel and had to abstain.
// Reproduced on the real site first (debug/runs/probe/2026-08-07T16-26-18-717Z —
// gitlab, expectedAction MUTATE): rejected with "MUTATE finish must cite an act
// with effect verdict verified" and a repair naming acts that cannot exist.
test('MUTATE not_found_error: reachable, evidence-bound, and not a gate bypass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-nfm-'));
  writeFileSync(
    join(dir, 'a.html'),
    '<!doctype html><title>a</title><h1>Members</h1><p>No members yet.</p>',
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
    const overview = await session.dispatch({ verb: 'read' });
    const ref = (overview['headings'] as { ref: string }[])[0]?.ref;
    assert.ok(ref, JSON.stringify(overview).slice(0, 300));

    const bare = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [],
      status: 'not_found_error',
    });
    assert.equal(
      (bare['rejected'] as { kind: string } | undefined)?.kind,
      'finish_rejected',
      `the evidence bar is not waived on MUTATE either: ${JSON.stringify(bare)}`,
    );
    // Every rejection must name a reachable acceptance path (ADR-003). Sending
    // this claim to the act ledger is what the unreachable branch would have done.
    assert.match((bare['rejected'] as { repair: string }).repair, /where you looked/);

    // The MUTATE gate itself is untouched: no cited act and no status, still rejected.
    const noStatus = await session.dispatch({
      verb: 'finish',
      answer: 'done',
      evidenceRefs: [ref],
    });
    assert.equal(
      (noStatus['rejected'] as { kind: string } | undefined)?.kind,
      'finish_rejected',
      `not_found_error must not become a general MUTATE bypass: ${JSON.stringify(noStatus)}`,
    );

    const cited = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [ref],
      status: 'not_found_error',
    });
    assert.equal(cited['accepted'], true, JSON.stringify(cited));
    assert.equal(cited['mode'], 'MUTATE');
    assert.equal(cited['status'], 'not_found_error');
  } finally {
    await session.close();
  }
});
