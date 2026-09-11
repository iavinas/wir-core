// Earned by measurement, not taste. The official evaluator keeps exactly ONE
// event for a NAVIGATE task with an expected GET — the last document navigation
// of the episode (webarena_verified .../network_event_evaluator.py:577-582) —
// so arriving at the target page and then leaving scores zero. Swept over every
// attempt directory on this box: of 50 NAVIGATE failures with an expected GET,
// 19 reached the target and then navigated away, several by a single navigation
// after the answer was already in hand (shopping-301 did it in four arms).
//
// The gate check is mechanical and stays inside ADR-003: it compares the epoch a
// ref was minted under against the epoch the browser is in now. No page text is
// read, no answer is judged, and the task's target URL never enters core.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wir-navstand-'));
  writeFileSync(join(dir, 'a.html'),
    '<!doctype html><title>a</title><h1>Order history</h1>' +
    '<p>Your past orders.</p><a href="b.html">Order 000000180</a>');
  writeFileSync(join(dir, 'b.html'),
    '<!doctype html><title>b</title><h1>Order 000000180</h1><p>Status: Pending.</p>');
  return dir;
}

async function firstHeadingRef(session: WirSession): Promise<string> {
  const overview = await session.dispatch({ verb: 'read' });
  const h = (overview['headings'] as { ref: string }[] | string[])[0];
  const ref = typeof h === 'string' ? h : h?.ref;
  assert.ok(ref, JSON.stringify(overview).slice(0, 300));
  return ref as string;
}

test('NAVIGATE finish is refused when every cited ref is from a document left behind', async () => {
  const dir = fixture();
  const session = await WirSession.start({
    headless: true, expectedAction: 'NAVIGATE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    await firstHeadingRef(session);

    // Reach the target and read it — the answer is now genuinely in hand...
    await session.goto(`file://${dir}/b.html`);
    const refOnB = await firstHeadingRef(session);

    // ...then walk away from it. This is the exact shape of the 19: the work was
    // right, and the last navigation threw it away.
    await session.goto(`file://${dir}/a.html`);

    const stale = await session.dispatch({
      verb: 'finish', answer: 'order 000000180', evidenceRefs: [refOnB], status: 'success',
    });
    const rejected = stale['rejected'] as { kind: string; repair?: string } | undefined;
    assert.equal(rejected?.kind, 'finish_rejected',
      `a finish whose evidence predates the current document must not pass: ${JSON.stringify(stale).slice(0, 400)}`);
    assert.match(String(rejected?.repair ?? JSON.stringify(stale)), /standing on/i,
      'the rejection has to say what to do about it, not just refuse');
  } finally {
    await session.close();
  }
});

test('NAVIGATE finish is accepted while standing on the page it cites', async () => {
  const dir = fixture();
  const session = await WirSession.start({
    headless: true, expectedAction: 'NAVIGATE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    await firstHeadingRef(session);
    await session.goto(`file://${dir}/b.html`);
    const refOnB = await firstHeadingRef(session);

    const ok = await session.dispatch({
      verb: 'finish', answer: 'order 000000180', evidenceRefs: [refOnB], status: 'success',
    });
    assert.equal(ok['accepted'], true,
      `evidence from the current document must still pass: ${JSON.stringify(ok).slice(0, 400)}`);
    assert.equal(ok['mode'], 'NAVIGATE');
  } finally {
    await session.close();
  }
});

// The control that keeps this from becoming a blanket rule. RETRIEVE legitimately
// answers about pages it has left — that is what reading four pages of a list and
// answering from all of them looks like — so the same citation must pass there.
test('RETRIEVE is untouched: evidence from a document left behind still passes', async () => {
  const dir = fixture();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const refOnA = await firstHeadingRef(session);
    await session.goto(`file://${dir}/b.html`);
    await session.dispatch({ verb: 'read' });

    const ok = await session.dispatch({
      verb: 'finish', answer: 'Order history', evidenceRefs: [refOnA], status: 'success',
    });
    assert.equal(ok['accepted'], true,
      `RETRIEVE must keep citing pages it has left: ${JSON.stringify(ok).slice(0, 400)}`);
  } finally {
    await session.close();
  }
});

// Every observation carries where the browser is standing. Until this landed the
// URL reached the model only in the overview read's payload, so a targeted read,
// any find, and most acts said nothing about location — and an episode could
// spend its last several observations with no idea what page it was on.
test('every envelope carries the current url', async () => {
  const dir = fixture();
  const session = await WirSession.start({
    headless: true, expectedAction: 'NAVIGATE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/b.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const found = await session.dispatch({ verb: 'find', name: 'Order' });
    for (const [label, res] of [['read', overview], ['find', found]] as const) {
      assert.match(String(res['url'] ?? ''), /b\.html$/,
        `${label} must say where the browser is: ${JSON.stringify(res).slice(0, 300)}`);
    }
  } finally {
    await session.close();
  }
});

// shopping-301: the correct answer IS not_found_error ("no order is Processing")
// AND the grader requires the browser parked on the bare order-history URL. The
// observation-bar branch returns first and is mode-independent, so a NAVIGATE
// finish carrying that status short-circuited past the standing check entirely —
// the fix could not reach the task it was built from. Pinned here.
test('NAVIGATE standing is checked even when the status is not_found_error', async () => {
  const dir = fixture();
  const session = await WirSession.start({
    headless: true, expectedAction: 'NAVIGATE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    await firstHeadingRef(session);
    await session.goto(`file://${dir}/b.html`);
    const refOnB = await firstHeadingRef(session);
    await session.goto(`file://${dir}/a.html`);

    const left = await session.dispatch({
      verb: 'finish', answer: '', evidenceRefs: [refOnB], status: 'not_found_error',
    });
    assert.equal((left['rejected'] as { kind: string } | undefined)?.kind, 'finish_rejected',
      `not_found_error must not smuggle a NAVIGATE finish past the standing check: ${JSON.stringify(left).slice(0, 400)}`);
  } finally {
    await session.close();
  }
});

// The control: RETRIEVE keeps its not_found_error path untouched.
test('RETRIEVE not_found_error is unaffected by the standing check', async () => {
  const dir = fixture();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const refOnA = await firstHeadingRef(session);
    await session.goto(`file://${dir}/b.html`);
    await session.dispatch({ verb: 'read' });
    const ok = await session.dispatch({
      verb: 'finish', answer: '', evidenceRefs: [refOnA], status: 'not_found_error',
    });
    assert.equal(ok['accepted'], true, JSON.stringify(ok).slice(0, 300));
  } finally {
    await session.close();
  }
});
