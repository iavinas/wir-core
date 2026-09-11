// Two false negatives from the same family: the act worked and the runtime said
// it had not.
//
// 1. HOVER SAW NOTHING because the mutation counter was armed only for
//    click/type/key. For a hover the counter is often the ONLY witness — a
//    :hover menu or a text swap changes the DOM while the target's own AX name
//    and states do not move at all. Measured on the browser-use stress test: the
//    hover target rewrites its text the instant mouseenter lands, and the act
//    reported `no_observable_change_yet` carrying the tell
//    "[mutation records unobserved this act]".
//
// 2. CONTENTEDITABLE READ AS CONTRADICTED because readValue returns
//    `this.value ?? null`, and a <div contenteditable> has no `.value`. Both
//    readings were null, so `fill` compared null against the text it had just
//    written and reported contradicted/value_mismatch — on a write that had
//    landed, which the page's own scorer counted.
//
// Both are the class this whole session has been about: not "the runtime cannot
// do it" but "the runtime did it and denied it". A `contradicted` verdict is the
// most expensive kind of wrong, because it tells the model to undo correct work.
//
// THE CONTROLS pin the two ways a fix like this goes bad: fill on an ordinary
// input must still compare `.value` (not textContent, which for an <input> is
// always empty), and a hover that genuinely changes nothing must still say so.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = '<!doctype html><title>ce</title><h1>CE</h1>'
  + '<div id="ed" contenteditable="true" role="textbox" aria-label="Notes">type here</div>'
  + '<input id="plain" type="text" aria-label="Plain">'
  + '<div id="hot" role="group">Hover me</div>'
  + '<div id="cold" role="group">Inert</div>'
  + '<script>'
  + 'document.getElementById("hot").addEventListener("mouseenter", function() {'
  + '  this.textContent = "Nice hovering!";'   // changes the DOM, not the AX name
  + '});'
  + '</script>';

async function withPage(fn: (s: WirSession) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-ce-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });
    await fn(session);
  } finally { await session.close(); }
}

const find1 = async (s: WirSession, name: string): Promise<string> => {
  const r = await s.dispatch({ verb: 'find', name }) as Record<string, any>;
  const m = (r['matches'] ?? [])[0];
  assert.ok(m, `precondition: ${name} findable: ${JSON.stringify(r['matches'])}`);
  return m.ref;
};

test('filling a contenteditable is verified, not contradicted', async () => {
  await withPage(async (s) => {
    const ref = await find1(s, 'type here');
    const r = await s.dispatch(
      { verb: 'act', ref, action: 'fill', value: 'banana' }) as Record<string, any>;
    assert.equal(r['effect']?.verdict, 'verified',
      `the write landed, so it is not contradicted: ${JSON.stringify(r['effect'])}`);
    assert.equal(r['effect']?.evidence, 'value_set');
    const text = await s.host.page.evaluate(() =>
      (document.getElementById('ed') as HTMLElement).textContent);
    assert.equal(text, 'banana', 'and the oracle agrees the content is there');
  });
});

test('hover observes a DOM change the target AX state cannot show', async () => {
  await withPage(async (s) => {
    const ref = await find1(s, 'Hover me');
    const r = await s.dispatch({ verb: 'act', ref, action: 'hover' }) as Record<string, any>;
    assert.equal(r['effect']?.verdict, 'verified',
      `the page reacted, so the act must not deny it: ${JSON.stringify(r['effect'])}`);
    assert.equal(r['effect']?.evidence, 'dom_mutated');
    const text = await s.host.page.evaluate(() =>
      (document.getElementById('hot') as HTMLElement).textContent);
    assert.equal(text, 'Nice hovering!', 'the oracle confirms what changed');
  });
});

test('CONTROL — fill on an ordinary input still compares its .value', async () => {
  // An <input>'s textContent is ALWAYS empty. If the comparator had been switched
  // to textContent wholesale rather than branching on isContentEditable, every
  // text field would report contradicted forever.
  await withPage(async (s) => {
    const ov = await s.dispatch({ verb: 'read' }) as Record<string, any>;
    const inp = (ov['controls'] ?? []).find((c: any) => String(c.name ?? '') === 'Plain');
    assert.ok(inp, 'precondition: the plain input compiled');
    const r = await s.dispatch(
      { verb: 'act', ref: inp.ref, action: 'fill', value: 'hello' }) as Record<string, any>;
    assert.equal(r['effect']?.verdict, 'verified', JSON.stringify(r['effect']));
    assert.equal(r['effect']?.evidence, 'value_set');
  });
});

test('CONTROL — a hover that changes nothing still reports no change', async () => {
  // Arming the counter must not make every hover a pass.
  await withPage(async (s) => {
    const ref = await find1(s, 'Inert');
    const r = await s.dispatch({ verb: 'act', ref, action: 'hover' }) as Record<string, any>;
    assert.notEqual(r['effect']?.evidence, 'dom_mutated',
      `nothing moved, so nothing is claimed: ${JSON.stringify(r['effect'])}`);
  });
});
