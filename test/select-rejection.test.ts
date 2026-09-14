// `act select` had one failure message for three different failures, and it was
// wrong on two of them:
//
//   reason: no option matching "X" on this control
//   repair: {"verb":"read","target":"n_…"} to see the available options
//
// On a div-based ARIA combobox there are no options AT ALL, so "no option
// matched" is false 100% of the time — the honest answer is that `select`
// cannot drive the control.
//
// And on a `size=1` select the recommended read is guaranteed to come back
// without them: an `<option>` in a collapsed select has no layout box, and
// admission requires one. Measured — `find` returns 0 matches for the options
// of a `size=1` select and 1 each for a `size=3`, whose options do have boxes.
// So the repair named a call that cannot help, which is the dead-repair class.
//
// The fix takes nothing new from the browser. The injected function already
// holds `this.options` — it must, to decide nothing matched — so it hands the
// labels back on the way out.
//
// The remaining honest gap, stated in the message rather than hidden: past the
// listed labels there is NO continuation, because no verb can reach the options
// of a collapsed select. A declared gap is allowed; a continuation that returns
// nothing is not.
//
// FIXTURE JUSTIFIED: needs a collapsed select, an over-long one, and an ARIA
// combobox side by side, with option text known exactly.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const MANY = Array.from({ length: 40 }, (_, i) => `<option>Country ${i}</option>`).join('');

const PAGE = `<!doctype html><title>select</title><main>
  <select aria-label="small picker"><option>Alpha</option><option>Beta</option><option>Gamma</option></select>
  <select aria-label="big picker">${MANY}</select>
  <div role="combobox" aria-label="scripted picker" tabindex="0">Choose…</div></main>`;

async function rejectOf(
  session: WirSession,
  name: string,
  value: string,
): Promise<{ reason: string; repair: string }> {
  const found = await session.dispatch({ verb: 'find', name });
  const ref = ((found['matches'] ?? []) as { ref: string }[])[0]?.ref;
  assert.ok(ref, `${name} not found: ${JSON.stringify(found)}`);
  const r = await session.dispatch({ verb: 'act', ref, action: 'select', value });
  const rej = r['rejected'] as { reason?: string; repair?: string } | undefined;
  assert.ok(rej, `expected a rejection: ${JSON.stringify(r).slice(0, 200)}`);
  return { reason: rej.reason ?? '', repair: rej.repair ?? '' };
}

async function start(): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-select-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  await session.goto(`file://${dir}/a.html`);
  return session;
}

test('a failed select names the options the page actually has', async () => {
  const session = await start();
  try {
    const { reason, repair } = await rejectOf(session, 'small picker', 'Nope');
    for (const opt of ['Alpha', 'Beta', 'Gamma']) {
      assert.match(reason, new RegExp(opt), `the rejection must list ${opt}: ${reason}`);
    }
    // And must not send the caller to a read that cannot return them.
    assert.ok(
      !/"verb":"read"/.test(repair),
      `a size=1 select's options have no box; that read is dead: ${repair}`,
    );
  } finally {
    await session.close();
  }
});

test('a COLLAPSED long list declares the gap, because there is one', async () => {
  const session = await start();
  try {
    const { reason } = await rejectOf(session, 'big picker', 'Nope');
    assert.match(reason, /\+10 more of 40/, `the residual must be exact: ${reason}`);
    assert.match(
      reason,
      /cannot\s+list the rest/,
      `the absence of a continuation must be stated, not implied: ${reason}`,
    );
    assert.ok(
      !/"verb":"read"/.test(reason),
      `no call may be offered that cannot reach them: ${reason}`,
    );
  } finally {
    await session.close();
  }
});

// The first version of that message declared the gap for EVERY select, and the
// gap only exists for collapsed ones. Measured, one select per page:
// size=1 gives `find` 0 matches and `read` 0 children, while size=4 and
// `multiple` give 1 and 40. So on a sized select the options are admitted and a
// plain read returns them — declaring them unreachable was a false gap, which
// is the same defect class as a false continuation, only quieter.
test('a SIZED long list offers the read that reaches the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-select-sized-'));
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>sized</title>
    <main><select aria-label="sized picker" size="4">${MANY}</select></main>`,
  );
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const { reason } = await rejectOf(session, 'sized picker', 'Nope');
    assert.match(reason, /\+10 more of 40/, reason);
    assert.ok(
      !/cannot\s+list the rest/.test(reason),
      `a sized select's options ARE reachable; declaring a gap is a false gap: ${reason}`,
    );

    // Follow the offered call. A continuation that does not deliver is the
    // dead-repair class this whole line of work exists to remove.
    const m = /(\{"verb":"read"[^}]*\})/.exec(reason);
    assert.ok(m, `a reachable residual must carry its call: ${reason}`);
    const r = await session.dispatch(JSON.parse(m[1]!) as never);
    const kids = (r['children'] ?? []) as unknown[];
    assert.equal(kids.length, 40, `the offered read must return every option: ${kids.length}`);
  } finally {
    await session.close();
  }
});

test('a scripted combobox is told it is not a select', async () => {
  const session = await start();
  try {
    const { reason, repair } = await rejectOf(session, 'scripted picker', 'Alpha');
    assert.ok(
      !/no option matching/.test(reason),
      `"no option matched" is false when there are no options: ${reason}`,
    );
    assert.match(reason, /no <option> elements/, reason);
    // The repair must be an act it can actually perform.
    assert.match(repair, /"action":"click"/, repair);
  } finally {
    await session.close();
  }
});

test('a matching select still succeeds', async () => {
  // The guard rewrote the success path's control flow, so pin that it still
  // reaches the browser and verifies.
  const session = await start();
  try {
    const found = await session.dispatch({ verb: 'find', name: 'small picker' });
    const ref = ((found['matches'] ?? []) as { ref: string }[])[0]?.ref;
    assert.ok(ref, JSON.stringify(found));
    const r = await session.dispatch({ verb: 'act', ref, action: 'select', value: 'Beta' });
    const effect = r['effect'] as { verdict?: string; evidence?: string } | undefined;
    assert.equal(effect?.verdict, 'verified', JSON.stringify(r).slice(0, 300));
    assert.equal(effect?.evidence, 'option_selected', JSON.stringify(r).slice(0, 300));
  } finally {
    await session.close();
  }
});
