// A RELOAD OF THE SERVED ADDRESS while a client-side route is shown must be
// refused — not forbidden. The mirror of navigate-served-vs-shown.test.ts.
//
// Reproduced on the live map first (debug/probe_navigate_reload.mjs, the same
// session.dispatch the agent calls; docsV2/plans/evidence/wt-navigate-reload.txt):
// served "/", shown "/directions?engine=…&route=…", six client-side routes,
// documentEpoch identical throughout — then `navigate {url:"http://localhost:3000/"}`
// was ADMITTED, the epoch rolled, and the read after it showed "/#map=…": the
// directions state gone. That is what map 757 and 763 did on develop-v2's
// second arm (row 24 of 757: navigated:true, replaced.clientSideRoute:true),
// after which the model rebuilt the directions address by hand and loaded it
// as a document. The existing guard refused only the shown address; the served
// address is the same loss from the other side.
//
// Same http fixture as its sibling (pushState to another path throws on file://;
// the live map cannot be a test dependency). One page, one condition; the
// control — a reload with nothing routed — shares it.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>routes</title><h1>Places</h1>
  <a id="spa" href="/directions?engine=foot&route=1,2;3,4">Directions</a>
  <script>
    spa.addEventListener('click', (e) => {
      e.preventDefault();
      history.pushState({}, '', spa.getAttribute('href'));
    });
  </script>`;

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

type Block = {
  servedUrl: string;
  shownUrl: string;
  callsSinceServed: number;
  routesSinceServed: number;
  lastRoute: string | null;
};
type Rejected = { kind: string; reason: string; repair: string };

async function linkRef(session: WirSession, name: string): Promise<string> {
  const page = await session.dispatch({ verb: 'read' });
  const controls = page['controls'] as { ref: string; role: string; name: string }[];
  const hit = controls.find((c) => c.role === 'link' && c.name.includes(name));
  assert.ok(hit, `no link named ${name}: ${JSON.stringify(controls).slice(0, 400)}`);
  return hit.ref;
}

test('navigate to the served address while a client-side route is shown is refused; force reloads; nothing routed reloads', async () => {
  const site = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'NAVIGATE',
    storageStatePath: null,
  });
  try {
    await session.goto(site.url);
    const home = await session.dispatch({ verb: 'read' });
    assert.equal((home['document'] as Block).shownUrl, site.url);

    // THE CONTROL FIRST: nothing routed, a reload of the served address is admitted.
    const plain = await session.dispatch({ verb: 'navigate', url: site.url });
    assert.equal(
      plain['navigated'],
      true,
      `shown == served: a reload is not the losing move: ${JSON.stringify(plain).slice(0, 300)}`,
    );
    const reloaded = await session.dispatch({ verb: 'read' });
    assert.equal((reloaded['document'] as Block).routesSinceServed, 0);

    // The page routes on top of the served document without a load.
    const act = await session.dispatch({
      verb: 'act',
      action: 'click',
      ref: await linkRef(session, 'Directions'),
    });
    assert.equal(
      act['documentEpoch'],
      reloaded['documentEpoch'],
      'the fixture must not replace the document, or it tests nothing',
    );
    const routed = act['document'] as Block;
    assert.equal(routed.servedUrl, site.url, 'served stays: no document was loaded');
    assert.match(routed.shownUrl, /\/directions\?engine=foot/, 'shown moved');
    assert.equal(routed.routesSinceServed, 1);

    // THE LOSING MOVE: the served document's own address.
    const refused = await session.dispatch({ verb: 'navigate', url: site.url });
    const rejected = refused['rejected'] as Rejected | undefined;
    assert.equal(
      rejected?.kind,
      'navigate_would_discard_shown_state',
      `expected the typed refusal, got ${JSON.stringify(refused).slice(0, 400)}`,
    );
    assert.ok(
      rejected.reason.includes(site.url) && rejected.reason.includes(routed.shownUrl),
      `the reason names both addresses: ${rejected.reason}`,
    );
    assert.match(rejected.reason, /1 route change/, 'the reason counts what would be lost');
    assert.match(rejected.repair, /force/, 'the repair says an override exists');
    assert.doesNotMatch(
      rejected.repair,
      /"force":\s*true/,
      'the repair does not spell out the forced call',
    );
    const still = await session.dispatch({ verb: 'read' });
    assert.equal(still['documentEpoch'], reloaded['documentEpoch'], 'a refusal loads nothing');
    assert.equal((still['document'] as Block).shownUrl, routed.shownUrl, 'the shown state is kept');

    // force:true is the model's decision, honoured verbatim and disclosed.
    const forced = await session.dispatch({ verb: 'navigate', url: site.url, force: true });
    assert.equal(forced['navigated'], true, JSON.stringify(forced).slice(0, 300));
    assert.notEqual(
      forced['documentEpoch'],
      reloaded['documentEpoch'],
      'a real load rolls the epoch',
    );
    const rep = forced['replaced'] as Block & { clientSideRoute: boolean; addressShown: boolean };
    assert.equal(rep.clientSideRoute, true);
    assert.equal(rep.shownUrl, routed.shownUrl, 'replaced names the state the load discarded');
    const loaded = forced['document'] as Block;
    assert.equal(loaded.servedUrl, site.url);
    assert.equal(loaded.shownUrl, site.url, 'the shown state is gone');
    assert.equal(loaded.routesSinceServed, 0);
  } finally {
    await session.close();
    site.close();
  }
});
