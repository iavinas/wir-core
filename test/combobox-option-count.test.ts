// A control says how many options it owns, so the real dropdown is findable.
//
// PROVEN DEFECT. Three nodes can compile with role `combobox` and exactly one be
// a `<select>`; the others are styled wrappers. `act select` refuses a wrapper —
// correctly, it has no options to drive — but nothing in the projection told the
// caller which was which, so it guessed.
//
// Measured on the browser-use stress test: an agent asked to choose an option
// tried two comboboxes, got "this control has no <option> elements", and never
// reached the third. The dropdown task failed on EVERY run for want of one
// integer. With the count projected, the same agent picked correctly and both
// `select` calls verified in the same turn.
//
// The <option> elements themselves stay uncompiled, and that is right: inside a
// closed <select> they render nothing and are not separately addressable. Only
// their COUNT is disclosed.
//
// THE CONTROL IS THE SECOND TEST: a control that owns no options must carry no
// count at all — not zero. Zero and absent mean different things here, and a
// wrapper reporting `optionCount: 0` would look like an empty dropdown rather
// than something that is not a dropdown.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// A real select beside a wrapper that merely looks like one.
const PAGE = '<!doctype html><title>combo</title><h1>Combo</h1>'
  + '<label>Pick a colour'
  + '<select id="real"><option>Choose</option><option>Red</option><option>Blue</option></select>'
  + '</label>'
  + '<div id="fake" role="combobox" aria-label="Pick a fruit" tabindex="0">Choose a fruit</div>';

async function withPage(fn: (s: WirSession, controls: any[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-combo-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    await fn(session, ov['controls'] ?? []);
  } finally { await session.close(); }
}

test('the real dropdown reports its option count, and select works on it', async () => {
  await withPage(async (s, controls) => {
    const withCount = controls.filter((c: any) => typeof c.optionCount === 'number');
    assert.equal(withCount.length, 1,
      `exactly one control owns options: ${JSON.stringify(controls)}`);
    assert.equal(withCount[0].optionCount, 3, 'and reports how many');

    // The point of disclosing it: the caller can pick without guessing.
    const r = await s.dispatch(
      { verb: 'act', ref: withCount[0].ref, action: 'select', value: 'Red' }) as Record<string, any>;
    assert.equal(r['rejected'], undefined, `select works on it: ${JSON.stringify(r['rejected'])}`);
    assert.equal(r['effect']?.evidence, 'option_selected');
    const value = await s.host.page.evaluate(() =>
      (document.getElementById('real') as HTMLSelectElement).value);
    assert.equal(value, 'Red', 'and the ORACLE agrees');
  });
});

test('CONTROL — a lookalike that owns no options carries NO count, not zero', async () => {
  // Absent and zero mean different things. A wrapper reporting `optionCount: 0`
  // reads as an empty dropdown; carrying nothing reads as "not a dropdown",
  // which is the truth and is what makes the field a usable discriminator.
  await withPage(async (s, controls) => {
    // The lookalike carries no affordance, so it is not in `controls` at all —
    // itself a small piece of the same story. Reach it through find.
    const f = await s.dispatch({ verb: 'find', name: 'Pick a fruit' }) as Record<string, any>;
    const fake = (f['matches'] ?? [])[0];
    assert.ok(fake, `precondition: the lookalike is findable: ${JSON.stringify(f['matches'])}`);
    assert.equal(fake.optionCount, undefined,
      `it carries no count at all: ${JSON.stringify(fake)}`);

    // And select still refuses it, unchanged.
    const r = await s.dispatch(
      { verb: 'act', ref: fake.ref, action: 'select', value: 'Red' }) as Record<string, any>;
    assert.equal(r['rejected']?.kind, 'invalid_args');
    assert.match(String(r['rejected']?.reason), /no <option> elements/);
  });
});
