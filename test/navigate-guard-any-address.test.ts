// ANY ADDRESS loaded while a client-side route is shown must be refused — not
// forbidden. The third guard on `navigate` keyed on the SHOWN address; the
// second on the SERVED one; the first on a composed query. A different path
// from the closure, no query, was none of those and slipped past all three.
//
// Reproduced on the live map first (debug/probe_navigate_guard_fix.mjs, the same
// session.dispatch the agent calls; docsV2/plans/evidence/wt-navigate-guard-fix.txt):
// served "/", shown "/directions?engine=…&route=…", six client-side routes,
// documentEpoch identical throughout — then `navigate {url:"http://localhost:3000/directions"}`
// was ADMITTED, the epoch rolled, and the read after it showed "/directions":
// the routed state gone. That is row 57 of map 763 on develop-v2's fifth arm
// (/home/opc/wir-run-final-v2-arm5/run-read-map/task-763/attempt-1: served "/",
// shown "/node/2500233823", navigated:true, replaced.clientSideRoute:true).
// Map 757 on the same arm did it twice: row 39, the same bare path; row 82,
// served "/directions", shown "/directions?…", and `navigate "/#map=4/40/-95"`
// — a different path plus a fragment — admitted. On the same probe, "/#" and
// "/" were both refused as navigate_would_discard_shown_state before and after
// — 763's admitted reload (row 41) and 757's admitted composed address
// (row 103) each carried force:true from the model, not a guard miss.
//
// Same http fixture as its siblings (pushState to another path throws on
// file://; the live map cannot be a test dependency), plus one real link so a
// different path is in the closure. One page, one condition; the controls —
// a reload with nothing routed, force:true, a load when shown == served —
// share it.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>routes</title><h1>Places</h1>
  <a id="spa" href="/directions?engine=foot&route=1,2;3,4">Directions</a>
  <a id="real" href="/elsewhere">Elsewhere</a>
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

test('every load while a client-side route is shown is refused by address kind; force loads; shown == served loads', async () => {
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

    // CONTROL: nothing routed, a reload of the served address is admitted.
    const plain = await session.dispatch({ verb: 'navigate', url: site.url });
    assert.equal(
      plain['navigated'],
      true,
      `shown == served: a reload is not the losing move: ${JSON.stringify(plain).slice(0, 300)}`,
    );
    const reloaded = await session.dispatch({ verb: 'read' });
    assert.equal((reloaded['document'] as Block).routesSinceServed, 0);

    // The page routes on top of the served document without a load. The read
    // above put the real link's href in the closure.
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

    // THE FOUR SHAPES, in the order the probe sent them. Each is refused by
    // the kind that names its address, loads nothing, and keeps the state.
    const shapes: [string, string, string][] = [
      ['the served address plus a fragment', `${site.url}#`, 'navigate_would_discard_shown_state'],
      ['the served address', site.url, 'navigate_would_discard_shown_state'],
      [
        'a different path in the closure, no query',
        `${site.url}elsewhere`,
        'navigate_would_replace_served_document',
      ],
      [
        'a different path plus a fragment',
        `${site.url}elsewhere#map=4/40/-95`,
        'navigate_would_replace_served_document',
      ],
      [
        'a composed query on a known path',
        `${site.url}directions?engine=car&route=9,9;8,8`,
        'navigate_constructed_address',
      ],
    ];
    for (const [label, url, kind] of shapes) {
      const refused = await session.dispatch({ verb: 'navigate', url });
      const rejected = refused['rejected'] as Rejected | undefined;
      assert.equal(
        rejected?.kind,
        kind,
        `${label}: expected ${kind}, got ${JSON.stringify(refused).slice(0, 400)}`,
      );
      assert.ok(
        rejected.reason.includes(url) && rejected.reason.includes(routed.shownUrl),
        `${label}: the reason names the address asked for and the shown one: ${rejected.reason}`,
      );
      assert.match(rejected.repair, /force/, `${label}: the repair says an override exists`);
      assert.doesNotMatch(
        rejected.repair,
        /"force":\s*true/,
        `${label}: the repair does not spell out the forced call`,
      );
      const still = await session.dispatch({ verb: 'read' });
      assert.equal(
        still['documentEpoch'],
        reloaded['documentEpoch'],
        `${label}: a refusal loads nothing`,
      );
      assert.equal(
        (still['document'] as Block).shownUrl,
        routed.shownUrl,
        `${label}: the shown state is kept`,
      );
    }
    // The different-path refusal says what a load would do to the SERVED record.
    const other = await session.dispatch({ verb: 'navigate', url: `${site.url}elsewhere` });
    const otherRejected = other['rejected'] as Rejected;
    assert.ok(
      otherRejected.reason.includes(site.url),
      `the reason names the served document: ${otherRejected.reason}`,
    );
    assert.match(
      otherRejected.reason,
      /1 time\(s\) since/,
      'the reason counts the routes since the served document',
    );

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

    // CONTROL: shown == served again, a load of a different path is admitted
    // — the guard is on the condition, not a blanket on every navigate.
    const admitted = await session.dispatch({ verb: 'navigate', url: `${site.url}elsewhere` });
    assert.equal(
      admitted['navigated'],
      true,
      `shown == served: a load of another path is not the losing move: ${JSON.stringify(admitted).slice(0, 300)}`,
    );
    const rep2 = admitted['replaced'] as { clientSideRoute: boolean };
    assert.equal(rep2.clientSideRoute, false);
    assert.equal((admitted['document'] as Block).servedUrl, `${site.url}elsewhere`);
  } finally {
    await session.close();
    site.close();
  }
});
