// SERVED versus SHOWN: navigating to the address the bar already shows, when
// the site never served a document for it, must be refused — not forbidden.
//
// Reproduced on the live map container first (debug/probe.mjs, the same
// session.dispatch the agent calls; debug/runs/probe/2026-09-02T10-52-30-533Z):
// clicking "Find directions" and then Go moved the address from / to
// /directions?engine=...&route=... by pushState with documentEpoch IDENTICAL
// throughout — the site served exactly one document, "/". A `navigate` to the
// address the bar showed then rolled the epoch (BFD491… → 9E78EE…): a document
// load, which the site records as the last page it served. That single move is
// how ten recorded NAVIGATE episodes (map 356, 757-767) reached the graded page
// and lost it — the evaluator wanted "/" as the last navigation and got the
// re-navigation instead.
//
// The runtime now (a) states both facts on every structural envelope —
// document.servedUrl (loaderId-backed) beside document.shownUrl (the bar) —
// and (b) refuses the losing move with a typed rejection that names both and
// offers the literal repairs. force:true does it anyway: only the model knows
// whether its task wants the shown page SERVED or the served page KEPT.
//
// An http fixture is justified per the method rule: pushState to another path
// throws SecurityError on file://, and the live map container cannot be a test
// dependency. One page, one condition; the control (a real load) shares it.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>routes</title><h1>Places</h1>
  <a id="spa" href="/directions?engine=foot&route=1,2;3,4">Directions</a>
  <a id="real" href="/real">A real link</a>
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

type Block = { servedUrl: string; shownUrl: string; callsSinceServed: number;
  routesSinceServed: number; lastRoute: string | null };

async function linkRef(session: WirSession, name: string): Promise<string> {
  const page = await session.dispatch({ verb: 'read' });
  const controls = page['controls'] as { ref: string; role: string; name: string }[];
  const hit = controls.find(c => c.role === 'link' && c.name.includes(name));
  assert.ok(hit, `no link named ${name}: ${JSON.stringify(controls).slice(0, 400)}`);
  return hit.ref;
}

test('navigate to the shown address of a client-side route is refused, and force loads it',
  async () => {
    const site = await serve();
    const session = await WirSession.start({
      headless: true, expectedAction: 'NAVIGATE', storageStatePath: null });
    try {
      await session.goto(site.url);
      const home = await session.dispatch({ verb: 'read' });
      const served = (home['document'] as Block);
      assert.equal(served.servedUrl, site.url, 'the opening goto is the served document');
      assert.equal(served.shownUrl, site.url);
      assert.equal(served.routesSinceServed, 0);

      const ref = await linkRef(session, 'Directions');
      const act = await session.dispatch({ verb: 'act', action: 'click', ref });
      assert.equal(act['documentEpoch'], home['documentEpoch'],
        'the fixture must not replace the document, or it tests nothing');
      const routed = act['document'] as Block;
      assert.equal(routed.servedUrl, site.url, 'served stays: no document was loaded');
      assert.match(routed.shownUrl, /\/directions\?engine=foot/, 'shown moved');
      assert.equal(routed.routesSinceServed, 1);
      assert.equal(routed.lastRoute, 'historyApi');

      // THE LOSING MOVE.
      const shown = routed.shownUrl;
      const refused = await session.dispatch({ verb: 'navigate', url: shown });
      const rejected = refused['rejected'] as { kind: string; reason: string; repair: string };
      assert.equal(rejected?.kind, 'navigate_would_replace_served_document',
        `expected the typed refusal, got ${JSON.stringify(refused).slice(0, 400)}`);
      assert.ok(rejected.reason.includes(site.url) && rejected.reason.includes(shown),
        `the reason names both URLs: ${rejected.reason}`);
      // The repair DESCRIBES the override; it never hands the forced call over
      // pre-formed. Measured on develop-v2's first arm (map 757, 763): with the
      // literal call in the repair, the model re-sent it on the very next turn,
      // 2 of 2, and lost the page both times.
      assert.match(rejected.repair, /force/, 'the repair says an override exists');
      assert.doesNotMatch(rejected.repair, /"force":\s*true/, 'the repair does not spell out the forced call');
      const still = await session.dispatch({ verb: 'read' });
      assert.equal(still['documentEpoch'], home['documentEpoch'], 'a refusal loads nothing');

      // force:true is the model's decision, honoured verbatim.
      const forced = await session.dispatch({ verb: 'navigate', url: shown, force: true });
      assert.equal(forced['navigated'], true, JSON.stringify(forced).slice(0, 300));
      assert.notEqual(forced['documentEpoch'], home['documentEpoch'], 'a real load rolls the epoch');
      const loaded = forced['document'] as Block;
      assert.equal(loaded.servedUrl, shown, 'the served document is now the loaded one');
      assert.equal(loaded.callsSinceServed, 0);
      assert.equal(loaded.routesSinceServed, 0);
    } finally {
      await session.close();
      site.close();
    }
  });

