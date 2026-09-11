// `fill` on a value-sanitized input reported verified and then emptied itself.
//
// setStructuredValue wrote `this.value = v`. React makes a controlled input's
// value an INSTANCE property backed by a tracker holding the last value it knows
// about, so that assignment updates the tracker in the same breath: when the
// `input` event arrives React compares the two, sees no change, and never calls
// onChange. Its state keeps the old value, and the next render writes that back
// over the DOM.
//
// The damage is not a failed fill, it is a LYING one. The readback taken right
// after the write sees the new value, so `act` answers verified/value_set and the
// model is told the field is filled — it empties milliseconds later, when
// anything else on the form re-renders. "Delivery is not success" is the whole
// point of the act spine, and this was delivery reported as proof.
//
// Proven on browser-use's React form (2026-08-12): the date field read "" behind
// a red "Date of Birth is required" while the trajectory said verified/value_set.
// The prototype setter writes past the instance property, the tracker reads
// stale, React sees a real change, and its state actually updates.
//
// FIXTURE JUSTIFIED: the condition is the tracker pattern itself. This models it
// with the same mechanism React uses — an instance-level value property over the
// prototype's native setter — so the test needs no framework bundle and states
// the defect exactly.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>controlled</title>
<main>
  <label for="d">Date of Birth</label>
  <input id="d" type="date">
  <button id="rerender">re-render</button>
  <p id="state">state=</p>
</main>
<script>
  // React's mechanism, minimally: the tracker, the change comparison, and a
  // render that writes framework state back over the DOM.
  const el = document.getElementById('d');
  const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  let tracked = '';
  let state = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return native.get.call(this); },
    set(v) { tracked = v; native.set.call(this, v); },
  });
  el.addEventListener('input', () => {
    const current = native.get.call(el);
    if (current === tracked) return;       // no change as far as the framework knows
    tracked = current;
    state = current;
    document.getElementById('state').textContent = 'state=' + state;
  });
  document.getElementById('rerender').addEventListener('click', () => {
    native.set.call(el, state);            // a controlled input re-asserting state
    document.getElementById('state').textContent = 'state=' + state;
  });
</script>`;

test('a filled controlled input still holds its value after the form re-renders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-controlled-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    const found = await session.dispatch({ verb: 'find', name: 'Date of Birth' });
    const field = ((found['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(field, `precondition: the date field is findable: ${JSON.stringify(found)}`);

    const filled = await session.dispatch({
      verb: 'act', ref: field.ref, action: 'fill', value: '1990-01-15' });
    assert.ok(!filled['rejected'], JSON.stringify(filled['rejected']));

    // The render that used to wipe it. If the framework never saw the change,
    // its state is still empty and this write-back empties the field.
    const button = await session.dispatch({ verb: 'find', name: 're-render' });
    const btn = ((button['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(btn, `precondition: the re-render control is findable: ${JSON.stringify(button)}`);
    await session.dispatch({ verb: 'act', ref: btn.ref, action: 'click' });

    const after = await session.dispatch({ verb: 'read', target: field.ref });
    const node = after['node'] as Record<string, unknown>;
    assert.equal(node['value'], '1990-01-15',
      `verified/value_set must still be true after a re-render — a fill that ` +
      `empties itself is a false verified: ${JSON.stringify(after)}`);
  } finally { await session.close(); }
});
