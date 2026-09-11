// A document-replacing act's landing overview travels with the same envelope
// a plain read gets — withheld and all.
//
// Proven on a real page first (debug/probe_landing_withheld.mjs,
// news.ycombinator.com): the More click landed on a page of 231 controls,
// the landing showed 50, and the response said nothing about the other 181 —
// `withheld` absent from the wire, the controls-page continuation absent from
// the ledger — while doAct's own comment promised every withheld/moreX
// continuation travels exactly as on a read. The hand-rolled landing envelope
// dropped both, so the finish confrontation could never see that the caller
// left the landing page's controls tail unopened.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const s: Server = createServer((q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      if (q.url === '/second') {
        // 60 links: the landing overview pages at 50 and withholds 10.
        r.end('<!doctype html><title>second</title><h1>Second</h1>'
          + Array.from({ length: 60 }, (_, i) => `<a href="/l${i}">landed ${i}</a>`).join(''));
        return;
      }
      r.end('<!doctype html><title>first</title><h1>First</h1>'
        + '<a href="/second">Go second</a>');
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });
}

test('the landing envelope carries withheld, and the offer is ledgered', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(srv.url);
    const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    const link = (ov['controls'] ?? []).find((c: any) => String(c.name ?? '').includes('Go second'));
    assert.ok(link, 'precondition: the link is in the overview');
    const before = session.currentEpoch();

    const acted = await session.dispatch(
      { verb: 'act', ref: link.ref, action: 'click' }) as Record<string, any>;
    assert.notEqual(session.currentEpoch(), before, 'precondition: the document was replaced');
    assert.equal((acted['landing']?.controls ?? []).length, 50,
      `precondition: the landing pages its controls: ${JSON.stringify(Object.keys(acted))}`);

    // The envelope discloses what the landing withheld, as a read would.
    const withheld = acted['withheld'];
    assert.ok(withheld, `withheld must ride the act response: ${JSON.stringify(Object.keys(acted))}`);
    assert.equal(withheld.count, 10);
    assert.deepEqual(JSON.parse(withheld.continuation), { verb: 'read', cursor: 'c_50' });

    // And the offer is ledgered under the NEW epoch, so the finish
    // confrontation can see the unopened tail.
    const offer = session.unconsumedContinuations()
      .find(o => o.call === withheld.continuation);
    assert.ok(offer, `the landing's controls page is in the ledger: `
      + JSON.stringify(session.unconsumedContinuations()));
    assert.equal(offer.withheldCount, 10);

    // The continuation is live: consuming it delivers the tail.
    const tail = await session.dispatch(JSON.parse(withheld.continuation)) as Record<string, any>;
    assert.equal(tail['rejected'], undefined, JSON.stringify(tail['rejected']));
    assert.equal((tail['controls'] as unknown[]).length, 10);
  } finally {
    await session.close();
    srv.close();
  }
});
