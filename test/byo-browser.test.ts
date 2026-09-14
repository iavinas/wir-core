// Step 9 acceptance (next-level.md §3.3): a second developer attaches WIR to a
// browser they already run. attach() must drive find/read/act over CDP without
// owning the browser; fromPage() must borrow a page and give it back intact.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { WirSession } from '../src/session.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wir-byo-'));
  writeFileSync(join(dir, 'b.html'), '<!doctype html><title>b</title><h1>Page B</h1>');
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>a</title><h1>Host page</h1><a href="file://${dir}/b.html">to page b</a>`,
  );
  return dir;
}

test('attach drives find/read/act over a separately-launched Chromium and leaves it running', async () => {
  const port = 20000 + (process.pid % 10000); // parallel-safe, deterministic per process
  const external = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  try {
    const dir = fixture();
    const session = await WirSession.attach({
      cdpEndpoint: `http://localhost:${port}`,
      expectedAction: 'RETRIEVE',
    });
    await session.goto(`file://${dir}/a.html`);

    const overview = await session.dispatch({ verb: 'read' });
    const headingCount = (overview['headings'] as unknown[] | undefined)?.length ?? 0;
    assert.ok(headingCount >= 1, JSON.stringify(overview).slice(0, 300));

    const found = await session.dispatch({ verb: 'find', name: 'to page b' });
    const ref = (found['matches'] as { ref: string }[])[0]?.ref;
    assert.ok(ref, 'link not found through attached browser');

    const acted = await session.dispatch({ verb: 'act', ref, action: 'click' });
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'navigated_to_destination');

    await session.close();
    assert.equal(
      external.isConnected(),
      true,
      'closing an attached session must not kill the caller-owned browser',
    );
  } finally {
    await external.close();
  }
});

test('fromPage borrows a page and returns it intact', async () => {
  const browser = await chromium.launch();
  try {
    const dir = fixture();
    const page = await browser.newPage();
    await page.goto(`file://${dir}/a.html`);

    const session = await WirSession.fromPage(page, { expectedAction: 'RETRIEVE' });
    const found = await session.dispatch({ verb: 'find', name: 'to page b' });
    assert.ok((found['matches'] as { ref: string }[])[0]?.ref, JSON.stringify(found).slice(0, 300));

    await session.close();
    assert.equal(await page.title(), 'a', 'the borrowed page must survive session close');
  } finally {
    await browser.close();
  }
});
