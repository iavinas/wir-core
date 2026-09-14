// A control the accname algorithm leaves anonymous still has to be addressable.
//
// `find` matches on name. A control with no accessible name therefore cannot be
// reached by the primary query verb at all — and on a real Magento grid that is
// every filter input, which is the one affordance that makes a whole family of
// tasks tractable.
//
// Measured on the live admin review grid
// (http://localhost:7780/admin/review/product/index/):
//   find(role=textbox) -> 10 matches of 536 searched
//   several with name "" and item label literally "undefined undefined"
//   the oracle (page.evaluate, no WIR) showed those same inputs carrying
//   name="review_id", "title", "nickname", "detail"
//
// A strong model recovered by reading the filter ROW and counting columns against
// the header labels — 12 cells aligned by position. That is structural bookkeeping,
// which is the runtime's job, and it is exactly the work a weak model cannot do
// reliably. The recorded haiku run never found the filter at all and counted rows
// by hand across 18 pages until it gave up.
//
// `name` is NOT touched. CLAUDE.md: names are the page's own words by the full
// accname algorithm, never synthesized, never renamed — so the HTML name attribute
// travels as its own field, and only where the accname is empty.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// The grid shape: a header row of column labels, and a filter row whose inputs
// carry only an HTML name. The "undefined undefined" row label is verbatim from
// the live page — Magento renders a broken template there, so the container gives
// the caller nothing either.
const PAGE = `<!doctype html><title>grid</title><h1>Reviews</h1>
  <table>
    <tr><th>ID</th><th>Title</th><th>Nickname</th><th>Review</th></tr>
    <tr aria-label="undefined undefined">
      <td><input type="text" name="review_id"></td>
      <td><input type="text" name="title"></td>
      <td><input type="text" name="nickname"></td>
      <td><input type="text" name="detail"></td>
    </tr>
  </table>
  <label for="q">Search</label><input id="q" type="text" name="query_text">`;

function serve(): Promise<{ server: Server; url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

async function session(): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-anon-'));
  return WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
}

test('an anonymous form control carries its own field name in find', async () => {
  const site = await serve();
  const s = await session();
  try {
    await s.goto(site.url);
    await s.dispatch({ verb: 'read' });
    const found = await s.dispatch({ verb: 'find', role: 'textbox' });
    const matches = found['matches'] as Record<string, unknown>[];

    const anon = matches.filter((m) => String(m['name'] ?? '') === '');
    assert.ok(
      anon.length >= 4,
      `the filter inputs must compile: ${JSON.stringify(found).slice(0, 500)}`,
    );
    const handles = anon.map((m) => m['fieldName']);
    for (const want of ['review_id', 'title', 'nickname', 'detail']) {
      assert.ok(
        handles.includes(want),
        `an anonymous input must say which field it is (${want}): ${JSON.stringify(anon)}`,
      );
    }
  } finally {
    await s.close();
    site.close();
  }
});

// THE CONTROL, and the reason this is a separate field rather than a fallback
// merged into `name`: a control that HAS an accessible name must keep it alone.
// Printing both on every field in the corpus would be noise, and writing the HTML
// attribute into `name` would be synthesizing a name, which the invariant forbids.
test('a control with a real accessible name gets no second handle', async () => {
  const site = await serve();
  const s = await session();
  try {
    await s.goto(site.url);
    await s.dispatch({ verb: 'read' });
    const found = await s.dispatch({ verb: 'find', role: 'textbox' });
    const matches = found['matches'] as Record<string, unknown>[];

    const named = matches.find((m) => String(m['name'] ?? '').includes('Search'));
    assert.ok(named, `the labelled input must compile: ${JSON.stringify(matches)}`);
    assert.equal(
      named['fieldName'],
      undefined,
      `a named control needs no second handle: ${JSON.stringify(named)}`,
    );
    assert.equal(
      named['name'],
      'Search',
      "and its accname is untouched — the page's own word, not the attribute",
    );
  } finally {
    await s.close();
    site.close();
  }
});

// The handle has to survive into read as well, because a caller that reached the
// row through read should not have to re-find to learn which cell is which.
test('read carries the handle too', async () => {
  const site = await serve();
  const s = await session();
  try {
    await s.goto(site.url);
    const page = await s.dispatch({ verb: 'read' });
    const controls = page['controls'] as Record<string, unknown>[];
    const anon = controls.filter((c) => c['role'] === 'textbox' && String(c['name'] ?? '') === '');
    assert.ok(
      anon.some((c) => c['fieldName'] === 'detail'),
      `read must show it as well as find: ${JSON.stringify(anon)}`,
    );
  } finally {
    await s.close();
    site.close();
  }
});
