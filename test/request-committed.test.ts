// Regressions for the request_committed evidence arm (G2, earned by failing
// task 452): a correct, server-persisted mutation via an AJAX-submitted form
// whose only other honest evidence is verified dom_mutated — local-only, so
// the MUTATE finish gate could never accept it (the agent proved the save on
// four pages and could not finish). Admission measurement and pre-registered
// decision rule: docs/research-notes/gate-evidence-g1-2026-08-05.md (rule
// passed: pop(a) on both measurable origins, worst-origin expected false
// mints 0.0313/episode < 0.05). An http fixture is justified inline per the
// score-program spec: no live page produces a deterministic 2xx window, and
// the class's live acceptance (G3: re-run 452) is lane-gated and pending.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>ajax</title><h1>Host</h1>
  <button id="save">Update profile settings</button>
  <button id="local">Toggle local panel</button>
  <div id="out"></div>
  <script>
    // NB: the result div must not be id="status" — named-element access cannot
    // shadow the built-in window.status, and the mutation silently no-ops.
    save.addEventListener('click', () => {
      fetch('/save', { method: 'POST', body: 'homepage=x' })
        .then((r) => { out.textContent = 'saved ' + r.status; });
    });
    local.addEventListener('click', () => { out.textContent = 'panel toggled'; });
  </script>`;

function serve(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/save') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function startSession(
  url: string,
  expectedAction: 'RETRIEVE' | 'MUTATE',
): Promise<WirSession> {
  const session = await WirSession.start({
    headless: true,
    expectedAction,
    storageStatePath: null,
    harPath: null,
    tracePath: null,
    debugScreenshots: false,
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

test('an AJAX submit reads verified request_committed, not bare dom_mutated', async () => {
  const { server, url } = await serve();
  const session = await startSession(url, 'RETRIEVE');
  try {
    const acted = await clickByName(session, 'Update profile settings');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'request_committed');
  } finally {
    await session.close();
    server.close();
  }
});

test('a MUTATE finish citing a request_committed act is accepted', async () => {
  const { server, url } = await serve();
  const session = await startSession(url, 'MUTATE');
  try {
    const acted = await clickByName(session, 'Update profile settings');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(effect.evidence, 'request_committed', JSON.stringify(acted));
    const finish = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [acted['actRef'] as string],
    });
    assert.equal(
      finish['accepted'],
      true,
      `the 452 class must be finishable: ${JSON.stringify(finish)}`,
    );
  } finally {
    await session.close();
    server.close();
  }
});

test('a click with local rendering and NO request still reads dom_mutated', async () => {
  const { server, url } = await serve();
  const session = await startSession(url, 'RETRIEVE');
  try {
    const acted = await clickByName(session, 'Toggle local panel');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    // No candidate request existed — the arm must not mint without one.
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'dom_mutated');
  } finally {
    await session.close();
    server.close();
  }
});
