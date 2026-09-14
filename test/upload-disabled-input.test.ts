// Regression for upload skipping the revalidation spine (reproduced in
// debug/probe_upload_disabled.mjs, 2026-08-13): upload branched out of `act`
// before the AX re-probe and its disabled check, and DOM.setFileInputFiles does
// not honor `disabled` — so a disabled file input took the file and the act
// answered `verified / file_attached` for an attachment the page can never
// submit. Both shapes reproduced: the visible disabled input, and a styled
// label wrapping a hidden disabled input — the latter invisible to the AX
// spine (display:none holds it out of the tree), so the disabled question is
// re-asked of the RESOLVED input in the DOM, inside uploadFile.
//
// The fixture is justified the same way the probe's is: no browser-use stress
// page has a disabled file input (challenge.html's is enabled; checked every
// forms-comparison src/ page, 2026-08-13).
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>attachments</title>
<main>
  <label for="dis">Attach report</label>
  <input id="dis" type="file" disabled>
  <label id="wrapped">Wrapped disabled upload<input type="file" hidden disabled></label>
  <label for="ok">Attach photo</label>
  <input id="ok" type="file">
</main>`;

async function refFor(session: WirSession, name: string): Promise<string> {
  const found = await session.dispatch({ verb: 'find', name });
  const m = ((found['matches'] ?? []) as { ref: string }[])[0];
  assert.ok(m, `${JSON.stringify(name)} not found: ${JSON.stringify(found)}`);
  return m.ref;
}

async function uploadTo(session: WirSession, name: string): Promise<Record<string, unknown>> {
  const ref = await refFor(session, name);
  return (await session.dispatch({
    verb: 'act',
    ref,
    action: 'upload',
    value: 'report.txt',
  })) as Record<string, unknown>;
}

test('a disabled file input rejects the upload instead of verifying it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-upload-disabled-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const uploads = mkdtempSync(join(tmpdir(), 'wir-upload-disabled-files-'));
  writeFileSync(join(uploads, 'report.txt'), 'proof\n');
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
    uploadDir: uploads,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    // The visible disabled input: the shared spine's disabled check owns this.
    const direct = await uploadTo(session, 'Attach report');
    const directRejected = direct['rejected'] as { kind: string; reason: string } | undefined;
    assert.ok(
      directRejected,
      `expected a rejection, got ${JSON.stringify(direct['effect'] ?? direct)}`,
    );
    assert.equal(directRejected.kind, 'invalid_args');
    assert.match(directRejected.reason, /disabled/);

    // The label-wrapped hidden disabled input: invisible to the AX spine, so
    // the resolved-input check inside uploadFile owns it.
    const wrapped = await uploadTo(session, 'Wrapped disabled upload');
    const wrappedRejected = wrapped['rejected'] as { kind: string; reason: string } | undefined;
    assert.ok(
      wrappedRejected,
      `expected a rejection, got ${JSON.stringify(wrapped['effect'] ?? wrapped)}`,
    );
    assert.equal(wrappedRejected.kind, 'invalid_args');
    assert.match(wrappedRejected.reason, /disabled/);

    // Neither input may hold the file: a rejection that still attached would be
    // the same over-claim with different paperwork.
    const held = await session.host.page.evaluate(() => ({
      dis: (document.getElementById('dis') as HTMLInputElement | null)?.files?.length ?? -1,
      wrapped:
        (document.querySelector('#wrapped input') as HTMLInputElement | null)?.files?.length ?? -1,
    }));
    assert.deepEqual(held, { dis: 0, wrapped: 0 });

    // The enabled control keeps its verdict.
    const ok = await uploadTo(session, 'Attach photo');
    const effect = ok['effect'] as { verdict: string; evidence: string } | undefined;
    assert.ok(effect, `expected an effect, got ${JSON.stringify(ok['rejected'] ?? ok)}`);
    assert.equal(effect.verdict, 'verified');
    assert.equal(effect.evidence, 'file_attached');
  } finally {
    await session.close().catch(() => undefined);
  }
});
