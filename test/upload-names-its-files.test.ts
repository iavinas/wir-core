// A refused upload says what IS available.
//
// PROVEN DEFECT. "no file named X is available to this episode" told the caller
// only that its guess was wrong, so it guessed again. Measured on the
// browser-use stress test, mimo-v2.5 tried "test.txt", "file.txt", "test",
// "hello.txt" and "upload.txt" — five rejections, five round trips at ~3.1s
// each, and the upload task went uncompleted while the one available file sat
// unnamed the whole time.
//
// This is the codebase's own rule applied to a fence instead of a page: a bound
// may exist, but only as complete-so-far + an accounting of what was withheld +
// a continuation that reaches it. The upload fence had the bound and neither of
// the other two.
//
// WHAT IT DISCLOSES, and why that is safe: a RUNNER-DECLARED directory. The
// runner chose it and chose its contents; naming them widens nothing. This is
// not page content and not the model's to expand — the fence exists because the
// model's tokens are shaped by untrusted page text, and "attach ~/.ssh/id_rsa"
// is a sentence a hostile page can put on screen.
//
// THE CONTROLS ARE THE POINT. Three of them, one per way this could have gone
// wrong: a path must still be refused, an escape must still be refused, and an
// empty directory must promise nothing. A listing is only safe if the guards
// around it are untouched.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = '<!doctype html><title>upload</title><h1>Upload</h1>'
  + '<input id="f" type="file" aria-label="Document">';

async function withUploadDir(
  files: string[], fn: (s: WirSession, ref: string) => Promise<void>,
): Promise<void> {
  const pageDir = mkdtempSync(join(tmpdir(), 'wir-up-page-'));
  const upDir = mkdtempSync(join(tmpdir(), 'wir-up-files-'));
  writeFileSync(join(pageDir, 'a.html'), PAGE);
  for (const f of files) writeFileSync(join(upDir, f), 'x');
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null, uploadDir: upDir });
  try {
    await session.goto(`file://${join(pageDir, 'a.html')}`);
    const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    const input = (ov['controls'] ?? []).find((c: any) => /file|Document|Choose/i.test(String(c.name ?? '')))
      ?? (ov['controls'] ?? [])[0];
    assert.ok(input, `precondition: the file input compiled: ${JSON.stringify(ov['controls'])}`);
    await fn(session, input.ref);
  } finally { await session.close(); }
}

test('a wrong filename is told what is there, with a call that works', async () => {
  await withUploadDir(['doc.txt', 'report.pdf'], async (s, ref) => {
    const r = await s.dispatch(
      { verb: 'act', ref, action: 'upload', value: 'guess.txt' }) as Record<string, any>;
    assert.equal(r['rejected']?.kind, 'invalid_args');
    const reason = String(r['rejected']?.reason);
    assert.match(reason, /doc\.txt/, `it names what IS available: ${reason}`);
    assert.match(reason, /report\.pdf/, 'all of it, when it fits');

    // The repair must be honourable — a computable continuation that rejects is
    // the C4 class this repo has paid for before.
    const call = JSON.parse(String(r['rejected']?.repair)) as Record<string, unknown>;
    assert.equal(call['action'], 'upload');
    const second = await s.dispatch(call as never) as Record<string, any>;
    assert.equal(second['rejected'], undefined,
      `the offered call must work: ${JSON.stringify(second['rejected'])}`);
    assert.equal(second['effect']?.evidence, 'file_attached');
  });
});

test('the listing is bounded and says how many it withheld', async () => {
  // Never a silent truncation, the same rule every other list here follows.
  const many = Array.from({ length: 14 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  await withUploadDir(many, async (s, ref) => {
    const r = await s.dispatch(
      { verb: 'act', ref, action: 'upload', value: 'nope.txt' }) as Record<string, any>;
    const reason = String(r['rejected']?.reason);
    assert.match(reason, /\(\+\d+ more\)/, `the residual is exact: ${reason}`);
  });
});

test('CONTROL — a path is still refused, and never listed around', async () => {
  // The fence is the point. If disclosure ever became a way to reach outside the
  // directory, it would be an exfiltration primitive driven by page text.
  await withUploadDir(['doc.txt'], async (s, ref) => {
    for (const bad of ['../secret.txt', '/etc/passwd', 'sub/doc.txt']) {
      const r = await s.dispatch(
        { verb: 'act', ref, action: 'upload', value: bad }) as Record<string, any>;
      assert.equal(r['rejected']?.kind, 'invalid_args', `${bad} is refused`);
      assert.match(String(r['rejected']?.reason), /bare filename|escapes/,
        `${bad} is refused for its SHAPE, before any lookup: ${r['rejected']?.reason}`);
    }
  });
});

test('CONTROL — an empty directory promises nothing', async () => {
  // No files means no repair. Offering one would be a call that cannot be honoured.
  await withUploadDir([], async (s, ref) => {
    const r = await s.dispatch(
      { verb: 'act', ref, action: 'upload', value: 'anything.txt' }) as Record<string, any>;
    assert.match(String(r['rejected']?.reason), /empty/,
      `it says so plainly: ${r['rejected']?.reason}`);
    assert.doesNotMatch(String(r['rejected']?.repair), /"verb":"act"/,
      'and offers no act call it cannot honour');
  });
});
