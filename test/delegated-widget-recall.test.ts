// `read` dropped a control that `find` returned, and said the list was complete.
//
// The affordance filter at read.ts:175 keeps only nodes with a compiled
// affordance, and `clickable` came from Chrome's isClickable — which keys on a
// handler bound TO THE NODE. Every major component library binds one listener at
// a root container instead and dispatches from there, so their `div[role=button]`
// widgets carry no node-level handler. Material UI's country Select is exactly
// this shape: `find {role:"button"}` returned it, `act click` on it verified and
// opened the listbox, and `read` reported controlsTotal 20 with nothing withheld
// and that button not among them.
//
// That is the zero-tolerance class — "the runtime saw it and did not show you" —
// and it is worse than a miss, because the count asserted completeness.
//
// Proven first on the live browser-use Material UI form (2026-08-12), then pinned
// here. FIXTURE JUSTIFIED: the condition is a role-bearing div whose ONLY handler
// is delegated to an ancestor. A real page carries it inside a framework bundle;
// isolating it is the only way to make the agreement decidable.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// No inline handler anywhere on the widget: the listener lives on <body>, which
// is what a delegating framework does and what isClickable does not see.
const PAGE = `<!doctype html><title>delegated</title>
<main>
  <button id="plain">plain button</button>
  <div id="widget" role="button" tabindex="0">Country</div>
  <div id="notawidget">just a div</div>
</main>
<script>
  document.body.addEventListener('click', (e) => {
    if (e.target.id === 'widget') document.title = 'activated';
  });
</script>`;

test('a role-bearing widget with only a delegated handler is in read.controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-delegated-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    // What find can reach, by role — the set read must not be smaller than.
    const found = await session.dispatch({ verb: 'find', role: 'button' });
    const matches = (found['matches'] ?? []) as { ref: string; name?: string }[];
    const widget = matches.find((m) => (m.name ?? '').includes('Country'));
    assert.ok(widget, `find must reach the delegated widget: ${JSON.stringify(found)}`);

    const overview = await session.dispatch({ verb: 'read' });
    const controls = (overview['controls'] ?? []) as { ref: string; name?: string }[];
    assert.ok(
      controls.some((c) => c.ref === widget.ref),
      'read.controls must contain every control find returns — a list that omits one ' +
        `while reporting controlsTotal ${String(overview['controlsTotal'])} with ` +
        `withheld ${JSON.stringify(overview['withheld'] ?? null)} claims completeness it does not have: ` +
        JSON.stringify(controls.map((c) => c.name)),
    );

    // And the fix must not turn every div into a control: a plain div carries no
    // role and stays out, or "show everything" would pass the assertion above.
    assert.ok(
      !controls.some((c) => (c.name ?? '').includes('just a div')),
      `a div with no widget role is not a control: ${JSON.stringify(controls.map((c) => c.name))}`,
    );
  } finally {
    await session.close();
  }
});

test('the widget read now shows is one act can actually drive', async () => {
  // Visibility that does not survive contact with `act` would be a worse lie
  // than the omission: the whole defect is the two halves disagreeing.
  const dir = mkdtempSync(join(tmpdir(), 'wir-delegated-act-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const controls = (overview['controls'] ?? []) as { ref: string; name?: string }[];
    const widget = controls.find((c) => (c.name ?? '').includes('Country'));
    assert.ok(widget, 'precondition: the widget is in controls');

    const acted = await session.dispatch({ verb: 'act', ref: widget.ref, action: 'click' });
    assert.ok(!acted['rejected'], `act must accept it: ${JSON.stringify(acted['rejected'])}`);
    const title = await session.dispatch({ verb: 'read' });
    assert.equal(
      title['title'],
      'activated',
      `the delegated handler must have run: ${JSON.stringify(acted)}`,
    );
  } finally {
    await session.close();
  }
});
