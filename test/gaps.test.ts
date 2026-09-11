// Originally the regression for defect C4 (next-level.md §3.1): the only coverage
// gap WIR ever emitted advertised a continuation {"verb":"read","target":"<frame
// URL>"} that always rejected as unknown_ref — a false promise. A gap must name
// what the runtime cannot see and never promise a call it cannot honor.
//
// That fixture no longer produces a gap, and the reason is that the runtime got
// BETTER: the iframe compilation work folds every same-process document into one
// index space, so a same-process frame's content is now compiled and findable.
// `coverageIncomplete: false` on this page is correct — nothing is missing.
//
// The test asserted the old limitation and had been failing ever since, which is
// the worse of the two ways a test can be wrong: a permanently red test guards
// nothing, and this file was the ONLY place asserting gap shape at all. Verified
// 2026-08-07 before rewriting — the frame's own link and text both resolve
// through `find`, so this is a stale assertion and not a lost gap.
//
// So it now pins what is actually true and load-bearing: a same-process frame is
// compiled, reachable, and raises no gap. The gap-shape invariant it used to
// carry is documented as UNCOVERED at the bottom of this file, because the only
// condition that still produces a gap is an out-of-process frame, and Chromium
// will not site-isolate two localhost ports (same site) — reproducing it needs
// distinct sites, which this offline test environment cannot provide.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

test('a same-process frame is compiled, findable, and raises no gap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-gaps-'));
  writeFileSync(join(dir, 'frame.html'),
    '<!doctype html><title>ad</title><p>inside the frame</p><a href="/x">frame link</a>');
  writeFileSync(join(dir, 'a.html'),
    `<!doctype html><title>a</title><h1>Host page</h1><iframe src="file://${dir}/frame.html"></iframe>`);

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

    // No gap, because there is nothing the runtime cannot see. "Complete" is
    // claimed here only because it is literally true — the two finds below are
    // what make that claim checkable rather than asserted.
    assert.equal(overview['coverageIncomplete'], false, JSON.stringify(overview));
    const gaps = overview['gaps'] as unknown[] | undefined;
    assert.ok(gaps === undefined || gaps.length === 0,
      `a fully compiled page must raise no gap: ${JSON.stringify(gaps)}`);

    // The recall claim, stated positively: the frame's content is IN the graph.
    // Asserting only "no gap" would pass just as well if the frame had been
    // silently dropped — which is the defect class this test exists to catch.
    const link = await session.dispatch({ verb: 'find', name: 'frame link' });
    assert.equal((link['matches'] as unknown[]).length, 1,
      `the frame's own link must be reachable: ${JSON.stringify(link)}`);

    const text = await session.dispatch({ verb: 'find', name: 'inside the frame' });
    assert.equal((text['matches'] as unknown[]).length, 1,
      `the frame's own text must be reachable: ${JSON.stringify(text)}`);
  } finally {
    await session.close();
  }
});

// UNCOVERED, deliberately and on the record: the shape a gap must have when one
// IS raised — a reason naming what cannot be seen, and NO continuation, since a
// gap that advertises a call the runtime cannot honor is defect C4 itself. The
// producing condition is an out-of-process frame (`session.ts` reports "frame
// document this session cannot reach (its own process)"), and it cannot be built
// here: Chromium site-isolates by site, and two localhost ports are one site.
//
// Do not restore the old fixture to cover this. It passed by asserting a
// limitation that no longer exists, which is how it came to be red for a week
// while guarding nothing.
