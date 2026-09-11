// Regressions for defect C2 (next-level.md §3.1): the href early-return made the
// same-document state check unreachable for links — 24.2% of recorded acts read
// `unknown`; the Forums toggle 37×. Verification of record is the live-site probe
// (Bootstrap docs dropdown, debug/runs/probe/2026-08-04T01-01-24-190Z); these
// fixtures pin the three behaviors so they cannot regress silently.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

async function startOn(html: string): Promise<{ session: WirSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-effects-'));
  writeFileSync(join(dir, 'a.html'), html);
  writeFileSync(join(dir, 'b.html'), '<!doctype html><title>b</title><h1>Page B</h1>');
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  await session.goto(`file://${dir}/a.html`);
  return { session, dir };
}

async function clickByName(session: WirSession, name: string): Promise<Record<string, unknown>> {
  const found = await session.dispatch({ verb: 'find', name });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `not found: ${name}`);
  return session.dispatch({ verb: 'act', ref, action: 'click' });
}

test('fragment-href toggle reads verified target_state_changed, not unknown', async () => {
  const { session } = await startOn(`<!doctype html><title>a</title><h1>Host</h1>
    <a href="#" id="t" aria-expanded="false">Forums toggle</a>
    <script>t.addEventListener('click', e => { e.preventDefault();
      t.setAttribute('aria-expanded', t.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'); });</script>`);
  try {
    const acted = await clickByName(session, 'Forums toggle');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'target_state_changed');
  } finally { await session.close(); }
});

test('a click whose effect lands elsewhere in the document reads dom_mutated', async () => {
  const { session } = await startOn(`<!doctype html><title>a</title><h1>Host</h1>
    <a href="#" id="add">Add row</a><ul id="list"></ul>
    <script>add.addEventListener('click', e => { e.preventDefault();
      const li = document.createElement('li'); li.textContent = 'row'; list.appendChild(li); });</script>`);
  try {
    const acted = await clickByName(session, 'Add row');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'dom_mutated');
  } finally { await session.close(); }
});

test('a real link still verifies as navigated_to_destination', async () => {
  const { session, dir } = await startOn('');
  try {
    await session.goto(`file://${dir}/a.html`);
    writeFileSync(join(dir, 'a.html'),
      `<!doctype html><title>a</title><h1>Host</h1><a href="file://${dir}/b.html">to page b</a>`);
    await session.goto(`file://${dir}/a.html`);
    const acted = await clickByName(session, 'to page b');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'navigated_to_destination');
  } finally { await session.close(); }
});
