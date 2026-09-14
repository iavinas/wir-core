// `act` said the page answered without saying what it said.
//
// A click whose only evidence is local rendering reported "N mutation records
// after dispatch" — a count. On a form, that answer IS the reason the submit
// bounced ("Date of Birth is required."), and a caller who cannot read it can
// only guess: the mimo episode on browser-use's AngularJS form spent 44 model
// calls and 22 acts retrying variations, having been told nine times that nine
// mutation records happened.
//
// The delta exists to say what changed. It now carries the page's OWN WORDS for
// whatever became visible during the act — read off the nodes the browser
// reported as mutated, matched against nothing, with no vocabulary of its own.
//
// The message is usually not a new node: `ng-show` and its equivalents toggle
// visibility on markup that was always there, so addedNodes sees nothing while
// the mutation TARGET is exactly the element whose text is wanted.
//
// FIXTURE JUSTIFIED: the condition is a validation message that is unhidden
// rather than inserted, which needs the hidden-then-shown pair stated exactly.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>validated</title>
<main>
  <form id="f">
    <span id="err" style="display:none">Date of Birth is required.</span>
    <button id="go" type="button">Submit Form</button>
  </form>
</main>
<script>
  document.getElementById('go').addEventListener('click', () => {
    // Unhidden, not inserted — the shape every validation library uses.
    document.getElementById('err').style.display = 'inline';
  });
</script>`;

test('a click that reveals a message reports the message, not a count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-mutdelta-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const found = await session.dispatch({ verb: 'find', name: 'Submit Form' });
    const btn = ((found['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(btn, `precondition: the submit is findable: ${JSON.stringify(found)}`);

    const acted = await session.dispatch({ verb: 'act', ref: btn.ref, action: 'click' });
    const effect = acted['effect'] as Record<string, unknown>;
    const delta = effect['delta'] as Record<string, unknown>;
    const after = String(delta['after'] ?? '');

    assert.match(
      after,
      /Date of Birth is required\./,
      `the caller must be able to read WHY, not just that something happened: ${after}`,
    );
  } finally {
    await session.close();
  }
});

test('a click that changes nothing visible still says nothing extra', async () => {
  // The other direction: this must not start narrating every page that repaints,
  // or the delta becomes noise and the economy invariant pays for it.
  const dir = mkdtempSync(join(tmpdir(), 'wir-mutdelta-quiet-'));
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>quiet</title><main><button id="go">Nothing</button></main>`,
  );
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const found = await session.dispatch({ verb: 'find', name: 'Nothing' });
    const btn = ((found['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(btn, `precondition: the button is findable: ${JSON.stringify(found)}`);
    const acted = await session.dispatch({ verb: 'act', ref: btn.ref, action: 'click' });
    const effect = (acted['effect'] ?? {}) as Record<string, unknown>;
    const delta = (effect['delta'] ?? {}) as Record<string, unknown>;
    assert.ok(
      !String(delta['after'] ?? '').includes('now showing'),
      `a click with no visible answer must not invent one: ${JSON.stringify(acted)}`,
    );
  } finally {
    await session.close();
  }
});
