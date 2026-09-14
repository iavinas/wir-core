// A filled field went blank on the next click, and `fill` had said verified.
//
// insertText fires beforeinput/input/change and NO key event. A whole class of
// widget — bootstrap-datepicker is the one that caught this — parses the field on
// `keyup` into its own state, and rewrites the field FROM that state when focus
// leaves. With no keyup the widget's state stayed empty while the field showed
// the text, so the very next click blanked it. Including the submit click, which
// is why the form could not be completed through the runtime at all.
//
// Proven on browser-use's jQuery form (2026-08-12): after `fill`, value was
// "01/15/1990" and the picker's own `dates` was []; after any later act, "".
//
// The fix synthesises only the TRAILING keyup — the one that ends every human
// keystroke. Never a keydown: a keydown carrying a character would insert it, and
// the text is already in place.
//
// FIXTURE JUSTIFIED: the condition is a widget that trusts keyup and distrusts
// input. Stated directly here, it is two listeners; on the real page it is a
// library bundle.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>keyup widget</title>
<main>
  <label for="f">Date of Birth</label>
  <input id="f" type="text">
  <button id="other">elsewhere</button>
</main>
<script>
  // The widget: it learns the field's value on keyup, and re-asserts its own
  // state whenever focus leaves. Exactly bootstrap-datepicker's shape.
  const el = document.getElementById('f');
  let state = '';
  el.addEventListener('keyup', () => { state = el.value; });
  el.addEventListener('blur', () => { el.value = state; });
</script>`;

test('a filled field survives the blur of the next click', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-keyup-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    const found = await session.dispatch({ verb: 'find', name: 'Date of Birth' });
    const field = ((found['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(field, `precondition: the field is findable: ${JSON.stringify(found)}`);
    const filled = await session.dispatch({
      verb: 'act',
      ref: field.ref,
      action: 'fill',
      value: '01/15/1990',
    });
    assert.ok(!filled['rejected'], JSON.stringify(filled['rejected']));

    // Anything else on the page — here the next control, on the real page the
    // submit button itself.
    const other = await session.dispatch({ verb: 'find', name: 'elsewhere' });
    const btn = ((other['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(btn, 'precondition: the other control is findable');
    await session.dispatch({ verb: 'act', ref: btn.ref, action: 'click' });

    const after = await session.dispatch({ verb: 'read', target: field.ref });
    const node = after['node'] as Record<string, unknown>;
    assert.equal(
      node['value'],
      '01/15/1990',
      'a widget that tracks keystrokes must have seen this fill; otherwise it ' +
        `re-asserts an empty state on blur and verified/value_set was a lie: ${JSON.stringify(after)}`,
    );
  } finally {
    await session.close();
  }
});
