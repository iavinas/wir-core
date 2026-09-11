// Compile time and act time computed "is this disabled?" two different ways,
// and act's was the stricter one.
//
// The compiler read the `disabled` ATTRIBUTE only. `act` reads the browser's
// own AX `disabled` property and REFUSES the target outright. Those disagree on
// two shapes the platform treats as disabled: `aria-disabled="true"`, and any
// control inside a `<fieldset disabled>`. On both, `read` showed a live control
// and `act` answered "target is disabled" — a wall the model could not have
// seen from any amount of reading.
//
// This is the same class as every other fix in this stream: not a wrong answer,
// a confident one the runtime's own other half contradicts.
//
// FIXTURE JUSTIFIED: needs the three disablement routes side by side with an
// enabled control, so agreement is decidable rather than incidental. Real pages
// carry them one at a time and never all four.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// The anchor is the case that made the FIRST version of this fix wrong in the
// other direction. `disabled` is not a valid attribute on `<a>`, so the browser
// ignores it and the control is live — but React renders `<a disabled={true}>`
// as exactly this, and hand-written menus carry it. Reading the ATTRIBUTE
// marked it dead while `act` clicked it happily. Only the browser's own AX
// `disabled` property is consulted now, which is also what `act` reads.
const PAGE = `<!doctype html><title>disabled</title>
<main>
  <button id="a">plain enabled</button>
  <button id="b" disabled>attribute disabled</button>
  <button id="c" aria-disabled="true">aria disabled</button>
  <fieldset disabled><button id="d">fieldset disabled</button></fieldset>
  <a href="#x" disabled>anchor with disabled attribute</a>
</main>`;

async function stateOf(session: WirSession, name: string):
Promise<{ ref: string; state: Record<string, unknown> }> {
  const found = await session.dispatch({ verb: 'find', name });
  const m = ((found['matches'] ?? []) as
    { ref: string; state?: Record<string, unknown> }[])[0];
  assert.ok(m, `${JSON.stringify(name)} not found: ${JSON.stringify(found)}`);
  return { ref: m.ref, state: m.state ?? {} };
}

test('every route to disabled is visible before acting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-disabled-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    for (const name of ['attribute disabled', 'aria disabled', 'fieldset disabled']) {
      const { state } = await stateOf(session, name);
      assert.equal(state['disabled'], true,
        `"${name}" must be shown as disabled before act refuses it: ${JSON.stringify(state)}`);
    }

    // And the enabled ones are untouched — a fix that marks everything disabled
    // would pass every assertion above.
    for (const name of ['plain enabled', 'anchor with disabled attribute']) {
      const live = await stateOf(session, name);
      assert.ok(!('disabled' in live.state),
        `"${name}" is live and must not be marked disabled: ${JSON.stringify(live.state)}`);
    }
  } finally { await session.close(); }
});

test('what read shows and what act refuses are the same set', async () => {
  // The claim stated as agreement rather than as a field value: for each
  // control, does `act` reject exactly when `read` said it would?
  const dir = mkdtempSync(join(tmpdir(), 'wir-disabled-act-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    for (const name of ['plain enabled', 'attribute disabled', 'aria disabled',
      'fieldset disabled', 'anchor with disabled attribute']) {
      const { ref, state } = await stateOf(session, name);
      const said = state['disabled'] === true;
      const acted = await session.dispatch({ verb: 'act', ref, action: 'click' });
      const refused = /disabled/.test(JSON.stringify(acted['rejected'] ?? ''));
      assert.equal(refused, said,
        `"${name}": read said disabled=${said}, act ${refused ? 'refused' : 'accepted'} — ` +
        `${JSON.stringify(acted).slice(0, 200)}`);
    }
  } finally { await session.close(); }
});
