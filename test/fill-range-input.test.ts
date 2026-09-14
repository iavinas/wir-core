// `act fill` sets an <input type=range>, because a range has no text to insert.
//
// PROVEN DEFECT, on a real third-party page. The browser-use stress test's
// slider task listens for `input` on <input type=range min=1 max=100>. Driven
// through WIR: `act fill 100` returned contradicted/value_mismatch and the
// oracle showed the value still 1. WIR was RIGHT to contradict — it reported
// honestly that the value had not moved. It simply had no mechanism: fill's
// default path is selectAll + Input.insertText, and a range has no text field,
// so the insert reached nothing.
//
// The fix routes `range` through setStructuredValue, exactly as `color` and
// `date` already are, for the same reason: the UA sanitizes the value behind
// non-text UI. Its focus + value + input + change sequence is what a drag
// produces, and it is what the page's own listener is on.
//
// Why not keystrokes: they exist here (End goes to max, arrows step) but cannot
// express an arbitrary value in one act. That is the same bind `color` is in.
//
// THE CONTROLS ARE THE POINT. Two of them:
//   1. An ordinary text input must STILL take the insertText path. If `range`
//      had been added by widening the branch rather than the type set, every
//      text field would start being written by assignment instead of by
//      browser-authentic input — the exact shortcut this spine exists to avoid.
//   2. A range whose value the UA CLAMPS must still report contradicted. Setting
//      120 on a max=100 range leaves 100, and the act must say so rather than
//      claim it wrote 120. Honesty about a rejected write is the whole reason
//      the original behaviour was correct.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>range</title><h1>Range</h1>' +
  '<input id="r" type="range" min="1" max="100" value="1" aria-label="Level">' +
  '<input id="t" type="text" aria-label="Words">' +
  '<pre id="log"></pre>' +
  '<script>' +
  'window.fired = [];' +
  'const r = document.getElementById("r");' +
  'r.addEventListener("input", () => window.fired.push("input:" + r.value));' +
  'r.addEventListener("change", () => window.fired.push("change:" + r.value));' +
  '</script>';

async function withPage(fn: (s: WirSession) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-range-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await fn(session);
  } finally {
    await session.close();
  }
}

const control = async (s: WirSession, role: string): Promise<any> => {
  const ov = (await s.dispatch({ verb: 'read' })) as Record<string, any>;
  return (ov['controls'] ?? []).find((c: any) => String(c.role) === role);
};

test('fill moves a range, and fires the input+change a drag would', async () => {
  await withPage(async (s) => {
    const sl = await control(s, 'slider');
    assert.ok(sl, 'precondition: the range compiled as a slider');
    const r = (await s.dispatch({
      verb: 'act',
      ref: sl.ref,
      action: 'fill',
      value: '100',
    })) as Record<string, any>;
    assert.equal(r['rejected'], undefined, `not rejected: ${JSON.stringify(r['rejected'])}`);
    assert.equal(
      r['effect']?.verdict,
      'verified',
      `the write is verified, not contradicted: ${JSON.stringify(r['effect'])}`,
    );

    // The ORACLE, independent of WIR: did the value actually move?
    const value = await s.host.page.evaluate(
      () => (document.getElementById('r') as HTMLInputElement).value,
    );
    assert.equal(value, '100', 'the DOM value actually moved');

    // And the page saw the events its own listener needs.
    const fired = await s.host.page.evaluate(() => (window as any).fired as string[]);
    assert.ok(
      fired.includes('input:100'),
      `the page received input — this is what a slider listens for: ${JSON.stringify(fired)}`,
    );
    assert.ok(fired.includes('change:100'), `and change: ${JSON.stringify(fired)}`);
  });
});

test('CONTROL — an ordinary text input still takes the insertText path', async () => {
  // If range had been added by widening fill's branch instead of the type set,
  // every text field would be written by assignment rather than by real input.
  await withPage(async (s) => {
    const t = await control(s, 'textbox');
    assert.ok(t, 'precondition: the text input compiled');
    const r = (await s.dispatch({
      verb: 'act',
      ref: t.ref,
      action: 'fill',
      value: 'hello',
    })) as Record<string, any>;
    assert.equal(r['effect']?.verdict, 'verified');
    assert.equal(r['effect']?.evidence, 'value_set');
    const value = await s.host.page.evaluate(
      () => (document.getElementById('t') as HTMLInputElement).value,
    );
    assert.equal(value, 'hello');
  });
});

test('CONTROL — a value the UA clamps still reports contradicted', async () => {
  // 120 on a max=100 range leaves 100. The act must say the write did not land
  // as asked. Claiming `verified` here would be the over-claim the original
  // (mechanism-less) behaviour was accidentally right about.
  await withPage(async (s) => {
    const sl = await control(s, 'slider');
    const r = (await s.dispatch({
      verb: 'act',
      ref: sl.ref,
      action: 'fill',
      value: '120',
    })) as Record<string, any>;
    const value = await s.host.page.evaluate(
      () => (document.getElementById('r') as HTMLInputElement).value,
    );
    assert.equal(value, '100', 'precondition: the UA clamped it');
    assert.equal(
      r['effect']?.verdict,
      'contradicted',
      `a clamped write is contradicted, never verified: ${JSON.stringify(r['effect'])}`,
    );
  });
});
