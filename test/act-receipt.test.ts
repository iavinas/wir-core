// Regression for the act receipt (core/receipt.ts), reproduced on the LIVE
// containers before this file existed (debug/probe_act_receipt.mjs, artifacts
// under debug/runs/probe/2026-09-02T10-4*-act-receipt-*):
//   GitLab invite modal — the act answered `verified / navigation_get [GET
//     request answered 200]` and nothing about the POST
//     /api/v4/projects/183/invitations {access_level: 30, user_id: "2264"}
//     that added the member (the mutation the click actually caused).
//   Magento product save — `unknown / no_observable_change_yet` while the
//     browser sent POST /admin/catalog/product/save/... (302) and the redirect
//     GET (200) inside the act's own window.
//   Magento admin sign-in — a Document POST carrying login[password].
// The model never saw the request its act caused; 86 of 104 failed mutations in
// the 812-task corpus mutated on the wrong route or with the wrong fields under a
// `verified` verdict.
//
// An http fixture is justified per the score-program spec: the live pages prove
// the class but cannot hold their bodies and timings still. The shapes below
// are the live ones — an XHR POST with a JSON body whose 2xx triggers a reload
// (GitLab), and a form POST that redirects (Magento).
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';
import { RECEIPT_FIELDS_SHOWN, RECEIPT_REQUESTS_SHOWN } from '../src/receipt.js';

const PAGE = `<!doctype html><title>receipt</title><h1>Members</h1>
  <button id="invite">Invite</button>
  <form method="post" action="/session"><input name="login[username]" value="admin">
    <input type="password" name="login[password]" value="hunter2">
    <input name="form_key" value="k1"><button id="signin">Sign in</button></form>
  <button id="local">Toggle local panel</button>
  <div id="out"></div>
  <script>
    invite.addEventListener('click', () => {
      fetch('/api/v4/projects/183/invitations', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'json', access_level: 30, user_id: '2264' }) })
        .then((r) => { if (r.status === 201) location.reload(); });
    });
    local.addEventListener('click', () => { out.textContent = 'panel toggled'; });
  </script>`;

// A page whose one click fans out into many requests, to exercise the bound.
const FANOUT = `<!doctype html><title>fanout</title>
  <button id="many">Load many</button><div id="out"></div>
  <script>
    many.addEventListener('click', async () => {
      const fields = {}; for (let i = 0; i < 30; i++) fields['f' + i] = 'v' + i;
      await Promise.all(Array.from({ length: 9 }, (_, i) =>
        fetch('/item/' + i, { method: 'POST', body: new URLSearchParams(fields) })));
      out.textContent = 'loaded';
    });
  </script>`;

function serve(): Promise<{ server: Server; url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/v4/projects/183/invitations') {
        res.writeHead(201, { 'content-type': 'application/json' }); res.end('{}'); return;
      }
      if (req.method === 'POST' && req.url === '/session') {
        res.writeHead(302, { location: '/' }); res.end(); return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/item/')) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url === '/fanout' ? FANOUT : PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/`, close: () => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close();
      } });
    });
  });
}

async function startSession(url: string): Promise<WirSession> {
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
    harPath: null, tracePath: null, debugScreenshots: false,
  });
  await session.goto(url);
  return session;
}

async function clickByName(session: WirSession, name: string): Promise<Record<string, unknown>> {
  const found = await session.dispatch({ verb: 'find', name });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `not found: ${name}`);
  return session.dispatch({ verb: 'act', ref, action: 'click' });
}

interface Receipt {
  attribution: string; windowMs: number; total: number;
  requests: { atMs: number; type: string; method: string; url: string; status: number | null;
    body?: { encoding: string; fields: Record<string, string>;
      withheld?: { count: number; continuation: string } } }[];
  withheld?: { count: number; estimated: boolean; unit: string; continuation: string };
}

