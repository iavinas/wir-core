// Regression for the fill-spine defect (reproduced in
// debug/probe_fill_navigation.mjs, 2026-08-13): a fill whose OWN input handler
// navigates — search-as-you-type, the page submits on `input` — was reported
// `contradicted / value_mismatch` with `after: value=null`, a value read off a
// node the navigation had already destroyed, in the same response that attached
// the NEW page's landing. select, type, key and click all check movement before
// their local postcondition; fill went straight to the readback.
//
// False contradicted is the defect class that poisoned attempt 6's world model,
// so the pin is one-sided and strict: the navigating fill must mint the same
// navigation evidence its siblings mint, and the non-navigating control must
// keep exactly the verdict it had before the guard existed.
//
// The fixture is justified the same way the probe's is: no browser-use stress
// page navigates on `input` or `keyup` (checked 2026-08-13 — the only search
// field submits on Enter keypress, which fill never sends).
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>search</title><h1>Catalog</h1>
  <form action="/results" method="GET">
    <label for="q">Search products</label>
    <input id="q" name="q" type="search">
  </form>
  <label for="notes">Notes</label>
  <input id="notes" type="text">
  <script>
    document.getElementById('q').addEventListener('input', function () {
      this.form.submit();
    });
  </script>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/results')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>results</title><h1>Results</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve({ server, base: `http://127.0.0.1:${addr.port}` });
  }));
}

async function fillByName(session: WirSession, name: string, value: string):
    Promise<{ verdict: string; evidence: string; delta: { before: string; after: string } }> {
  const found = await session.dispatch({ verb: 'find', name }) as
    { matches?: { ref: string }[] };
  const ref = found.matches?.[0]?.ref;
  assert.ok(ref, `find ${JSON.stringify(name)} returned a match`);
  const acted = await session.dispatch({ verb: 'act', ref, action: 'fill', value }) as
    { effect?: { verdict: string; evidence: string; delta: { before: string; after: string } };
      rejected?: unknown };
  assert.equal(acted.rejected, undefined, `fill was not rejected: ${JSON.stringify(acted.rejected)}`);
  assert.ok(acted.effect, 'fill returned an effect');
  return acted.effect as { verdict: string; evidence: string; delta: { before: string; after: string } };
}

test('a fill whose input handler navigates mints navigation, never contradicted', async () => {
  const { server, base } = await serve();
  const session = await WirSession.start({ headless: true, expectedAction: 'RETRIEVE',
    storageStatePath: null, harPath: null, tracePath: null, debugScreenshots: false });
  try {
    await session.goto(`${base}/`);
    const effect = await fillByName(session, 'Search products', 'squash rackets');
    assert.notEqual(effect.verdict, 'contradicted',
      `a navigating fill must never read contradicted (got ${effect.verdict}/${effect.evidence})`);
    assert.equal(effect.verdict, 'verified');
    assert.equal(effect.evidence, 'navigation_get');
    assert.match(effect.delta.after, /\/results\?q=/,
      'the delta names where the document landed');
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});

test('a plain fill on the same page keeps its value verdict (control)', async () => {
  const { server, base } = await serve();
  const session = await WirSession.start({ headless: true, expectedAction: 'RETRIEVE',
    storageStatePath: null, harPath: null, tracePath: null, debugScreenshots: false });
  try {
    await session.goto(`${base}/`);
    const effect = await fillByName(session, 'Notes', 'plain text');
    assert.equal(effect.verdict, 'verified');
    assert.equal(effect.evidence, 'value_set');
    assert.equal(effect.delta.after, 'value="plain text"');
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});
