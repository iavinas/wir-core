// Regression for the "told to give up on a layer that leaves by itself" class
// of blocked_by_overlay: a loading indicator covering the target got the same
// refusal as a modal with no exit — "no control inside the overlay carries a
// dismissal word … Re-reading will NOT help: the page has not changed" — and
// for this class that is backwards: the page is about to change on its own,
// and the right move is to wait, which `until` already provides.
//
// Reproduced on the live Magento admin before this was written
// (debug/probe_overlay_wait.mjs, 2026-09-03): the product page's
// `.admin__form-loading-mask` — fixed, wordless, dismiss-less, eight <span>s
// with animation-name "fade" — covers every control for the first seconds
// after load. After the fix the refusal names it a loading indicator, states
// the rule that decided that (animated-only), offers the literal act with
// `until:{network:"idle"}`, and that call, dispatched while the mask is still
// up, waits for it to leave and then delivers. GitLab's keyboard-shortcuts
// modal confirmed that a real modal keeps its dismiss list.
//
// The fixture is the class in miniature, one overlay per rule that is pinned:
// an `<img alt="Loading…">` mask (the words rule; `gone` is offered because
// the graph holds the image's name), the Magento spinner shape (the
// animated-only rule; `network:"idle"` is offered because there is no word to
// watch), and — the control — a layer that carries a loading word but ALSO a
// Close button, which keeps the dismiss text exactly: a layer with an exit is
// never waited on. Each transient mask removes itself 700 ms after the wait
// call is dispatched, so the pre-dispatch wait is exercised, not skipped.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const PAGE =
  '<!doctype html><title>transient overlay</title>' +
  '<style>@keyframes fade{from{opacity:1}to{opacity:.2}}' +
  '.spinner span{display:inline-block;width:8px;height:8px;margin:2px;background:#333;animation:fade 1s infinite}</style>' +
  '<h1>Product</h1>' +
  '<p><a id="behind" href="/x">Show / Hide Editor</a></p>' +
  // The words rule: an image whose alt is a loading word, nothing else.
  '<div id="imgmask" hidden style="position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,.5)">' +
  `<img alt="Loading…" src="${GIF}" width="40" height="40"></div>` +
  // The Magento shape: no words, no image, only animated spans in a wrapper.
  '<div id="spinmask" hidden style="position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,.5)">' +
  '<div class="spinner"><span></span><span></span><span></span></div></div>' +
  // The control: a loading word AND an exit — the exit wins.
  '<div id="closable" hidden style="position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,.5)">' +
  '<p>Loading your workspace</p><button id="close" onclick="document.getElementById(\'closable\').remove()">Close</button></div>';