test('the act result names the POST the click caused, with its JSON fields and status', async () => {
  const { url, close } = await serve();
  const session = await startSession(url);
  try {
    const acted = await clickByName(session, 'Invite');
    const receipt = acted['receipt'] as Receipt;
    assert.equal(receipt.attribution, 'window', JSON.stringify(acted));
    const post = receipt.requests.find(r => r.method === 'POST');
    assert.ok(post, `the invite POST must be in the receipt: ${JSON.stringify(receipt)}`);
    assert.equal(post.url, `${url}api/v4/projects/183/invitations`);
    assert.ok(post.type === 'fetch' || post.type === 'xhr', post.type);
    assert.equal(post.status, 201);
    assert.equal(post.body?.encoding, 'json');
    assert.deepEqual(post.body?.fields, { format: 'json', access_level: '30', user_id: '2264' });
    // Ranking may order, never remove: the mutation is listed first, the reload after.
    assert.equal(receipt.requests[0]?.method, 'POST');
    assert.ok(receipt.requests.some(r => r.type === 'document' && r.method === 'GET'),
      `the reload the 201 triggered is part of the same window: ${JSON.stringify(receipt)}`);
  } finally { await session.close(); close(); }
});

test('a form submit shows its route, its 302, and redacts the password field', async () => {
  const { url, close } = await serve();
  const session = await startSession(url);
  try {
    const acted = await clickByName(session, 'Sign in');
    const receipt = acted['receipt'] as Receipt;
    const post = receipt.requests.find(r => r.method === 'POST');
    assert.ok(post, JSON.stringify(receipt));
    assert.equal(post.url, `${url}session`);
    assert.equal(post.type, 'document');
    assert.equal(post.status, 302);
    assert.equal(post.body?.encoding, 'form');
    assert.deepEqual(post.body?.fields,
      { 'login[username]': 'admin', 'login[password]': '[redacted]', form_key: 'k1' });
  } finally { await session.close(); close(); }
});

test('a click that sends nothing says so; the receipt is a bound with a continuation that reaches everything', async () => {
  const { url, close } = await serve();
  const quietSession = await startSession(url);
  try {
    const quiet = await clickByName(quietSession, 'Toggle local panel');
    const empty = (quiet['receipt'] as Receipt);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.requests, []);
    assert.equal(empty.withheld, undefined);
  } finally { await quietSession.close(); }
  const session = await startSession(`${url}fanout`);
  try {
    const acted = await clickByName(session, 'Load many');
    const receipt = acted['receipt'] as Receipt;
    assert.equal(receipt.total, 9, JSON.stringify(receipt));
    assert.equal(receipt.requests.length, RECEIPT_REQUESTS_SHOWN);
    assert.equal(receipt.withheld?.count, 9 - RECEIPT_REQUESTS_SHOWN);
    assert.equal(receipt.withheld?.estimated, false);
    const first = receipt.requests[0]!;
    assert.equal(Object.keys(first.body!.fields).length, RECEIPT_FIELDS_SHOWN);
    assert.equal(first.body!.withheld?.count, 30 - RECEIPT_FIELDS_SHOWN);
    // The continuation is the literal next call, and it reaches every request
    // and every field.
    const actRef = acted['actRef'] as string;
    const seen: string[] = [];
    let call = JSON.parse(receipt.withheld!.continuation) as Record<string, unknown>;
    for (let i = 0; i < 5; i++) {
      const page = await session.dispatch(call as never);
      const r = page['receipt'] as { requests: Receipt['requests'] };
      assert.ok(r, JSON.stringify(page));
      for (const q of r.requests) {
        seen.push(q.url);
        assert.equal(Object.keys(q.body!.fields).length, 30, 'the read page carries every field');
      }
      const more = page['withheld'] as { continuation: string } | undefined;
      if (more === undefined) break;
      call = JSON.parse(more.continuation) as Record<string, unknown>;
    }
    assert.equal(seen.length, 9);
    assert.ok(seen.every(u => u.startsWith(`${url}item/`)));
    const unknown = await session.dispatch({ verb: 'read', target: 'a_99' });
    assert.equal((unknown['rejected'] as { kind: string } | undefined)?.kind, 'unknown_ref');
    assert.equal(actRef, 'a_1');
  } finally { await session.close(); close(); }
});
