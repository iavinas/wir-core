// Regression: a `key` act must not report `no_observable_change_yet` after it has
// OBSERVED mutation records.
//
// Reproduced on the live storefront first (scratchpad/repro-act-verdict.mjs):
// Magento's mega-menu expands via `key` aimed at the `role=menu` root, and both
// presses returned `verdict: unknown, evidence: no_observable_change_yet` while
// their own delta carried `mutationRecords=321` and `=110`. The graph then grew
// 306 -> 351 nodes and the submenu was findable. A hand driver with unlimited
// calls believed the string, concluded the route was impossible, and filed a
// runtime-gap report that a five-agent probe verification had to overturn
// (debug/NEXT.md, task 261).
//
// What this does NOT do is claim the key CAUSED those records — and the first
// attempt at this fix did, which test/key-action.test.ts immediately caught. That
// fixture churns the DOM on a timer, so mutations accumulate whether the key was
// handled or not; attributing them would need a pre-dispatch baseline the act
// spine does not take, and asserting causation without one is the same over-claim
// the surrounding code already exists to prevent.
//
// Nor does it promote mutations to `verified`. That arm is absent by measurement:
// `type` lost its identical arm after minting a false verified in the field, and
// GitLab's Monaco collected ambient records for a keystroke the editor ignored.
//
// So verdict and evidence both stay exactly as they were. The only change is that
// when records WERE observed, the delta carries the call that settles what moved —
// because the failure mode was a caller acting on the evidence string and never
// reading the count sitting beside it.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Two menus. One mutates the document on any key and changes nothing about
// itself — the exact shape of a mega-menu expanding a sibling subtree. The other
// ignores keys entirely.
const PAGE = [
  '<!doctype html><title>key evidence</title>',
  '<div role="menu" tabindex="0" aria-label="Reactive">reactive</div>',
  '<div role="menu" tabindex="0" aria-label="Inert">inert</div>',
  '<div id="sink"></div>',
  '<script>',
  'document.querySelector(\'[aria-label="Reactive"]\').addEventListener("keydown", function () {',
  '  for (var i = 0; i < 5; i++) {',
  '    var p = document.createElement("p");',
  '    p.textContent = "grown " + i;',
  '    document.getElementById("sink").appendChild(p);',
  '  }',
  '});',
  '</script>',
].join('');

test('a key that mutates the page does not report that nothing was observed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-key-mut-'));
  writeFileSync(join(dir, 'a.html'), PAGE);

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });

    const menus = (await session.dispatch({ verb: 'find', role: 'menu' })) as Record<string, any>;
    const refOf = (name: string) =>
      menus['matches'].find((m: any) => (m.name ?? '').includes(name))?.ref as string;

    // 1. The page mutates; nothing the target owns moves.
    const reactive = (await session.dispatch({
      verb: 'act',
      ref: refOf('Reactive'),
      action: 'key',
      value: 'ArrowDown',
    })) as Record<string, any>;
    const effect = reactive['effect'];
    assert.equal(
      effect.verdict,
      'unknown',
      'mutations alone still never mint verified — that arm was removed by measurement',
    );
    assert.equal(
      effect.evidence,
      'no_observable_change_yet',
      'and the evidence string is unchanged: nothing the target owns moved',
    );
    assert.match(effect.delta.after, /mutationRecords=[1-9]/, 'the observed count is reported');
    assert.match(
      effect.delta.after,
      /"verb":"read"/,
      'and the delta names the call that settles what moved — the piece the ' +
        'caller was missing when it read the string and stopped',
    );
    assert.match(
      effect.delta.after,
      /cannot be attributed/,
      'while explicitly declining to claim the act caused them',
    );

    // 2. THE CONTROL. With no mutation at all there is nothing to point at, so
    //    the delta must stay bare — no continuation offered for a page that did
    //    not move.
    const inert = (await session.dispatch({
      verb: 'act',
      ref: refOf('Inert'),
      action: 'key',
      value: 'ArrowDown',
    })) as Record<string, any>;
    assert.equal(inert['effect'].verdict, 'unknown');
    assert.equal(inert['effect'].evidence, 'no_observable_change_yet');
    assert.doesNotMatch(
      inert['effect'].delta.after,
      /"verb":"read"/,
      'a page that did not move offers no continuation — otherwise the hint is ' +
        'noise on every unhandled key',
    );
  } finally {
    await session.close();
  }
});
