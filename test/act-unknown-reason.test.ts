// Regression for the empty-handed `unknown`: 102 recorded acts answered
// verdict `unknown` and not one said why (docs/plans/fewer-misses.md §A2),
// so the model's next call was a guess.
//
// Verification of record is the LIVE probe against the browser-use stress page,
// debug/probe_unknown_reasons.mjs: before the fix, four distinct unknown paths
// (click tail, hover tail, type window, key tail) all returned bare verdicts
// (run 2026-08-13T07-27-06-518Z-unknown-reasons); after it, each states which
// observers were armed and came back empty (run 2026-08-13T07-29-48-382Z-),
// while the verified controls' effects stayed byte-identical across the runs.
//
// ONE fixture page for the reproduced conditions the live page cannot be asked
// to hold still for: an inert click target, a field whose content a `type` can
// re-assert, a key nothing handles, and a checkbox whose click verifies.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>unknown reasons</title><h1>Host</h1>
  <p id="inert">completely inert words</p>
  <input id="field" aria-label="Field" value="abc">
  <label><input type="checkbox" id="box"> accept</label>`;

async function startOn(html: string): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-unknown-'));
  writeFileSync(join(dir, 'a.html'), html);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    debugScreenshots: false,
  });
  await session.goto(`file://${dir}/a.html`);
  return session;
}

async function refOf(session: WirSession, query: object): Promise<string> {
  const found = await session.dispatch({ verb: 'find', ...query } as never);
  const ref = ((found['matches'] as { ref: string }[]) ?? [])[0]?.ref;
  assert.ok(ref, `no match for ${JSON.stringify(query)}: ${JSON.stringify(found)}`);
  return ref;
}

type Effect = { verdict: string; evidence: string; reason?: string };
const effectOf = (r: Record<string, unknown>): Effect => r['effect'] as Effect;

test('a click that changes nothing reads unknown WITH the observers it consulted', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await refOf(session, { name: 'completely inert words' });
    const acted = await session.dispatch({ verb: 'act', ref, action: 'click' });
    const effect = effectOf(acted);
    assert.equal(effect.verdict, 'unknown', JSON.stringify(acted));
    assert.ok(typeof effect.reason === 'string' && effect.reason.length > 0,
      `an unknown verdict must say why: ${JSON.stringify(acted)}`);
    // The reason names what was armed and what each observer answered.
    assert.match(effect.reason, /no navigation started/, effect.reason);
    assert.match(effect.reason, /document request/, effect.reason);
    assert.match(effect.reason, /mutation records/, effect.reason);
  } finally { await session.close(); }
});

test('type that cannot move the window and a key nothing handles both say why', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await refOf(session, { role: 'textbox', name: 'Field' });
    // Replacing "abc" with "abc": the readable window cannot move.
    const typed = await session.dispatch({ verb: 'act', ref, action: 'type', value: 'abc' });
    assert.equal(effectOf(typed).verdict, 'unknown', JSON.stringify(typed));
    assert.match(effectOf(typed).reason ?? '', /readable window did not move/,
      JSON.stringify(typed));
    // F7 dispatches cleanly and nothing on this page handles it.
    const keyed = await session.dispatch({ verb: 'act', ref, action: 'key', value: 'F7' });
    assert.equal(effectOf(keyed).verdict, 'unknown', JSON.stringify(keyed));
    assert.match(effectOf(keyed).reason ?? '', /nothing the target owns moved/,
      JSON.stringify(keyed));
  } finally { await session.close(); }
});

test('a verified verdict carries no reason field — zero new bytes on the paths that work', async () => {
  const session = await startOn(PAGE);
  try {
    const box = await refOf(session, { role: 'checkbox' });
    const clicked = await session.dispatch({ verb: 'act', ref: box, action: 'click' });
    assert.equal(effectOf(clicked).verdict, 'verified', JSON.stringify(clicked));
    assert.ok(!('reason' in (clicked['effect'] as object)),
      `verified must not grow a reason: ${JSON.stringify(clicked)}`);
    const field = await refOf(session, { role: 'textbox', name: 'Field' });
    const filled = await session.dispatch({ verb: 'act', ref: field, action: 'fill', value: 'new' });
    assert.equal(effectOf(filled).verdict, 'verified', JSON.stringify(filled));
    assert.ok(!('reason' in (filled['effect'] as object)),
      `verified must not grow a reason: ${JSON.stringify(filled)}`);
  } finally { await session.close(); }
});
