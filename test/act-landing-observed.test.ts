// Where an act LANDED is observed, so `navigate` back to it must not be refused.
//
// Reported by a hand driver on sweep task 282: an `act` click landed on a URL, the
// next turn's `navigate` to that exact URL was rejected "limited to URLs already
// observed", and the identical call succeeded after one intervening `read`. The
// cause was mechanical — seenUrls was fed by goto and by COMPILE (graph.url plus
// every compiled href), so a destination reached by ACTING existed nowhere in the
// closure until something recompiled.
//
// The runtime had already told the model where it was, in the act's own URL delta.
// A closure that then denies it is the runtime contradicting itself, and it costs a
// call to work around — the driver spent one `read` doing exactly that.
//
// Third instance in one day of a single question answered by two closures that
// disagreed: navigate-vs-host-origins (test/origin-confinement.test.ts) and
// find-vs-act over which node a name means (test/structured-input-fill.test.ts).
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

test('navigate accepts the URL an act just landed on, with no read in between', async () => {
  const srv = await new Promise<{ url: string; close: () => void }>((resolve) => {
    // The link points at /go, which REDIRECTS to /second. That matters: seenUrls
    // is also fed from every compiled href, so a fixture whose link points
    // straight at the destination passes with or without the fix — the first
    // draft of this test did exactly that and proved nothing. The landing URL has
    // to be one no href ever carried.
    const s: Server = createServer((q, r) => {
      if (q.url === '/go') {
        r.writeHead(302, { location: '/second' });
        r.end();
        return;
      }
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(
        q.url === '/second'
          ? '<!doctype html><title>second</title><h1>Second page</h1>'
          : '<!doctype html><title>first</title><h1>First</h1><a href="/go">Go second</a>',
      );
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    const overview = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const link = (overview['controls'] ?? []).find((c: any) =>
      String(c.name ?? '').includes('Go second'),
    );
    assert.ok(link, 'precondition: the link is in the overview');

    const acted = (await session.dispatch({
      verb: 'act',
      ref: link.ref,
      action: 'click',
    })) as Record<string, any>;
    assert.match(
      String(acted['effect']?.delta?.after ?? ''),
      /\/second/,
      'precondition: the act reports the destination in its own delta',
    );

    // NO read in between. That intervening read is the workaround this removes.
    const nav = (await session.dispatch({ verb: 'navigate', url: `${srv.url}/second` })) as Record<
      string,
      any
    >;
    assert.equal(
      nav['rejected'],
      undefined,
      `a destination the act reported is observed: ${JSON.stringify(nav['rejected'])}`,
    );
  } finally {
    await session.close();
    srv.close();
  }
});
