// A click that flips a checkbox is `verified`, because `checked` is state.
//
// PROVEN DEFECT. axProbe captured role, name, disabled and expanded — and the
// comparison used only name and expanded. A checkbox click flips `checked` and
// NOTHING else: no name change, no expanded change. So the act spine saw nothing
// and reported `unknown / no_observable_change_yet` on a checkbox that had
// visibly ticked. Measured on the browser-use stress test: two of its three
// checkboxes read `unknown` while the page's own scorer counted them.
//
// `pressed` had the identical hole and was worse, because the comment directly
// above the comparison already claimed the runtime checked "expanded, pressed,
// name" — it never captured pressed at all. `selected` joins them as the rest of
// the AX vocabulary for a control's own state.
//
// WHY THIS MATTERS BEYOND A TICK BOX. `target_state_changed` is GATE-ELIGIBLE
// (it is absent from LOCAL_ONLY_EVIDENCE), so a MUTATE task whose mutation IS
// ticking a box could not cite its own act. The runtime was not merely quiet; it
// was withholding the only evidence that act produced.
//
// Values stay as the raw AX strings rather than coerced to booleans: 'mixed' is
// a real tri-state, and mixed -> true is a change a boolean cast would erase.
// That is what the third test pins.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = '<!doctype html><title>state</title><h1>State</h1>'
  + '<label><input id="c" type="checkbox"> I accept</label>'
  + '<button id="t" aria-pressed="false">Mute</button>'
  + '<label><input id="m" type="checkbox"> Partial</label>'
  + '<p id="inert">nothing happens here</p>'
  + '<script>'
  // a tri-state box: its AX `checked` goes mixed -> true, and its name never moves
  + 'document.getElementById("m").indeterminate = true;'
  + 'document.getElementById("t").addEventListener("click", function() {'
  + '  this.setAttribute("aria-pressed", this.getAttribute("aria-pressed") === "true" ? "false" : "true");'
  + '});'
  + '</script>';

async function withPage(fn: (s: WirSession) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-state-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });
    await fn(session);
  } finally { await session.close(); }
}

const byName = async (s: WirSession, re: RegExp): Promise<any> => {
  const ov = await s.dispatch({ verb: 'read' }) as Record<string, any>;
  const c = (ov['controls'] ?? []).find((x: any) => re.test(String(x.name ?? '')));
  assert.ok(c, `precondition: ${re} compiled: ${JSON.stringify((ov['controls'] ?? []).map((x: any) => x.name))}`);
  return c;
};

test('ticking a checkbox is verified, and the delta says what changed', async () => {
  await withPage(async (s) => {
    const cb = await byName(s, /I accept/);
    const r = await s.dispatch({ verb: 'act', ref: cb.ref, action: 'click' }) as Record<string, any>;
    assert.equal(r['effect']?.verdict, 'verified',
      `a ticked box is an observed change: ${JSON.stringify(r['effect'])}`);
    assert.equal(r['effect']?.evidence, 'target_state_changed');
    assert.match(String(r['effect']?.delta?.after), /checked=true/,
      `and the delta names the state, not just the name: ${JSON.stringify(r['effect']?.delta)}`);

    // ORACLE, independent of WIR.
    const checked = await s.host.page.evaluate(() =>
      (document.getElementById('c') as HTMLInputElement).checked);
    assert.equal(checked, true, 'the box really is ticked');
  });
});

test('a toggle button flipping aria-pressed is verified too', async () => {
  // `pressed` was named in the code comment and never captured.
  await withPage(async (s) => {
    const b = await byName(s, /Mute/);
    const r = await s.dispatch({ verb: 'act', ref: b.ref, action: 'click' }) as Record<string, any>;
    assert.equal(r['effect']?.verdict, 'verified', JSON.stringify(r['effect']));
    assert.match(String(r['effect']?.delta?.after), /pressed=true/,
      `the delta names pressed: ${JSON.stringify(r['effect']?.delta)}`);
  });
});

test('a tri-state box going mixed -> true is a change, not a flattened false',
  async () => {
    // If `checked` were coerced to a boolean, `mixed` would read as false and a
    // real transition would vanish. The raw AX string is why it does not.
    await withPage(async (s) => {
      const cb = await byName(s, /Partial/);
      const r = await s.dispatch({ verb: 'act', ref: cb.ref, action: 'click' }) as Record<string, any>;
      assert.equal(r['effect']?.verdict, 'verified', JSON.stringify(r['effect']));
      assert.match(String(r['effect']?.delta?.before), /checked=mixed/,
        `it started mixed: ${JSON.stringify(r['effect']?.delta)}`);
      assert.match(String(r['effect']?.delta?.after), /checked=true/, 'and ended true');
    });
  });

test('CONTROL — a click that changes NOTHING is still not verified', async () => {
  // Widening the probe must not turn every click into a pass. A paragraph that
  // owns no state and moves nothing must still read honestly.
  await withPage(async (s) => {
    const r0 = await s.dispatch({ verb: 'find', name: 'nothing happens here' }) as Record<string, any>;
    const m = (r0['matches'] ?? [])[0];
    assert.ok(m, 'precondition: the inert paragraph is findable');
    const r = await s.dispatch({ verb: 'act', ref: m.ref, action: 'click' }) as Record<string, any>;
    assert.notEqual(r['effect']?.evidence, 'target_state_changed',
      `an inert target must not mint state evidence: ${JSON.stringify(r['effect'])}`);
  });
});
