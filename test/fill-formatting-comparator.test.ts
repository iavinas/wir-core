// Regression for fill's byte-equality comparator (reproduced on the LIVE
// cleave.js demo, debug/probe_fill_mask.mjs, 2026-08-13): a value-normalizing
// input rewrites the text as it arrives — "4111111111111111" reads back
// "4111 1111 1111 1111" — and byte equality minted contradicted/value_mismatch
// on a write that landed. Three correct writes, three contradicted, on one page.
//
// The rule under pin (stated in full at the comparator in core/act.ts):
//   - byte equality                        -> verified/value_set, unchanged;
//   - same letters and digits (any script), different dressing
//                                          -> verified, BOTH strings verbatim
//                                             in the delta;
//   - content dropped/substituted          -> contradicted, exactly as before.
//
// The fixture formatter is inline (a digit-grouping input handler) because the
// probe already proved the class on the real page; what the test pins is the
// comparator, deterministically. The CJK case pins the Unicode property class:
// an ASCII [a-z0-9] would strip two DIFFERENT non-Latin strings to "" and mint
// a false verified by construction.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>masks</title><h1>Payment</h1>
  <label for="card">Card number</label><input id="card" type="text">
  <label for="strict">Strict field</label><input id="strict" type="text">
  <label for="swap">Swap field</label><input id="swap" type="text">
  <label for="trunc">Trunc field</label><input id="trunc" type="text">
  <script>
    // A grouping mask, cleave-shaped: digits only, a space every four.
    card.addEventListener('input', function () {
      this.value = this.value.replace(/\\D/g, '').replace(/(\\d{4})(?=\\d)/g, '$1 ');
    });
    // A field that SUBSTITUTES content — beyond formatting, must contradict.
    swap.addEventListener('input', function () { this.value = '\u53e6\u5916'; });
    // A field that DROPS the request's last character. When that character is
    // non-alphanumeric the stripped forms still agree — which is exactly how a
    // windowed editor's readback fooled the first cut of this comparator — so
    // this pins insertions-only: a deletion is never dressing.
    trunc.addEventListener('input', function () { this.value = this.value.slice(0, -1); });
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

async function fillByName(
  session: WirSession,
  name: string,
  value: string,
): Promise<{ verdict: string; evidence: string; delta: { before: string; after: string } }> {
  const found = (await session.dispatch({ verb: 'find', name })) as { matches?: { ref: string }[] };
  const ref = found.matches?.[0]?.ref;
  assert.ok(ref, `find ${JSON.stringify(name)} returned a match`);
  const acted = (await session.dispatch({ verb: 'act', ref, action: 'fill', value })) as {
    effect?: { verdict: string; evidence: string; delta: { before: string; after: string } };
    rejected?: unknown;
  };
  assert.equal(
    acted.rejected,
    undefined,
    `fill was not rejected: ${JSON.stringify(acted.rejected)}`,
  );
  assert.ok(acted.effect, 'fill returned an effect');
  return acted.effect as {
    verdict: string;
    evidence: string;
    delta: { before: string; after: string };
  };
}

test('a formatting readback verifies, with both strings verbatim in the delta', async () => {
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
    const effect = await fillByName(session, 'Card number', '4111111111111111');
    assert.equal(effect.verdict, 'verified');
    assert.equal(effect.evidence, 'value_set');
    assert.ok(
      effect.delta.after.includes('"4111 1111 1111 1111"'),
      `the delta carries the field's own formatting verbatim: ${effect.delta.after}`,
    );
    assert.ok(
      effect.delta.after.includes('"4111111111111111"'),
      `the delta carries the requested value verbatim: ${effect.delta.after}`,
    );
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});

test('dropped or substituted content still contradicts; byte equality is unchanged', async () => {
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
    // The mask drops every character: nothing left to compare, contradicted stays.
    const dropped = await fillByName(session, 'Card number', 'not a number');
    assert.equal(dropped.verdict, 'contradicted');
    assert.equal(dropped.evidence, 'value_mismatch');
    // Different non-Latin content: an ASCII strip would read both as "" and
    // mint a false verified; the Unicode class must contradict.
    const swapped = await fillByName(session, 'Swap field', '\u5de5\u5177');
    assert.equal(swapped.verdict, 'contradicted');
    assert.equal(swapped.evidence, 'value_mismatch');
    // A dropped trailing "!" leaves the stripped forms equal; insertions-only
    // must still contradict \u2014 a deletion is never dressing.
    const truncated = await fillByName(session, 'Trunc field', 'hello!');
    assert.equal(truncated.verdict, 'contradicted');
    assert.equal(truncated.evidence, 'value_mismatch');
    // Byte equality: verified with no reformatting note appended.
    const strict = await fillByName(session, 'Strict field', 'hello');
    assert.equal(strict.verdict, 'verified');
    assert.equal(strict.evidence, 'value_set');
    assert.equal(strict.delta.after, 'value="hello"');
  } finally {
    await session.close().catch(() => undefined);
    server.close();
  }
});
