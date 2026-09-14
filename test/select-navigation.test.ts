// Regression for the select-spine defect (reproduced live on the WebArena
// shopping container, debug/probe_select_navigate.mjs): a <select> whose change
// handler navigates was reported `verified / option_selected` — a LOCAL value
// change — because the select path returned before the spine installed any
// observer. Measured on http://localhost:7770/beauty-personal-care.html: the
// change caused a main-frame Document GET answered 200 inside the act window and
// the epoch moved E03E85CA3568AF9B75A69065ABEA1217 ->
// C3EFDCA1925E9F8B8AC62C35A56A2EA4, while act reported
// `after: value=null label="Price"` — a value read off a node the navigation had
// already destroyed.
//
// A real HTTP server is required for the same reason commit-attribution.test.ts
// needs one: only a server can hold the navigation open past the act's fixed
// settle, which is what proves the act waits for the browser rather than for its
// own timer.
//
// Three selects, three mechanisms, one page:
//   - location.href on change — the idiom MEASURED on the shopping container
//     (Magento's productListToolbarForm, `post:false`), delayed server-side;
//   - this.form.submit() on a POST form — the idiom that carries a mutation.
//     NOT observed on the shopping container; asserted because the whole point
//     of the fix is that the shared spine, not a select-specific rule, decides
//     which evidence gets minted;
//   - a plain select in a form, changing nothing but its own value — the
//     Postmill forum-picker shape that EARNED the verb (tasks 611/618). It must
//     read exactly as it did before the spine was applied.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Longer than the act's 400 ms fixed settle by enough that no timing slop can
// make this pass by accident, and far under the bounded wait the spine applies.
const SERVER_THINK_MS = 2_500;

const PAGE = `<!doctype html><title>selects</title><h1>Host</h1>
  <label for="sorter">Sort By</label>
  <select id="sorter" onchange="location.href='/sorted?by='+this.value">
    <option value="position">Position</option>
    <option value="price">Price</option>
  </select>
  <form method="POST" action="/apply">
    <label for="filter">Store View</label>
    <select id="filter" name="view" onchange="this.form.submit()">
      <option value="all">All Store Views</option>
      <option value="main">Main Website</option>
    </select>
  </form>
  <form method="POST" action="/submit">
    <label for="forum">Choose a forum</label>
    <select id="forum" name="forum">
      <option value="">(none)</option>
      <option value="books">books</option>
    </select>
  </form>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    // The navigation the change handler starts is answered LATE — past the act's
    // fixed settle. Before the fix the act had no settle at all on this path.
    if (req.url?.startsWith('/sorted')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>sorted</title><h1>Sorted</h1>');
      }, SERVER_THINK_MS);
      return;
    }
    if (req.method === 'POST' && req.url === '/apply') {
      setTimeout(() => {
        res.writeHead(302, { location: '/applied' });
        res.end();
      }, SERVER_THINK_MS);
      return;
    }
    const body =
      req.url === '/' ? PAGE : `<!doctype html><title>${req.url}</title><h1>Page ${req.url}</h1>`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
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
): Promise<Record<string, unknown>> {
  const found = await session.dispatch({ verb: 'find', name, role: 'combobox' });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `not found: ${name} (${JSON.stringify(found['matches'])})`);
  return session.dispatch({ verb: 'act', ref, action: 'select', value });
}

function startSession(): Promise<WirSession> {
  return WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
    harPath: null,
    tracePath: null,
    debugScreenshots: false,
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('a select whose change handler navigates reports the navigation, not a local value', async () => {
  const { server, base } = await serve();
  const session = await startSession();
  try {
    await session.goto(`${base}/`);
    const acted = await selectByName(session, 'Sort By', 'Price');
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { before: string; after: string };
    };
    assert.equal(
      effect.evidence,
      'navigation_get',
      `the document was replaced by a GET; the act must say so: ${JSON.stringify(acted)}`,
    );
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    // The act waited for the browser: the URL it reports is the one that landed,
    // not the one the page still showed when the change handler returned.
    assert.match(effect.delta.after, /\/sorted\?by=price/);
    // Which option matched survives the navigation branch — select-by-label is
    // substring-generous, so the model must still learn what it actually picked.
    assert.match(effect.delta.after, /selected "Price"/);
    // A GET navigation is local-only evidence by design: it proves a link-follow,
    // never a site mutation. The gate must not spend it.
    const finish = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [acted['actRef'] as string],
    });
    assert.equal(
      (finish['rejected'] as { kind: string } | undefined)?.kind,
      'finish_rejected',
      `navigation_get is local-only; the gate must refuse it: ${JSON.stringify(finish)}`,
    );
  } finally {
    await session.close();
    await closeServer(server);
  }
});

test('a select that submits its form reaches navigation_post', async () => {
  const { server, base } = await serve();
  const session = await startSession();
  try {
    await session.goto(`${base}/`);
    const acted = await selectByName(session, 'Store View', 'Main Website');
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { after: string };
    };
    assert.equal(
      effect.evidence,
      'navigation_post',
      `the change submitted a POST form: ${JSON.stringify(acted)}`,
    );
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.match(effect.delta.after, /answered 302/);
  } finally {
    await session.close();
    await closeServer(server);
  }
});

test('a select that navigates nothing reads exactly as before — the forum-picker shape', async () => {
  const { server, base } = await serve();
  const session = await startSession();
  try {
    await session.goto(`${base}/`);
    const acted = await selectByName(session, 'Choose a forum', 'books');
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { before: string; after: string };
    };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'option_selected', JSON.stringify(acted));
    assert.equal(effect.delta.before, 'value=""');
    assert.equal(effect.delta.after, 'value="books" label="books"');
  } finally {
    await session.close();
    await closeServer(server);
  }
});
