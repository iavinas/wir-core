// Regression for review finding R1: `computedStyles: ['display','visibility']` was
// requested by the census and never decoded, so compiler.ts admitted on
// layout-presence alone — and `visibility:hidden` OCCUPIES layout. A hidden
// control therefore compiled named+clickable while the browser painted it
// nowhere. Verification of record is the live-site probe: GitLab
// /dashboard/issues carries a 250x34 `gl-visibility-hidden` select2 anchor that
// compiled as {role:link, name:"Search for project", clickable} with the oracle's
// checkVisibility false and the string absent from body innerText
// (debug/runs/probe/2026-08-04T10-15-02-228Z, before). After the fix that page's
// controls went 27 -> 23 across a 7-page sweep with ZERO oracle-visible controls
// lost. This fixture pins the three behaviors so they cannot regress silently —
// above all the per-node rule, which no live page exercised.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

async function startOn(html: string): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-visibility-'));
  writeFileSync(join(dir, 'a.html'), html);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  await session.goto(`file://${dir}/a.html`);
  return session;
}

async function findNames(session: WirSession, name: string): Promise<string[]> {
  const found = await session.dispatch({ verb: 'find', name });
  return (found['matches'] as { name: string }[]).map((m) => m.name);
}

test('visibility:hidden and collapse never compile; a visible descendant survives', async () => {
  // The hidden ancestor keeps a layout box (no display:none anywhere), which is
  // exactly the live select2 shape. The nested button re-declares visibility:
  // visible — the browser paints it, so WIR must keep it. Dropping the subtree
  // would be the zero-tolerance recall class.
  const session = await startOn(`<!doctype html><title>vis</title><h1>Host</h1>
    <button>Plainly Visible Action</button>
    <div style="visibility:hidden">
      <button>Secret Hidden Action</button>
      <a href="/somewhere">Secret Hidden Link</a>
      <button style="visibility:visible">Re-Shown Descendant</button>
    </div>
    <table><tr style="visibility:collapse"><td><button>Collapsed Row Action</button></td></tr></table>`);
  try {
    assert.deepEqual(
      await findNames(session, 'Secret Hidden Action'),
      [],
      'a visibility:hidden control must not compile',
    );
    assert.deepEqual(
      await findNames(session, 'Secret Hidden Link'),
      [],
      'a visibility:hidden link must not compile',
    );
    assert.deepEqual(
      await findNames(session, 'Collapsed Row Action'),
      [],
      'a visibility:collapse subtree must not compile',
    );
    assert.deepEqual(
      await findNames(session, 'Plainly Visible Action'),
      ['Plainly Visible Action'],
      'a visible control must be unaffected',
    );
    // The per-node rule: hidden ancestor, visible child.
    assert.deepEqual(
      await findNames(session, 'Re-Shown Descendant'),
      ['Re-Shown Descendant'],
      'a visible descendant of a hidden ancestor must survive — exclusion is per layout node, never subtree pruning',
    );
  } finally {
    await session.close();
  }
});
