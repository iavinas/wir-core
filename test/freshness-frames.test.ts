// `freshness: "live"` was vouched by a mutation token read from the MAIN FRAME
// alone, over a graph that folds in EVERY same-process document.
//
// So an iframe that loaded or mutated after a compile moved no counter in the
// parent, changed no epoch (the epoch is the main frame's loaderId, and
// Page.frameNavigated is filtered on !parentId), and the stale graph was
// re-served stamped `live`. That is verbatim the defect core/session.ts records
// this whole mechanism as having been built to kill — "a page that grew 20 -> 40
// links without a navigation and without an act was re-served at 20 and stamped
// live — the runtime saw it and did not show it" — returning through the frame
// door. Zero-tolerance recall class.
//
// Git history shows how it got in: the vouch was built against the main document
// on 2026-08-05, and the graph was widened to every document one day later
// without the vouch being revisited.
//
// FIXTURE JUSTIFIED: the condition is a same-process child document that mutates
// with no parent mutation, no act and no navigation. It cannot be produced on a
// real site on demand, and the recorded corpus has no instance.
//
// NOT COVERED HERE, deliberately: the out-of-process branch. Chromium will not
// site-isolate two localhost ports, the same limitation test/gaps.test.ts already
// records, so a frame that contributes NOTHING to the graph — and therefore must
// not poison the vouch — cannot be built offline. Stating that is better than a
// fixture that pretends to cover it.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

test('an iframe that grows on its own is not re-served as live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-frames-'));
  // The child adds a link 400ms after load — no parent mutation, no act, no
  // navigation. Nothing the old vouch could see.
  writeFileSync(join(dir, 'child.html'), `<!doctype html><title>child</title>
    <a href="/one">frame link one</a>
    <script>
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = '/two'; a.textContent = 'frame link two';
        document.body.appendChild(a);
      }, 400);
    </script>`);
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>host</title><h1>Host</h1>
    <iframe src="file://${dir}/child.html" width="400" height="200"></iframe>`);

  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    // First read: the child has one link. Confirm the frame is genuinely in the
    // graph, or this test would pass for the wrong reason on a page whose frame
    // never compiled.
    const first = await session.dispatch({ verb: 'find', name: 'frame link' });
    assert.equal((first['matches'] as unknown[]).length, 1,
      `the frame's content must be compiled: ${JSON.stringify(first)}`);

    // Let the child mutate itself, then read again with no act between.
    await session.host.page.waitForTimeout(1200);
    const second = await session.dispatch({ verb: 'find', name: 'frame link' });

    // The recall claim, stated positively. Asserting only `freshness` would pass
    // on a runtime that recompiled and still lost the node.
    assert.equal((second['matches'] as unknown[]).length, 2,
      `the frame's new link must be visible: ${JSON.stringify(second)}`);
    assert.equal(second['freshness'], 'recompiled',
      `a mutated frame must not be vouched as live: ${JSON.stringify(second)}`);
  } finally { await session.close(); }
});

test('a still page is still served from cache, so the fix did not disable the vouch', async () => {
  // The other half: if every read recompiled, the assertion above would pass
  // vacuously and the cache would be dead. A frame that does nothing must still
  // let the graph be re-served.
  const dir = mkdtempSync(join(tmpdir(), 'wir-frames-still-'));
  writeFileSync(join(dir, 'child.html'),
    '<!doctype html><title>child</title><a href="/one">frame link one</a>');
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>host</title><h1>Host</h1>
    <iframe src="file://${dir}/child.html" width="400" height="200"></iframe>`);

  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    await session.dispatch({ verb: 'read' });
    await session.host.page.waitForTimeout(300);
    const again = await session.dispatch({ verb: 'read' });
    assert.equal(again['freshness'], 'live',
      `an unchanged page must still be vouched: ${JSON.stringify(again).slice(0, 200)}`);
  } finally { await session.close(); }
});
