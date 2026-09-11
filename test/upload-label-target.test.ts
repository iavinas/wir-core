// The styled upload button: `<label>…<input type="file" hidden></label>`.
//
// A hidden input has no layout box, so it is correctly absent from the
// accessibility tree and NO ref can ever name it. The only thing the graph can
// offer is the label — and `upload` refused any ref that was not an <input>,
// with a repair that said "click it first if it opens a picker". Clicking it
// opens the NATIVE file chooser, which no verb can drive. So on this markup the
// runtime had no path to the file at all, while its own refusal implied one.
//
// The resolution is the platform's own: HTML defines a label's `labeled control`
// as its `for=` target or its first labelable descendant, and `label.control`
// implements exactly that. The attachment lands where a human's click would.
//
// Proven first on the live browser-use Material UI form, whose upload is
// `<label>Upload File <input type="file" hidden></label>` (2026-08-12): the act
// was rejected `invalid_args` on every attempt.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Both associations, since the spec defines both, plus a label that owns no file
// input at all — the refusal must survive for that one.
const PAGE = `<!doctype html><title>upload</title>
<main>
  <label id="wrapping">Wrapped upload<input type="file" hidden></label>
  <label id="pointing" for="far">Pointed upload</label>
  <input id="far" type="file" hidden>
  <label id="empty">Not an upload<input type="text"></label>
</main>`;

async function refFor(session: WirSession, name: string): Promise<string> {
  const found = await session.dispatch({ verb: 'find', name });
  const m = ((found['matches'] ?? []) as { ref: string }[])[0];
  assert.ok(m, `${JSON.stringify(name)} not found: ${JSON.stringify(found)}`);
  return m.ref;
}

test('upload attaches through the label that owns a hidden file input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-upload-label-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const uploads = mkdtempSync(join(tmpdir(), 'wir-upload-files-'));
  writeFileSync(join(uploads, 'report.txt'), 'proof\n');
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null, uploadDir: uploads,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    for (const name of ['Wrapped upload', 'Pointed upload']) {
      const ref = await refFor(session, name);
      const acted = await session.dispatch({ verb: 'act', ref, action: 'upload', value: 'report.txt' });
      assert.ok(!acted['rejected'],
        `${name}: the label is the only affordance this markup has — ` +
        `refusing it leaves no path to the file: ${JSON.stringify(acted['rejected'])}`);
      const effect = acted['effect'] as Record<string, unknown>;
      assert.equal(effect['evidence'], 'file_attached', JSON.stringify(acted));
      // Read back from the node that was WRITTEN. Reading the label instead
      // reported a real attachment as `contradicted` — the one verdict that can
      // never be walked back.
      assert.equal(effect['verdict'], 'verified',
        `the postcondition must consult the input, not the label: ${JSON.stringify(acted)}`);
    }
  } finally { await session.close(); }
});

test('a label with no file input is still refused, and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-upload-label-neg-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const uploads = mkdtempSync(join(tmpdir(), 'wir-upload-files-neg-'));
  writeFileSync(join(uploads, 'report.txt'), 'proof\n');
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null, uploadDir: uploads,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const ref = await refFor(session, 'Not an upload');
    const acted = await session.dispatch({ verb: 'act', ref, action: 'upload', value: 'report.txt' });
    assert.ok(acted['rejected'],
      `a label over a text input takes no file, and pretending otherwise is worse ` +
      `than refusing: ${JSON.stringify(acted)}`);
  } finally { await session.close(); }
});