test('a covered click under a loading indicator is offered the literal act-with-until, and that call waits for the indicator to leave; a layer with an exit keeps the exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-transient-overlay-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const page = session.host.page;
    const waitCall = /(\{"verb":"act","ref":"[^"]+","action":"click","until":\{[^}]*\}\})/;
    const show = (id: string): Promise<void> =>
      page.evaluate((i) => {
        document.getElementById(i)!.hidden = false;
      }, id);
    const removeIn = (id: string, ms: number): Promise<void> =>
      page.evaluate(
        ([i, t]) => {
          setTimeout(() => document.getElementById(i as string)!.remove(), t as number);
        },
        [id, ms],
      );
    const behind = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const ref = behind['matches'][0].ref as string;

    // 1. The words rule: `<img alt="Loading…">` — gone is offered, on the image's own words.
    await show('imgmask');
    const words = (await session.dispatch({ verb: 'act', ref, action: 'click' })) as Record<
      string,
      any
    >;
    assert.equal(words['rejected']?.kind, 'blocked_by_overlay');
    assert.match(
      words['rejected'].reason,
      /covered by div #imgmask \(position fixed/,
      'the layer is still named',
    );
    assert.match(
      words['rejected'].reason,
      /the covering layer is a loading indicator — words: <img alt> "Loading…" contains "loading"/,
      'the rule that fired is stated, in the words it was decided on',
    );
    assert.match(
      words['rejected'].repair,
      /^this overlay is a loading indicator; the page will change on its own: repeat the act with until, or read after it settles\. /,
    );
    assert.doesNotMatch(
      words['rejected'].repair,
      /Re-reading will NOT help/,
      'the sentence that was wrong for this class is gone',
    );
    const offered = waitCall.exec(words['rejected'].repair);
    assert.ok(offered, `a literal act-with-until is offered: ${words['rejected'].repair}`);
    const call = JSON.parse(offered[1] as string);
    assert.deepEqual(
      call,
      { verb: 'act', ref, action: 'click', until: { gone: 'Loading…' } },
      "the offered call is this act, with until.gone on the indicator's own words",
    );
    // Dispatched while the mask is still up: the act waits for it, then clicks.
    await removeIn('imgmask', 700);
    const waited = (await session.dispatch(JSON.parse(offered[1] as string))) as Record<
      string,
      any
    >;
    assert.equal(
      waited['rejected'],
      undefined,
      `the offered call is accepted: ${JSON.stringify(waited['rejected'])}`,
    );
    assert.equal(waited['outcome'], 'delivered');
    assert.equal(
      waited['effect'].until?.verdict,
      'condition_met',
      JSON.stringify(waited['effect'].until),
    );
    assert.match(
      waited['effect'].until.observed,
      /^the covering loading indicator left the target after \d+ ms of waiting before dispatch; no rendered node carries "Loading…"/,
      'the pre-dispatch wait is on record where until reports what it saw',
    );

    // 2. The Magento shape: wordless, animated-only — network:"idle" is offered.
    await page.goto(`file://${join(dir, 'a.html')}`);
    await show('spinmask');
    const again = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const ref2 = again['matches'][0].ref as string;
    const spin = (await session.dispatch({ verb: 'act', ref: ref2, action: 'click' })) as Record<
      string,
      any
    >;
    assert.equal(spin['rejected']?.kind, 'blocked_by_overlay');
    assert.match(
      spin['rejected'].reason,
      /the covering layer is a loading indicator — animated-only: it has no words and its only content is 3 animated elements \(animation-name "fade"\)/,
    );
    const offered2 = waitCall.exec(spin['rejected'].repair);
    assert.ok(offered2);
    const call2 = JSON.parse(offered2[1] as string);
    assert.deepEqual(
      call2,
      { verb: 'act', ref: ref2, action: 'click', until: { network: 'idle' } },
      'with no word to watch leave, the wait is on the wire',
    );
    await removeIn('spinmask', 700);
    const waited2 = (await session.dispatch(JSON.parse(offered2[1] as string))) as Record<
      string,
      any
    >;
    assert.equal(waited2['rejected'], undefined, JSON.stringify(waited2['rejected']));
    assert.equal(
      waited2['effect'].until?.verdict,
      'condition_met',
      JSON.stringify(waited2['effect'].until),
    );
    assert.match(
      waited2['effect'].until.observed,
      /^the covering loading indicator left the target after \d+ ms of waiting before dispatch; /,
    );

    // 3. CONTROL: a loading word beside a Close button — the exit is listed, the text is unchanged.
    await page.goto(`file://${join(dir, 'a.html')}`);
    await show('closable');
    const third = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const closable = (await session.dispatch({
      verb: 'act',
      ref: third['matches'][0].ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(closable['rejected']?.kind, 'blocked_by_overlay');
    assert.doesNotMatch(
      closable['rejected'].reason,
      /loading indicator/,
      'a layer with its own exit is not called transient',
    );
    assert.match(
      closable['rejected'].repair,
      /^the overlay's own controls whose words contain one of close\/dismiss\/cancel\/exit\/done\/×\/✕: \[\{"ref":"[^"]+","role":"button","name":"Close"\}\]\. \{"verb":"act","ref":"[^"]+","action":"click"\} to dismiss it, then repeat this act\. Re-reading will NOT help: the page has not changed, something is layered over it\.$/,
    );
    assert.doesNotMatch(closable['rejected'].repair, /"until"/, 'no wait is offered for it');

    // 4. CONTROL: with no layer, an uncovered click is simply delivered.
    await page.goto(`file://${join(dir, 'a.html')}`);
    const free = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const ok = (await session.dispatch({
      verb: 'act',
      ref: free['matches'][0].ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(ok['rejected'], undefined, JSON.stringify(ok['rejected']));
  } finally {
    await session.close();
  }
});
