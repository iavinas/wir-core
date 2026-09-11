// `act key Enter` fires a real `keypress`, because Chrome only emits one for a
// keyDown that carries `text`.
//
// PROVEN DEFECT, on a real third-party page. The browser-use stress test
// (https://browser-use.github.io/stress-tests/challenge.html) scores its search
// task from a `keypress` listener on the input. Driven through WIR:
//   act fill  "squash"  -> verified/value_set
//   act key   Enter     -> unknown/no_observable_change_yet, score UNCHANGED
// Nothing was wrong with the target or the value; no keypress was ever produced,
// because pressChord sent keyDown/keyUp with no `text`. Chrome treats that as a
// rawKeyDown. After the fix the same two calls raise the score.
//
// The rule is Chromium's own, read from the local reference library rather than
// guessed (docs/references.md): Playwright's crInput.ts:61-73 sends
// `type: text ? 'keyDown' : 'rawKeyDown'` with `text`/`unmodifiedText`, its
// usKeyboardLayout.ts:93 gives Enter `text: '\r'`, and input.ts:78-80 suppresses
// text when any non-shift modifier is held.
//
// THE CONTROL IS THE SECOND TEST and it is the one that matters: Control+a must
// STILL send no text. A chord is a command, not a character, and the select-all
// path (test/key-action.test.ts) depends on it. A fix that made every key
// produce text would silently turn every chord into typing.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

/** Records every keyboard event the page actually receives, in order. */
const PAGE = '<!doctype html><title>keys</title><h1>Keys</h1>'
  + '<input id="f" type="text" aria-label="Field">'
  + '<pre id="log"></pre>'
  + '<script>'
  + 'window.seen = [];'
  + 'const f = document.getElementById("f");'
  + 'for (const t of ["keydown", "keypress", "keyup"]) {'
  + '  f.addEventListener(t, e => { window.seen.push(t + ":" + e.key); });'
  + '}'
  + '</script>';

async function press(value: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-keys-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    const field = (ov['controls'] ?? []).find((c: any) => c.role === 'textbox');
    assert.ok(field, 'precondition: the field compiled');
    const r = await session.dispatch(
      { verb: 'act', ref: field.ref, action: 'key', value }) as Record<string, any>;
    assert.equal(r['rejected'], undefined,
      `precondition: the key was accepted: ${JSON.stringify(r['rejected'])}`);
    return await session.host.page.evaluate(() => (window as any).seen as string[]);
  } finally { await session.close(); }
}

test('Enter produces a keypress, so a keypress listener runs', async () => {
  const seen = await press('Enter');
  assert.ok(seen.includes('keydown:Enter'), `keydown fired: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes('keypress:Enter'),
    `KEYPRESS fired — this is the defect: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes('keyup:Enter'), `keyup fired: ${JSON.stringify(seen)}`);
});

test('CONTROL — a chord still produces NO keypress, so it stays a command', async () => {
  // Control+a must remain a command. If this ever emits keypress, every chord has
  // become typing and the select-all path is silently broken.
  const seen = await press('Control+a');
  assert.ok(seen.some(e => e.startsWith('keydown:')), `keydown fired: ${JSON.stringify(seen)}`);
  assert.equal(seen.filter(e => e.startsWith('keypress:')).length, 0,
    `a chord must send no text, so no keypress: ${JSON.stringify(seen)}`);
});

test('CONTROL — a bare arrow key produces no keypress either', async () => {
  // ArrowRight has no character. A real keyboard emits keydown/keyup and no
  // keypress; anything else would be inventing input the user never made.
  const seen = await press('ArrowRight');
  assert.ok(seen.includes('keydown:ArrowRight'), `keydown fired: ${JSON.stringify(seen)}`);
  assert.equal(seen.filter(e => e.startsWith('keypress:')).length, 0,
    `no character, so no keypress: ${JSON.stringify(seen)}`);
});
