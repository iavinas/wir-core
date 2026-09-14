// When `key` refuses a node that cannot take focus, the repair names the
// ancestor that can — as a literal, consumable call.
//
// PROVEN DEFECT, on a real third-party page. Text and focusability routinely
// live on different elements: a `<div tabindex="0">` wrapping a `<p>` that
// carries the words. `find` matches on the page's OWN words, so it returns the
// paragraph — and `key` refuses it, correctly, because a press there would go to
// whatever is focused instead. Measured on the browser-use stress test's
// arrow-key task, which is exactly that shape: three presses in a row were
// rejected and the task scored nothing.
//
// The old repair — "act click the control you want to press the key on first" —
// was true and useless: clicking the paragraph focuses nothing either. The
// runtime already holds the answer; this hands it over.
//
// DISCLOSURE, NOT MATCHING. No similarity, no ranking, no guessing at intent:
// the DOM ancestor chain and the browser's own focusability rule (natively
// focusable tag, tabindex other than -1, or contenteditable). And the ref comes
// from the GRAPH'S OWN byBackendId map — the executor never mints one, because
// identity has a single minting site and a second would be a second identity.
//
// THE CONTROL IS THE SECOND TEST: a node with NO focusable ancestor must say so
// rather than invent a target. Verified live on the same page — the task's
// section title matched the same search and correctly reported no ancestor.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>focus</title><h1>Focus</h1>' +
  // The shape that breaks: words on the child, tabindex on the parent. The
  // container needs enough structure to be COMPILED — a ref only exists for a
  // node the compiler kept, and the repair correctly stays silent otherwise.
  // This mirrors the real page: a focusable wrapper with a prompt and a display.
  // role="group" keeps the container in the AX tree WITHOUT giving it a name —
  // a bare <div tabindex=0> is collapsed by Chrome in a page this small, and an
  // uncompiled ancestor has no ref by design. Nameless is the point: if the
  // container had a name, `find` would return it directly and there would be no
  // defect to reproduce.
  '<div id="area" role="group" tabindex="0">' +
  '<p>press the arrow key here</p><div id="disp">nothing yet</div></div>' +
  // and a paragraph with no focusable ancestor at all
  '<p>orphan text with nowhere to focus</p>' +
  '<script>' +
  'window.keys = [];' +
  'document.getElementById("area").addEventListener("keydown", e => window.keys.push(e.key));' +
  '</script>';

async function withPage(fn: (s: WirSession) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-focus-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });
    await fn(session);
  } finally {
    await session.close();
  }
}

const findRef = async (s: WirSession, name: string): Promise<string> => {
  const r = (await s.dispatch({ verb: 'find', name })) as Record<string, any>;
  const m = (r['matches'] ?? [])[0];
  assert.ok(m, `precondition: ${name} findable: ${JSON.stringify(r['matches'])}`);
  return m.ref;
};

test('a key on a node that cannot focus is delivered to the ancestor that can', async () => {
  // Text and focusability routinely live on different elements — a
  // <div tabindex="0"> around the <p> that carries the words — and `find`
  // matches the page's OWN words, so it returns the paragraph.
  //
  // Clicking that paragraph focuses the DIV; typing then goes to the DIV. So
  // delivering the press to the nearest focusable ancestor is not a guess about
  // intent, it is what the browser does with a human's press. Rejecting instead
  // cost two round trips for what the browser does natively — measured on the
  // browser-use stress test, three ArrowRight presses rejected in a row while
  // the rejection already held the right target.
  //
  // NEVER SILENT: the delta names both ends. A substitution the caller cannot
  // see is the over-claim this spine exists to prevent.
  await withPage(async (s) => {
    const ref = await findRef(s, 'press the arrow key');
    const r = (await s.dispatch({
      verb: 'act',
      ref,
      action: 'key',
      value: 'ArrowRight',
    })) as Record<string, any>;
    assert.equal(
      r['rejected'],
      undefined,
      `it is delivered, not refused: ${JSON.stringify(r['rejected'])}`,
    );
    // The verdict may honestly be `unknown`: the press landed on the container
    // and nothing the TARGET owns moved. What must never happen is a silent
    // substitution, so the delta is what this pins.

    const after = String(r['effect']?.delta?.after ?? '');
    assert.match(
      after,
      /cannot take focus/,
      `the delta says the target could not take it: ${after}`,
    );
    assert.match(after, /nearest focusable ancestor/, `and names where it went instead: ${after}`);
    assert.ok(after.includes(ref), 'naming the ref that was asked for');

    // The ORACLE: the key actually landed on the focusable container.
    const keys = await s.host.page.evaluate(() => (window as any).keys as string[]);
    assert.deepEqual(keys, ['ArrowRight'], 'and the element that listens actually received it');
  });
});

test('CONTROL — a node with no focusable ancestor says so, inventing nothing', async () => {
  await withPage(async (s) => {
    const ref = await findRef(s, 'orphan text');
    const r = (await s.dispatch({
      verb: 'act',
      ref,
      action: 'key',
      value: 'ArrowRight',
    })) as Record<string, any>;
    assert.equal(r['rejected']?.kind, 'invalid_args');
    const repair = String(r['rejected']?.repair ?? '');
    assert.match(
      repair,
      /no ancestor/,
      `it states the absence rather than naming a target: ${repair}`,
    );
    assert.doesNotMatch(repair, /"verb":"act"/, 'and offers no act call it cannot honour');
  });
});
