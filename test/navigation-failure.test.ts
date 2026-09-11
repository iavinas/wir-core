// A navigation that fails must be a TYPED REJECTION the model can route around,
// never an episode-fatal exception.
//
// Earned on the live web, 2026-08-11. A live-benchmark smoke run lost a whole
// episode at model call 9: `page.goto` to the task's declared URL threw
// net::ERR_BLOCKED_BY_CLIENT out of host.goto, through session.goto, out of
// dispatch, and the harness recorded `browser_error`. WebArena's fixed localhost
// containers never produced it across ~5,000 recorded calls; three live tasks
// produced it immediately. A blocked or unreachable URL is ordinary on the open
// web, and making it fatal converts a site hiccup into a guaranteed zero.
//
// Two things this pins beyond "does not throw", both of which the probe caught the
// first two drafts of this fix getting WRONG:
//
//   1. THE GRAPH IS DROPPED. host.goto threw before session.goto reached its own
//      graph-drop, so the cached graph survived — and would have been served,
//      still vouched as fresh, for a document the browser had already left.
//   2. THE REPAIR DOES NOT CLAIM WHERE THE BROWSER IS. Draft one said "the page
//      has not moved and your refs are still valid"; the probe showed
//      chrome-error://chromewebdata/. Draft two named `page.url()`; that reports
//      the OLD document, because Chromium commits its error page after the throw.
//      The only honest claim is that the position is unknown and one read settles
//      it.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

test('a failed navigate rejects and the episode survives it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-navfail-'));
  writeFileSync(join(dir, 'a.html'),
    '<!doctype html><title>start</title><h1>Start</h1><p>still reachable</p>');
  const start = `file://${join(dir, 'a.html')}`;
  // Port 1 is on Chromium's unsafe-port list, so this fails deterministically and
  // offline — the same class as ERR_BLOCKED_BY_CLIENT without needing a blocker.
  const dead = 'http://127.0.0.1:1/blocked';

  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    knownUrls: [dead, start],   // runner-declared, so the closure admits both
  });
  try {
    await session.goto(start);
    await session.dispatch({ verb: 'read' });

    // The call that used to end the episode.
    const rejected = await session.dispatch(
      { verb: 'navigate', url: dead }) as Record<string, any>;

    const r = rejected['rejected'];
    assert.ok(r, `a failed navigation must reject, not throw: ${JSON.stringify(rejected)}`);
    assert.equal(r.kind, 'navigation_failed');
    assert.match(r.reason, /did not complete/);
    assert.match(r.reason, /net::ERR_/,
      'the Chromium error code travels, so the model can tell a refusal from a bad name');
    assert.match(r.repair, /"verb":"read"/, 'and the repair is a literal next call');

    // The repair must NOT assert a position the runtime cannot vouch for.
    assert.doesNotMatch(r.repair, /has not moved/,
      'draft one claimed the page stayed put; the probe showed chrome-error://');
    assert.doesNotMatch(r.repair, /file:\/\//,
      'draft two named page.url(), which still reports the OLD document here');

    // THE EPISODE IS ALIVE. This is the whole point.
    const after = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    assert.ok(after['url'] !== undefined, `the session must still answer: ${JSON.stringify(after)}`);
    assert.equal(after['rejected'], undefined, 'and it is not stuck in a rejecting state');
  } finally {
    await session.close();
  }
});
