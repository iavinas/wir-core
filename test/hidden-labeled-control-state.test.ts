// Styled form controls commonly hide the native checkbox/radio and make its
// <label> the only rendered target. DOMSnapshot still carries the hidden
// control's exact value and checked bit, but the rendered-only compiler used to
// discard both and emit several identical LabelText nodes. A caller could click
// the widget and could not read its current state.
//
// The fix follows HTML's labeled-control association. The visible label remains
// the act target, while its projection carries the hidden control's role, value,
// checked state, and page-authored id. Both explicit `for` and wrapping labels
// are covered; visible controls must not be duplicated through their labels.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>styled state</title>
<style>.hidden-control { display: none }</style>
<main>
  <fieldset><legend>Rating</legend>
    <input class="hidden-control" type="radio" name="rating" id="Rating_5" value="20">
    <label for="Rating_5">★</label>
    <input class="hidden-control" type="radio" name="rating" id="Rating_4" value="19">
    <label for="Rating_4">★</label>
    <input class="hidden-control" type="radio" name="rating" id="Rating_3" value="18" checked>
    <label for="Rating_3">★</label>
    <input class="hidden-control" type="radio" name="rating" id="Rating_2" value="17">
    <label for="Rating_2">★</label>
    <input class="hidden-control" type="radio" name="rating" id="Rating_1" value="16">
    <label for="Rating_1">★</label>
  </fieldset>
  <label>Wrapped<input class="hidden-control" type="checkbox" id="wrapped" checked></label>
  <input type="radio" id="visible" name="visible"><label for="visible">Visible</label>
</main>`;

test('visible labels preserve the state of hidden checkbox/radio controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-hidden-control-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const found = await session.dispatch({ verb: 'find', role: 'radio', limit: 20 });
    const radios = (found['matches'] ?? []) as Record<string, unknown>[];

    // Five label-backed hidden radios plus the one ordinary visible radio. The
    // visible radio's label is not projected as a second control.
    assert.equal(radios.length, 6, JSON.stringify(found));
    const styled = radios.filter((r) => String(r['controlId'] ?? '').startsWith('Rating_'));
    assert.equal(styled.length, 5, JSON.stringify(found));
    assert.deepEqual(
      styled.map((r) => r['controlId']),
      ['Rating_5', 'Rating_4', 'Rating_3', 'Rating_2', 'Rating_1'],
    );
    assert.deepEqual(
      styled.map((r) => r['value']),
      ['20', '19', '18', '17', '16'],
    );
    assert.deepEqual(
      styled
        .filter((r) => (r['state'] as Record<string, unknown> | undefined)?.['checked'])
        .map((r) => r['controlId']),
      ['Rating_3'],
    );

    const boxes = await session.dispatch({ verb: 'find', role: 'checkbox', limit: 20 });
    const wrapped = ((boxes['matches'] ?? []) as Record<string, unknown>[]).find(
      (r) => r['controlId'] === 'wrapped',
    );
    assert.ok(wrapped, JSON.stringify(boxes));
    assert.equal((wrapped['state'] as Record<string, unknown>)['checked'], true);
  } finally {
    await session.close();
  }
});