// THE CONTROL. A real navigation must not be refused, and must move servedUrl —
// otherwise the guard is a blanket on every navigate and the ledger a constant.
test('a real link click moves the served document, and navigating there again is not refused',
  async () => {
    const site = await serve();
    const session = await WirSession.start({
      headless: true, expectedAction: 'NAVIGATE', storageStatePath: null });
    try {
      await session.goto(site.url);
      const home = await session.dispatch({ verb: 'read' });
      const ref = await linkRef(session, 'A real link');
      const act = await session.dispatch({ verb: 'act', action: 'click', ref });
      assert.notEqual(act['documentEpoch'], home['documentEpoch'], 'this arm must load a document');
      const block = act['document'] as Block;
      assert.equal(block.servedUrl, `${site.url}real`);
      assert.equal(block.shownUrl, `${site.url}real`);
      assert.equal(block.callsSinceServed, 0);
      const again = await session.dispatch({ verb: 'navigate', url: `${site.url}real` });
      assert.equal(again['navigated'], true,
        `shown == served: a reload is not the losing move: ${JSON.stringify(again).slice(0, 300)}`);
    } finally {
      await session.close();
      site.close();
    }
  });

// A CONSTRUCTED ADDRESS. The path closure alone admitted any query string the
// model composed on a known path; map 757 (develop-v2 arm, 2026-09-02) built
// /directions?route=<coords> twice and each hard load replaced the served
// document. Refused only on a client-side route — the corpus gate found 25
// passes that navigated to a composed ?search=/?q= on server-rendered pages.
test('a composed query address is refused on a client-side route, admitted and disclosed elsewhere',
  async () => {
    const { url, close } = await serve();
    const session = await WirSession.start({ headless: true, expectedAction: 'NAVIGATE', knownUrls: [url] });
    try {
      await session.dispatch({ verb: 'navigate', url });
      await session.dispatch({ verb: 'act', ref: await linkRef(session, 'Directions'), action: 'click' });
      const composed = `${url}directions?engine=foot&route=9,9;8,8`;
      const refused = await session.dispatch({ verb: 'navigate', url: composed });
      assert.equal((refused['rejected'] as { kind: string } | undefined)?.kind, 'navigate_constructed_address',
        JSON.stringify(refused).slice(0, 400));
      const forced = await session.dispatch({ verb: 'navigate', url: composed, force: true });
      assert.equal(forced['navigated'], true, JSON.stringify(forced).slice(0, 400));
      const rep = forced['replaced'] as Block & { clientSideRoute: boolean; addressShown: boolean };
      assert.equal(rep.clientSideRoute, true); assert.equal(rep.addressShown, false);
      assert.equal(rep.servedUrl, url, 'the load replaced the served root document');
      // Control: now standing on a SERVED document, a composed query address is admitted — and disclosed.
      const admitted = await session.dispatch({ verb: 'navigate', url: `${url}directions?engine=car&route=5,5;6,6` });
      assert.equal(admitted['navigated'], true, JSON.stringify(admitted).slice(0, 400));
      const rep2 = admitted['replaced'] as { clientSideRoute: boolean; addressShown: boolean };
      assert.equal(rep2.clientSideRoute, false); assert.equal(rep2.addressShown, false);
    } finally { await session.close(); close(); }
  });
