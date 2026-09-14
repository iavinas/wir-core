// Regression for select's write-time verdict (reproduced in
// debug/probe_select_settle.mjs, 2026-08-13): the verdict was `chosen.ok` —
// `this.value === opt.value` at WRITE time, inside the dispatch — while the
// post-settle readValue went only into the delta. A page that accepts the
// change event and reverts the control during the settle (a controlled select
// rejecting the change, a validator resetting an unavailable option) minted
// `verified / option_selected` while the same response's delta printed
// `value=""`. The verdict now reads the settled page, as fill does.
//
// The fixture is justified the same way the probe's is: the live Ember form —
// the one recorded reverter — holds its value since the prototype-setter fix
// (probed 2026-08-13: #country held "US" after the act), so no stress page
// still produces the condition.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>shipping</title><h1>Shipping</h1>
  <label for="method">Shipping method</label>
  <select id="method">
    <option value="">Choose…</option>
    <option value="standard">Standard</option>
    <option value="express">Express</option>
  </select>
  <label for="color">Colour</label>
  <select id="color">
    <option value="">Choose…</option>
    <option value="red">Red</option>
    <option value="blue">Blue</option>
  </select>
  <script>
    // Express is temporarily unavailable: the page accepts the change event,
    // then reverts the control while the act is still settling.
    document.getElementById('method').addEventListener('change', function () {
      if (this.value === 'express') setTimeout(() => { this.value = ''; }, 50);
    });
  </script>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    }),
  );
}

async function selectByName(
  session: WirSession,
  name: string,
  value: string,
): Promise<{ verdict: string; evidence: string; delta: { before: string; after: string } }> {
  const found = (await session.dispatch({ verb: 'find', name })) as { matches?: { ref: string }[] };
  const ref = found.matches?.[0]?.ref;
  assert.ok(ref, `find ${JSON.stringify(name)} returned a match`);
  const acted = (await session.dispatch({ verb: 'act', ref, action: 'select', value })) as {
    effect?: { verdict: string; evidence: string; delta: { before: string; after: string } };
    rejected?: unknown;
  };
  assert.equal(
    acted.rejected,
    undefined,
    `select was not rejected: ${JSON.stringify(acted.rejected)}`,
  );
  assert.ok(acted.effect, 'select returned an effect');
  return acted.effect as {
    verdict: string;
    evidence: string;
    delta: { before: string; after: string };
  };
}

test('a select the page reverts during the settle contradicts, and says both readings', async () => {
  const { server, base } = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: null,
    tracePath: null,
    debugScreenshots: false,
  });
  try {
    await session.goto(`${base}/`);
    const effect = await selectByName(session, 'Shipping method', 'Express');
    assert.notEqual(
      effect.verdict,
      'verified',
      `a reverted select must never read verified (got ${effect.verdict}/${effect.evidence})`,
    );
    assert.equal(effect.verdict, 'contradicted');
    assert.equal(effect.evidence, 'selection_mismatch');
    assert.ok(
      effect.delta.after.includes('value=""'),
      `the delta reads the settled page: ${effect.delta.after}`,
    );
    assert.ok(
      effect.delta.after.includes('the page reverted it during the settle'),
      `the delta keeps the write-time reading: ${effect.delta.after}`,
    );
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});

test('a select the page accepts keeps its verdict (control)', async () => {
  const { server, base } = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: null,
    tracePath: null,
    debugScreenshots: false,
  });
  try {
    await session.goto(`${base}/`);
    const effect = await selectByName(session, 'Colour', 'Blue');
    assert.equal(effect.verdict, 'verified');
    assert.equal(effect.evidence, 'option_selected');
    assert.equal(effect.delta.after, 'value="blue" label="Blue"');
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});
