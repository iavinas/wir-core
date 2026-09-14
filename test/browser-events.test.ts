// Regressions for defect C3 (next-level.md §3.1): dialogs, popups and downloads
// were silently swallowed — Playwright's default dismissed every confirm() for
// the model, invisibly, and the act then read `unknown`. A live hidden limit in
// the kill-criterion sense. Live-site probe acceptance queued for the reddit
// window (docs/plans/v1-path-spec.md).
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

async function startOn(html: string): Promise<{ session: WirSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-events-'));
  writeFileSync(join(dir, 'a.html'), html);
  writeFileSync(join(dir, 'b.html'), '<!doctype html><title>b</title><h1>Page B</h1>');
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
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

test('a confirm()-guarded control names the dialog and its disposition', async () => {
  const { session } = await startOn(`<!doctype html><title>a</title><h1>Host</h1>
    <a href="#" id="del">Delete everything</a>
    <script>del.addEventListener('click', e => { e.preventDefault();
      if (confirm('Really delete everything?')) document.title = 'deleted'; });</script>`);
  try {
    const acted = await clickByName(session, 'Delete everything');
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { before: string };
    };
    assert.equal(effect.evidence, 'dialog_dismissed', JSON.stringify(acted));
    assert.equal(effect.verdict, 'unknown');
    assert.match(effect.delta.before, /confirm/);
    assert.match(effect.delta.before, /Really delete everything\?/);
  } finally {
    await session.close();
  }
});

test('a target=_blank link reads popup_opened, not no_navigation_observed', async () => {
  const { session, dir } = await startOn('');
  try {
    writeFileSync(
      join(dir, 'a.html'),
      `<!doctype html><title>a</title><h1>Host</h1><a href="file://${dir}/b.html" target="_blank">open elsewhere</a>`,
    );
    await session.goto(`file://${dir}/a.html`);
    const acted = await clickByName(session, 'open elsewhere');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.evidence, 'popup_opened', JSON.stringify(acted));
    assert.equal(effect.verdict, 'verified');
  } finally {
    await session.close();
  }
});

test('a download link reads download_started with the filename', async () => {
  const { session, dir } = await startOn('');
  try {
    writeFileSync(
      join(dir, 'a.html'),
      `<!doctype html><title>a</title><h1>Host</h1>
       <a href="data:text/plain,hello" download="report.txt">Export report</a>`,
    );
    await session.goto(`file://${dir}/a.html`);
    const acted = await clickByName(session, 'Export report');
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { after: string };
    };
    assert.equal(effect.evidence, 'download_started', JSON.stringify(acted));
    assert.match(effect.delta.after, /report\.txt/);
  } finally {
    await session.close();
  }
});
