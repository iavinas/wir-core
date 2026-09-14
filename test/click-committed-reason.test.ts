// Regression for the click-tail unknown's missing `committed` clause
// (reproduced in debug/probe_click_committed_reason.mjs, 2026-08-13): the
// reason enumerated navigation, document request, target state and mutation
// records — but not the committed application requests. A click whose fetch
// POST was answered 200 with zero DOM mutations cannot mint request_committed
// (that arm requires a positive count), so it falls to the final unknown, and
// before the fix its reason was byte-identical to a click that did nothing at
// all. Transparency only: the pin asserts the verdict and evidence do NOT move.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>settings</title><h1>Settings</h1>
  <button id="save">Save changes</button>
  <button id="inert">Do nothing</button>
  <script>
    save.addEventListener('click', () => {
      fetch('/save', { method: 'POST', body: 'theme=dark' });
    });
  </script>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/save') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
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

async function clickByName(
  session: WirSession,
  name: string,
): Promise<{ verdict: string; evidence: string; reason?: string }> {
  const found = (await session.dispatch({ verb: 'find', role: 'button', name })) as {
    matches?: { ref: string }[];
  };
  const ref = found.matches?.[0]?.ref;
  assert.ok(ref, `find ${JSON.stringify(name)} returned a match`);
  const acted = (await session.dispatch({ verb: 'act', ref, action: 'click' })) as {
    effect?: { verdict: string; evidence: string; reason?: string };
    rejected?: unknown;
  };
  assert.equal(
    acted.rejected,
    undefined,
    `click was not rejected: ${JSON.stringify(acted.rejected)}`,
  );
  assert.ok(acted.effect, 'click returned an effect');
  return acted.effect as { verdict: string; evidence: string; reason?: string };
}

test('an answered application POST with zero mutations is named in the unknown reason', async () => {
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
    const effect = await clickByName(session, 'Save changes');
    // Transparency only: the verdict and evidence hold still.
    assert.equal(effect.verdict, 'unknown');
    assert.equal(effect.evidence, 'no_observable_change_yet');
    assert.ok(effect.reason, 'the unknown carries a reason');
    assert.match(
      effect.reason as string,
      /an application POST to \S+\/save was answered 200 in this act's window, yet nothing changed on the page/,
      `the reason names the answered submit: ${effect.reason}`,
    );
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});

test('a click with no request keeps its reason byte-for-byte (control)', async () => {
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
    const effect = await clickByName(session, 'Do nothing');
    assert.equal(effect.verdict, 'unknown');
    assert.equal(effect.evidence, 'no_observable_change_yet');
    assert.equal(
      effect.reason,
      'no navigation started; no document request was seen; ' +
        "the target's own state did not change; 0 mutation records followed the dispatch",
    );
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});
