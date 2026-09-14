// Regression for the "a backdrop whose exit is itself" class of
// blocked_by_overlay: a layer with no words, no control, and its own click
// listener — the light-dismiss backdrop a menu or drawer drops over the page —
// got the same refusal as a modal with no exit: "no control inside the overlay
// carries a dismissal word … Re-reading will NOT help", with no way out in
// the text. The way out is the layer itself: clicking it is how the page
// dismisses it.
//
// Reproduced on the live Magento admin before this was written
// (debug/probe_overlay_backdrop.mjs, 2026-09-03): after the admin menu's
// " CONTENT" link, `div.admin__menu-overlay` — fixed, z-index 697, empty,
// wordless, no animation, no control — covers every control of the product
// form, and stayed for ~30 refused calls in shopping_admin 464 arm 3; arm 4
// escaped only by reading the root's ref and clicking it. After the fix the
// refusal names the layer a backdrop, says which node carries the listener
// (the browser's own table, DOMDebugger.getEventListeners), offers the
// literal click on it, and that click delivers; the previously refused click
// then delivers too. GitLab's keyboard-shortcuts modal confirmed a real modal
// keeps its Close; the same page's load-time mask confirmed a loading
// indicator keeps its wait.
//
// The fixture is the class in miniature, plus the honest edge: a wordless
// fixed backdrop that removes itself on its own click, and — the control — a
// wordless fixed div with NO listener anywhere, which is NOT called a
// backdrop and keeps the no-way-out text exactly.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>backdrop overlay</title>' +
  '<h1>Product</h1>' +
  '<p><a id="behind" href="/x">Show / Hide Editor</a></p>' +
  // The backdrop: fixed, full-viewport, wordless, no control, and its own
  // click listener, which removes it — the menu-overlay shape.
  '<div id="backdrop" hidden style="position:fixed;inset:0;z-index:697;background:rgba(0,0,0,.3)"' +
  ' onclick="this.remove()"></div>' +
  // The control: the same box with no listener on it or on any ancestor.
  '<div id="inert" hidden style="position:fixed;inset:0;z-index:698;background:rgba(0,0,0,.3)"></div>';

test('a covered click under a wordless, control-less layer with its own click listener is offered the click on the layer; a wordless layer with no listener is not called a backdrop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-backdrop-overlay-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const page = session.host.page;
    const clickCall = /(\{"verb":"act","ref":"[^"]+","action":"click"\})/;
    const show = (id: string): Promise<void> =>
      page.evaluate((i) => {
        document.getElementById(i)!.hidden = false;
      }, id);

    // 1. The backdrop: classified, the bearer named, the literal click offered — and it works.
    await show('backdrop');
    const behind = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const ref = behind['matches'][0].ref as string;
    const blocked = (await session.dispatch({ verb: 'act', ref, action: 'click' })) as Record<
      string,
      any
    >;
    assert.equal(blocked['rejected']?.kind, 'blocked_by_overlay');
    assert.match(
      blocked['rejected'].reason,
      /covered by generic (n_[0-9a-f]+) \(position fixed\)/,
      'the layer is in the graph and named by its ref',
    );
    assert.match(
      blocked['rejected'].reason,
      /; the covering layer is a backdrop — it has no words and no rendered control, and the layer itself \(div #backdrop\) carries a click listener$/,
      'the class is stated with the two facts it was decided on, and the node that carries the listener',
    );
    assert.match(
      blocked['rejected'].repair,
      /^this is a backdrop: it has no words, no controls, and its own click listener; clicking it is how the page dismisses it\. \{"verb":"act","ref":"n_[0-9a-f]+","action":"click"\} to dismiss it, then repeat this act\. Re-reading will NOT help: the page has not changed, something is layered over it\.$/,
    );
    const offered = clickCall.exec(blocked['rejected'].repair);
    assert.ok(offered, `a literal click is offered: ${blocked['rejected'].repair}`);
    const call = JSON.parse(offered[1] as string);
    const layerRef = /covered by generic (n_[0-9a-f]+)/.exec(blocked['rejected'].reason)![1];
    assert.equal(call.ref, layerRef, 'the offered click is on the layer itself');
    const dismissed = (await session.dispatch(call)) as Record<string, any>;
    assert.equal(
      dismissed['rejected'],
      undefined,
      `the offered call is accepted: ${JSON.stringify(dismissed['rejected'])}`,
    );
    assert.equal(dismissed['outcome'], 'delivered');
    assert.equal(
      await page.evaluate(() => document.getElementById('backdrop')),
      null,
      'the backdrop dismissed itself on the click',
    );
    const again = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const repeated = (await session.dispatch({
      verb: 'act',
      ref: again['matches'][0].ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(
      repeated['rejected'],
      undefined,
      `the previously refused click delivers: ${JSON.stringify(repeated['rejected'])}`,
    );
    assert.equal(repeated['outcome'], 'delivered');

    // 2. CONTROL: no listener on the layer, the hit, or any ancestor — not a backdrop; the text is unchanged and offers no click.
    await page.goto(`file://${join(dir, 'a.html')}`);
    await show('inert');
    const second = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const inert = (await session.dispatch({
      verb: 'act',
      ref: second['matches'][0].ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(inert['rejected']?.kind, 'blocked_by_overlay');
    assert.doesNotMatch(
      inert['rejected'].reason,
      /backdrop/,
      'a layer nothing listens on is not called a backdrop',
    );
    assert.doesNotMatch(inert['rejected'].reason, /loading indicator/);
    assert.match(
      inert['rejected'].repair,
      /^no control inside the overlay carries a dismissal word \(close\/dismiss\/cancel\/exit\/done\/×\/✕\); it cannot take keyboard focus and act has no document-level key, so no key path is offered(; \{"verb":"read","target":"n_[0-9a-f]+"\} lists what the overlay itself contains)?\. Re-reading will NOT help: the page has not changed, something is layered over it\.$/,
      'the no-way-out text stands, honestly',
    );
    assert.equal(clickCall.exec(inert['rejected'].repair), null, 'no click is offered');
  } finally {
    await session.close();
  }
});
