// Closes C1's residual (cross-lane note, debug/NEXT.md 2026-08-04): evidence
// `navigation` could be a GET — a link-follow in different clothes — yet stayed
// gate-eligible. The executor now observes the main-frame Document request's
// method live (Network.requestWillBeSent in the pre-dispatch window):
// navigation_post proves what NetworkEventEvaluator checks; navigation_get is
// local-only. A real HTTP server is required — file:// cannot carry a POST.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>a</title><h1>Host</h1>
  <button id="go">Follow by script</button>
  <form method="POST" action="/submit"><button id="send">Submit form</button></form>
  <button id="route">Save client-side</button>
  <script>
    go.addEventListener('click', () => { location.href = '/other'; });
    route.addEventListener('click', () => {
      history.pushState({}, '', '/saved');
      const p = document.createElement('p'); p.textContent = 'saved locally';
      document.body.appendChild(p);
    });
  </script>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(302, { location: '/done' }); res.end(); return;
    }
    const body = req.url === '/'
      ? PAGE
      : `<!doctype html><title>${req.url}</title><h1>Page ${req.url}</h1>`;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve({ server, base: `http://127.0.0.1:${addr.port}` });
  }));
}

async function clickByName(session: WirSession, name: string): Promise<Record<string, unknown>> {
  const found = await session.dispatch({ verb: 'find', name });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `not found: ${name}`);
  return session.dispatch({ verb: 'act', ref, action: 'click' });
}

function artifactPaths(): { harPath: string; tracePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wir-navm-'));
  return { harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip') };
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

test('a script GET navigation reads navigation_get and cannot prove a mutation', async () => {
  const { server, base } = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
    ...artifactPaths(), debugScreenshots: false,
  });
  try {
    await session.goto(`${base}/`);
    const acted = await clickByName(session, 'Follow by script');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.evidence, 'navigation_get', JSON.stringify(acted));
    assert.equal(effect.verdict, 'verified');

    const finish = await session.dispatch({
      verb: 'finish', answer: '', evidenceRefs: [acted['actRef'] as string],
    });
    assert.equal((finish['rejected'] as { kind: string } | undefined)?.kind, 'finish_rejected',
      `an observed GET must not prove a mutation: ${JSON.stringify(finish)}`);
  } finally {
    await session.close();
    await closeServer(server);
  }
});

test('a form POST reads navigation_post and satisfies the MUTATE gate', async () => {
  const { server, base } = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
    ...artifactPaths(), debugScreenshots: false,
  });
  try {
    await session.goto(`${base}/`);
    const acted = await clickByName(session, 'Submit form');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.evidence, 'navigation_post', JSON.stringify(acted));
    assert.equal(effect.verdict, 'verified');

    const finish = await session.dispatch({
      verb: 'finish', answer: '', evidenceRefs: [acted['actRef'] as string],
    });
    assert.equal(finish['accepted'], true,
      `an observed POST is mutation proof: ${JSON.stringify(finish)}`);
  } finally {
    await session.close();
    await closeServer(server);
  }
});

test('a pushState route cannot mint gate-eligible navigation (review B1)', async () => {
  const { server, base } = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
    ...artifactPaths(), debugScreenshots: false,
  });
  try {
    await session.goto(`${base}/`);
    const acted = await clickByName(session, 'Save client-side');
    const effect = acted['effect'] as { verdict: string; evidence: string; delta: { after: string } };
    assert.notEqual(effect.evidence, 'navigation',
      `zero bytes reached the server; this must not read as navigation: ${JSON.stringify(acted)}`);
    assert.equal(effect.evidence, 'dom_mutated', JSON.stringify(acted));
    assert.match(effect.delta.after, /without document replacement/);

    const finish = await session.dispatch({
      verb: 'finish', answer: '', evidenceRefs: [acted['actRef'] as string],
    });
    assert.equal((finish['rejected'] as { kind: string } | undefined)?.kind, 'finish_rejected',
      `a client-side route must not prove a mutation: ${JSON.stringify(finish)}`);
  } finally {
    await session.close();
    await closeServer(server);
  }
});
