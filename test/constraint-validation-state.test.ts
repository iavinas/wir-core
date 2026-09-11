// A submit the BROWSER refuses looks like a submit that did nothing.
//
// Constraint validation blocks form submission before any script runs: no
// mutation, no message, no navigation. `act` honestly reports
// no_observable_change_yet — and the caller is left with a page that simply will
// not submit and no way to learn why. Chrome knows exactly which control it
// refused and says so in the accessibility tree; the graph was dropping it.
//
// Measured on browser-use's shadow-DOM form: an `input[type=email]` whose
// accessible name is empty — its label sits outside the shadow root, so Chrome
// itself computes "" — took the text "Test". Every later submit did nothing at
// all, three episodes in a row, and nothing in any response named the field.
//
// `required` rides along for the same reason `disabled` already does: the
// browser has computed it and the caller cannot see it.
//
// FIXTURE JUSTIFIED: needs a control the browser will refuse, beside one it
// accepts, so "the state names the culprit" is decidable.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>constraints</title>
<main>
  <form id="f">
    <label for="mail">Mail</label><input id="mail" type="email" required>
    <label for="note">Note</label><input id="note" type="text">
    <button id="go" type="submit">Submit Form</button>
  </form>
</main>`;

async function stateOf(session: WirSession, name: string): Promise<Record<string, unknown>> {
  const found = await session.dispatch({ verb: 'find', name });
  const m = ((found['matches'] ?? []) as { state?: Record<string, unknown> }[])[0];
  assert.ok(m, `${JSON.stringify(name)} not found: ${JSON.stringify(found)}`);
  return m.state ?? {};
}

test('a required control says so before anything is typed into it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-constraint-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    assert.equal((await stateOf(session, 'Mail'))['required'], true,
      'the browser knows this one is required');
    assert.ok(!('required' in await stateOf(session, 'Note')),
      'and the optional one is not marked — or the flag says nothing');
  } finally { await session.close(); }
});

test('after a submit the browser refused, the offending control is marked invalid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-constraint-invalid-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    // A value the type refuses. This is the whole shape of the defect: the page
    // looks filled and will not submit.
    const found = await session.dispatch({ verb: 'find', name: 'Mail' });
    const field = ((found['matches'] ?? []) as { ref: string }[])[0]!;
    await session.dispatch({ verb: 'act', ref: field.ref, action: 'fill', value: 'Test' });

    const submit = await session.dispatch({ verb: 'find', name: 'Submit Form' });
    const btn = ((submit['matches'] ?? []) as { ref: string }[])[0]!;
    await session.dispatch({ verb: 'act', ref: btn.ref, action: 'click' });

    assert.equal((await stateOf(session, 'Mail'))['invalid'], true,
      'the control the browser refused must say so, or the submit is a silent wall');

    // And it clears when the value becomes acceptable — a flag that never clears
    // would be noise rather than a signal.
    await session.dispatch({ verb: 'act', ref: field.ref, action: 'fill', value: 'a@b.com' });
    assert.ok(!(await stateOf(session, 'Mail'))['invalid'],
      'a control the browser now accepts must not still read invalid');
  } finally { await session.close(); }
});
