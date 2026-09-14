// Regressions for the `type` action, earned by failing task 442 (score-program
// stream K): a virtualized editor's accessibility textarea holds a ~10-line
// paged WINDOW of the document, so fill's renderer-selectAll + insertText
// splices the payload into the window and corrupts the file, and fill's
// readback-equality comparator can never verify a correct write on that class.
// Verification of record is the LIVE probe: fill splice + compile facts in
// debug/runs/probe/2026-08-05T07-39-26-410Z, mechanism variants (chord reaches
// the page's keybinding layer; renderer selectAll does not) in
// debug/runs/probe/2026-08-05T07-54-31-226Z-mechanism. These fixtures pin the
// dispatch recipe so it cannot regress silently. The caret-to-end residue
// cleanup's FIRING case is live-only — Monaco's a11y off-by-one cannot be
// honestly reproduced without reimplementing Monaco (fixture-farm ban); its
// live acceptance is K4's 442 re-run, pending the gitlab lane window.
//
// One fixture page per proven condition:
// - windowed-editor: the 442 condition — window + keyboard-layer select-all.
// - plain textarea: the fallback condition — chord unhandled, renderer
//   selectAll replaces, so `type` means "replace the content" everywhere.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const WINDOWED_EDITOR = `<!doctype html><title>ed</title><h1>Host</h1>
  <textarea id="win" aria-label="Editor content" rows="3"></textarea>
  <script>
    // Minimal virtualized editor, the 442-proven condition: the textarea holds
    // only a WINDOW of the document; whole-document select-all exists only in
    // the page's keyboard layer (as Monaco's keybinding service does).
    let model = Array.from({length: 40}, (_, i) => 'original line ' + (i + 1)).join('\\n');
    let modelSelected = false;
    const win = document.getElementById('win');
    const render = () => { win.value = model.split('\\n').slice(0, 3).join('\\n'); };
    win.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault(); modelSelected = true; win.select();
      }
    });
    win.addEventListener('input', () => {
      if (modelSelected) { model = win.value; modelSelected = false; }
      else { model = win.value + '\\n' + model.split('\\n').slice(3).join('\\n'); }
      render();
    });
    render();
  </script>`;

const PAYLOAD = '<!doctype html>\n<title>replaced</title>\n<h1>whole document</h1>\n';

async function startOn(
  html: string,
  expectedAction: 'RETRIEVE' | 'MUTATE' = 'RETRIEVE',
): Promise<{ session: WirSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-typing-'));
  writeFileSync(join(dir, 'a.html'), html);
  const session = await WirSession.start({
    headless: true,
    expectedAction,
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  await session.goto(`file://${dir}/a.html`);
  return { session, dir };
}

async function editorRef(session: WirSession): Promise<string> {
  const found = await session.dispatch({ verb: 'find', role: 'textbox', name: 'Editor content' });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `editor not found: ${JSON.stringify(found)}`);
  return ref;
}

test('type replaces the WHOLE model of a windowed editor, newlines intact', async () => {
  const { session } = await startOn(WINDOWED_EDITOR);
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'type', value: PAYLOAD });
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'text_typed');
    // Ground truth, the probe-oracle way: the page's own model, not WIR's view.
    // (String form: a top-level `let` lives in the global lexical environment,
    // not on globalThis, and is only reachable by name.)
    const model = (await session.host.page.evaluate('model')) as string;
    assert.equal(
      model,
      PAYLOAD,
      "the chord must reach the page's keyboard layer and replace the whole model",
    );
  } finally {
    await session.close();
  }
});

test('type on the windowed editor never minted contradicted (the 442 comparator scar)', async () => {
  const { session } = await startOn(WINDOWED_EDITOR);
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'type', value: PAYLOAD });
    const effect = acted['effect'] as { verdict: string };
    // The window (3 lines) can never equal the payload; equality is not type's
    // contract and contradicted must be impossible on this path.
    assert.notEqual(effect.verdict, 'contradicted', JSON.stringify(acted));
  } finally {
    await session.close();
  }
});

test('fill on the same windowed editor still honestly reads contradicted/value_mismatch', async () => {
  const { session } = await startOn(WINDOWED_EDITOR);
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'fill', value: PAYLOAD });
    const effect = acted['effect'] as { verdict: string; evidence: string };
    // fill did not change by one byte (K2 decision): its renderer selectAll
    // selects only the window, the model splices, and readback mismatches.
    assert.equal(effect.verdict, 'contradicted', JSON.stringify(acted));
    assert.equal(effect.evidence, 'value_mismatch');
  } finally {
    await session.close();
  }
});

test('type on a plain textarea replaces the whole value via the fallback', async () => {
  const { session } = await startOn(`<!doctype html><title>p</title><h1>Host</h1>
    <textarea aria-label="Editor content">old one\nold two</textarea>`);
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'type', value: PAYLOAD });
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'text_typed');
    const value = await session.host.page.evaluate(() => document.querySelector('textarea')?.value);
    assert.equal(value, PAYLOAD, 'replace-the-content, never insert-at-caret');
  } finally {
    await session.close();
  }
});

test('MUTATE finish citing only a text_typed act is rejected (LOCAL_ONLY at birth)', async () => {
  const { session } = await startOn(WINDOWED_EDITOR, 'MUTATE');
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'type', value: PAYLOAD });
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.evidence, 'text_typed', JSON.stringify(acted));
    const finish = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [acted['actRef'] as string],
    });
    const rejected = finish['rejected'] as { kind: string } | undefined;
    assert.equal(
      rejected?.kind,
      'finish_rejected',
      `typing proves the browser holds text, never that the site changed: ${JSON.stringify(finish)}`,
    );
  } finally {
    await session.close();
  }
});
