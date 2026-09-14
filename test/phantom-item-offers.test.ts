// The ledger never holds an offer for content that rode no response.
//
// Defect D1 (debug/runs/human-shopping/CONFRONTATION-DIAGNOSIS.md, CONFIRMED):
// buildItemIndex ran on every find and pushed a boundedLabel offer for every
// unnamed over-80-char collection item PAGE-WIDE into the shared inline sink,
// while the payload exposes an item only when a match lies inside it. Every
// entry in the continuation ledger is a claim that the runtime is holding
// content the caller has not read; an offer whose ref reached no response is
// a false claim the finish confrontation then spends budget on. Across 51
// recorded confrontations: 146 of 285 characters-offers undelivered, all
// boundedLabel-shaped. Reproduced live before the fix
// (debug/probe_phantom_offers.mjs, gnu.org/licenses/gpl-3.0.html: one narrow
// find, 16 phantoms of 21 offers).
//
// The rule: an item's bound-label offer is minted only when the item's text
// actually rides a delivered payload.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const LONG = (s: string) => `${s} ${'word '.repeat(30)}end.`; // >80 chars, unnamed li
// Two collections of unnamed over-length items; the find below matches a link
// INSIDE exactly one item of the first list and nothing anywhere else — the
// matched item rides the payload as the match's `item`, the other four do not.
const PAGE =
  '<!doctype html><title>t</title><h1>Host</h1>' +
  '<ul style="list-style:none">' +
  `<li><a href="/a">needle-bearing thing</a> ${LONG('alpha item')}</li>` +
  `<li>${LONG('beta unrelated item')}</li>` +
  `<li>${LONG('gamma unrelated item')}</li>` +
  '</ul>' +
  '<ul style="list-style:none">' +
  `<li>${LONG('delta sidebar item')}</li>` +
  `<li>${LONG('epsilon sidebar item')}</li>` +
  '</ul>';

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s: Server = createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });
}

const refsIn = (v: unknown, into: Set<string>): void => {
  if (typeof v === 'string') {
    for (const m of v.matchAll(/n_[0-9a-f]{12,40}/g)) into.add(m[0]);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) refsIn(x, into);
    return;
  }
  if (v && typeof v === 'object') for (const x of Object.values(v)) refsIn(x, into);
};

test('bound-label offers are minted only for items that rode the payload', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    const found = (await session.dispatch({ verb: 'find', name: 'needle-bearing' })) as Record<
      string,
      any
    >;
    assert.equal(found['rejected'], undefined, JSON.stringify(found['rejected']));
    assert.ok((found['matches'] as unknown[]).length >= 1, 'precondition: the needle matches');

    const delivered = new Set<string>();
    refsIn(found, delivered);

    const offers = session.unconsumedContinuations().filter((o) => o.unit === 'characters');
    const phantoms = offers.filter((o) => {
      const target = /"target":"(n_[0-9a-f]{12,40})"/.exec(o.call)?.[1];
      return target !== undefined && !delivered.has(target);
    });
    assert.deepEqual(
      phantoms.map((p) => p.call),
      [],
      'no offer may claim content the caller was never shown',
    );

    // The other half of the promise: an item that DID ride the payload keeps
    // its offer — the fix must not silence real withholding. The match's own
    // item label was cut at 80, and the ledger says so.
    const itemRef = (found['matches'] as any[])
      .map((m) => m['item']?.ref)
      .find((r) => typeof r === 'string');
    assert.ok(
      itemRef,
      `precondition: the match rides inside an item: ${JSON.stringify(found['matches'])}`,
    );
    assert.ok(
      offers.some((o) => o.call.includes(itemRef)),
      `the delivered item's cut label is still accounted for: ${JSON.stringify(offers)}`,
    );
  } finally {
    await session.close();
    srv.close();
  }
});
