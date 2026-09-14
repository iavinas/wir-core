// WHAT THE RECEIPT SHOWED IS OBSERVED, and navigate arrives like a link.
//
// Reproduced on the live shopping_admin orders grid first
// (debug/probe_navigate_observed.mjs, the same session.dispatch the agent
// calls; docsV2/plans/evidence/wt-navigate-observed.txt): the grid's Status
// filter sent GET /admin/mui/index/render/?…filters[status]=fraud as an XHR,
// the act receipt showed that address to the model, and `navigate` to it was
// refused "limited to URLs already observed this episode" — the closure was
// fed by goto, the page URL and compiled hrefs, never by the receipt the
// runtime had just printed. For a NAVIGATE task the official evaluator reads
// only the last DOCUMENT the browser loaded, so an address that the page only
// ever fetched in the background can be reached no other way. Two general
// changes, neither about that site:
//   1. every receipt request URL on the origin of the document that made it
//      joins the closure (act result and read {target: actRef} alike);
//   2. host.goto passes the served document as Referer, as a link would, so
//      a server or grader reading Referer sees what a person's arrival shows.
//      The first goto of an episode stays referer-less.
//
// An http fixture is justified per the method rule: the Referer is asserted
// from the SERVER's received headers, which no file:// page can report, and
// the live admin container cannot be a test dependency. One page, one
// condition; the cross-origin control shares it.
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

type Hit = { url: string; referer: string | null; dest: string | null };

function serve(
  page: (other: string) => string,
  other = '',
): Promise<{ server: Server; url: string; hits: Hit[]; close: () => void }> {
  return new Promise((resolve) => {
    const hits: Hit[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      hits.push({
        url: req.url ?? '',
        referer: req.headers['referer'] ?? null,
        dest: (req.headers['sec-fetch-dest'] as string | undefined) ?? null,
      });
      if ((req.url ?? '').startsWith('/api/')) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(other));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/`, hits, close: () => server.close() });
    });
  });
}

const PAGE = (other: string) => `<!doctype html><title>grid</title><h1>Orders</h1>
  <button id="apply">Apply</button>
  <script>
    apply.addEventListener('click', () => {
      fetch('/api/x?y=1');
      fetch(${JSON.stringify(other)} + 'api/elsewhere?z=2', { mode: 'no-cors' });
    });
  </script>`;

async function buttonRef(session: WirSession): Promise<string> {
  const page = await session.dispatch({ verb: 'read' });
  const controls = page['controls'] as { ref: string; role: string; name: string }[];
  const hit = controls.find((c) => c.role === 'button' && c.name === 'Apply');
  assert.ok(hit, `no Apply button: ${JSON.stringify(controls).slice(0, 400)}`);
  return hit.ref;
}

test('a receipt request URL is navigable, and the load arrives with the served page as Referer', async () => {
  // A second origin: the CDN / beacon case the closure keeps out.
  const elsewhere = await serve(() => '<!doctype html>');
  const site = await serve(PAGE, elsewhere.url);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'NAVIGATE',
    storageStatePath: null,
  });
  try {
    await session.goto(site.url);
    const first = site.hits.find((h) => h.url === '/');
    assert.ok(first, 'the fixture was served');
    assert.equal(first.referer, null, 'the opening goto of an episode carries no Referer');

    // BEFORE the act nothing has shown /api/x: the closure refuses it, so the
    // admission below is the receipt's doing and nothing else's.
    const early = await session.dispatch({ verb: 'navigate', url: `${site.url}api/x?y=1` });
    const earlyRejected = early['rejected'] as { kind: string; reason: string } | undefined;
    assert.equal(earlyRejected?.kind, 'invalid_args', JSON.stringify(early).slice(0, 300));
    assert.match(
      earlyRejected.reason,
      /requests the receipts have shown/,
      'the closure names its third source',
    );

    const act = await session.dispatch({
      verb: 'act',
      action: 'click',
      ref: await buttonRef(session),
    });
    assert.equal(act['outcome'], 'delivered', JSON.stringify(act).slice(0, 300));
    const receipt = act['receipt'] as { requests: { url: string; method: string }[] };
    const shown = receipt.requests.map((r) => r.url);
    assert.ok(
      shown.includes(`${site.url}api/x?y=1`),
      `the receipt shows the fetch: ${JSON.stringify(shown)}`,
    );
    assert.ok(
      shown.includes(`${elsewhere.url}api/elsewhere?z=2`),
      `the receipt shows the cross-origin fetch too: ${JSON.stringify(shown)}`,
    );

    // THE CONTROL: shown, but on another origin — not the site's own words.
    const foreign = await session.dispatch({
      verb: 'navigate',
      url: `${elsewhere.url}api/elsewhere?z=2`,
    });
    assert.equal(
      (foreign['rejected'] as { kind: string } | undefined)?.kind,
      'invalid_args',
      `a cross-origin receipt address stays outside the closure: ${JSON.stringify(foreign).slice(0, 300)}`,
    );

    // THE FIX: the address the receipt showed, on the page's own origin.
    const nav = await session.dispatch({ verb: 'navigate', url: `${site.url}api/x?y=1` });
    assert.equal(nav['navigated'], true, JSON.stringify(nav).slice(0, 400));
    const doc = nav['document'] as { servedUrl: string };
    assert.equal(
      doc.servedUrl,
      `${site.url}api/x?y=1`,
      'the receipt address is now the served document',
    );
    const replaced = nav['replaced'] as { servedUrl: string; addressShown: boolean };
    assert.equal(replaced.servedUrl, site.url);
    assert.equal(replaced.addressShown, true, 'the exact address (query included) counts as shown');

    // THE REFERER, from the server's own record of the document GET — the
    // XHR the button sent carries the page as referer natively; the
    // navigation must too.
    const docGets = site.hits.filter((h) => h.url === '/api/x?y=1' && h.dest === 'document');
    assert.equal(
      docGets.length,
      1,
      `one document GET for the address: ${JSON.stringify(site.hits)}`,
    );
    assert.equal(
      docGets[0]?.referer,
      site.url,
      'the load arrived with the page it left as Referer',
    );
  } finally {
    await session.close();
    site.close();
    elsewhere.close();
  }
});
