// The page's final rendered state, written on close, independent of the agent.
//
// WHY THIS EXISTS. An episode used to leave no independently readable record of
// how the page ENDED. Everything after the fact came from trajectory.jsonl —
// which records what the agent CHOSE TO LOOK AT, not what the world became.
//
// On 2026-08-12 that produced three wrong reports in one session, the worst
// being a run that reached 9 on a scored page and was reported as 1: the agent
// stopped re-reading the score at call 27, the trajectory froze there, and the
// page kept climbing for another 53 calls. The Playwright trace could not settle
// it either — snapshots store the DOM as nodes, so text split across elements
// ("Score:" · "9" · "/ 17") never appears as a searchable string.
//
// `innerText` is the right reading precisely BECAUSE it concatenates what those
// separate nodes render. It is what a person looking at the screen sees, which
// is the question being asked.
//
// Debug plane only: written when the runner asks for it, never exposed to the
// model, and best-effort — an episode's outcome is already decided by the time
// close() runs, so this must never be why a finished run gets reaped.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Text split across elements, exactly like the score line that caused this.
const PAGE =
  '<!doctype html><title>final</title><h1>Final</h1>' +
  '<div id="s">Score: <span>·</span> <b id="n">0</b> <span>·</span> / 17</div>' +
  '<button id="b">Bump</button>' +
  '<script>document.getElementById("b").addEventListener("click", () => {' +
  '  document.getElementById("n").textContent = "9"; });</script>';

test('close writes what the page ended up showing, not what was read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-final-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const out = join(dir, 'final-state.json');

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
    finalStatePath: out,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const ov = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const b = (ov['controls'] ?? []).find((c: any) => String(c.name ?? '').includes('Bump'));
    assert.ok(b, 'precondition: the button compiled');
    // Change the page and then NEVER LOOK AT IT AGAIN — the exact shape of the
    // failure: the agent acts, stops observing, and the record must still know.
    await session.dispatch({ verb: 'act', ref: b.ref, action: 'click' });
  } finally {
    await session.close();
  }

  assert.ok(existsSync(out), 'the file is written on close');
  const state = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
  assert.match(state['text'] ?? '', /Score:/, 'it carries the rendered text');
  // The whole point: innerText concatenates the split nodes, so the number is
  // recoverable from a string a person could read.
  const m = /Score:(.*?)\/\s*(\d+)/.exec(state['text'] ?? '');
  assert.ok(m, `the split line reads as one string: ${JSON.stringify(state['text'])}`);
  assert.equal(
    (m[1] ?? '').replace(/\D/g, ''),
    '9',
    'and reports 9 — the state after the act nobody observed',
  );
  assert.match(state['url'] ?? '', /a\.html$/, 'and where the page ended');
});

test('CONTROL — no path asked for, nothing written, close still succeeds', async () => {
  // Best-effort means optional. A runner that does not want this must not pay
  // for it, and close() must not become a new way for a finished run to die.
  const dir = mkdtempSync(join(tmpdir(), 'wir-final-off-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const out = join(dir, 'final-state.json');
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  await session.goto(`file://${join(dir, 'a.html')}`);
  await session.dispatch({ verb: 'read' });
  await session.close();
  assert.equal(existsSync(out), false, 'nothing written when nothing was asked for');
});
