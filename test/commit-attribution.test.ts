// Regression for the commit-attribution defect (reproduced live on WebArena
// gitlab task 442, debug/probe_442_commit.mjs): a form submit whose POST the
// server answers AFTER the act's fixed settle window read
// `unknown/no_observable_change_yet` on a commit that had landed. The captured
// documentMethod was discarded because `navigated` was still false when the
// epoch and URL were sampled — waitForLoadState cannot wait for a pending
// navigation, it answers for the document that is currently committed (the old
// one, already loaded) and returns in ~0 ms. Consequence measured on real
// episodes: no gate-eligible evidence, all six finish attempts refused, budget
// exhausted on work that was already done.
//
// The second half of the same change: the server's ANSWER decides, never the
// request on its own. GitLab refuses a submit with 422 and navigates to the
// error page, so `navigated` is true and the method is POST — which minted
// gate-eligible `verified navigation_post` for a mutation that never happened
// (proved against the pre-fix build in debug/probe_442_reject.mjs: repository
// unchanged, act said verified).
//
// A real HTTP server is required: only a server can hold a POST open past the
// settle window and answer another one 422.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Longer than the act's 400 ms fixed settle by enough that no timing slop can
// make this pass by accident, and far under the bounded wait the fix adds.
const SERVER_THINK_MS = 2_500;

const PAGE = `<!doctype html><title>submit</title><h1>Host</h1>
  <form method="POST" action="/slow"><button id="slow">Commit changes</button></form>
  <form method="POST" action="/refuse"><button id="no">Commit rejected changes</button></form>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/slow') {
      // The shape of a real commit: the server thinks, then redirects (the
      // POST-redirect-GET idiom GitLab uses). The 302 arrives long after the
      // act's fixed settle would have judged the page.
      setTimeout(() => {
        res.writeHead(302, { location: '/done' });
        res.end();
      }, SERVER_THINK_MS);
      return;
    }
    if (req.method === 'POST' && req.url === '/refuse') {
      res.writeHead(422, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><title>rejected</title><h1>The change you requested was rejected</h1>',
      );
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

async function clickByName(session: WirSession, name: string): Promise<Record<string, unknown>> {
  const found = await session.dispatch({ verb: 'find', name });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `not found: ${name}`);
  return session.dispatch({ verb: 'act', ref, action: 'click' });
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

test('a POST answered after the settle window still reads verified navigation_post', async () => {
  const { server, base } = await serve();
  const session = await startSession();
  try {
    await session.goto(`${base}/`);
    const acted = await clickByName(session, 'Commit changes');
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { after: string };
    };
    assert.equal(
      effect.evidence,
      'navigation_post',
      `the commit landed; the act must attribute it: ${JSON.stringify(acted)}`,
    );
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    // The status is what made the verdict, so it travels with the delta.
    assert.match(effect.delta.after, /answered 302/);

    const finish = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [acted['actRef'] as string],
    });
    assert.equal(
      finish['accepted'],
      true,
      `a landed submit must be finishable: ${JSON.stringify(finish)}`,
    );
  } finally {
    await session.close();
    await closeServer(server);
  }
});

test('a POST the server refuses cannot prove a mutation', async () => {
  const { server, base } = await serve();
  const session = await startSession();
  try {
    await session.goto(`${base}/`);
    const acted = await clickByName(session, 'Commit rejected changes');
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { after: string };
    };
    // The document WAS replaced by the error page, so this really did navigate
    // and the evidence still names what happened — only the verdict withholds.
    assert.equal(
      effect.verdict,
      'unknown',
      `a refused submit must never read verified: ${JSON.stringify(acted)}`,
    );
    assert.match(effect.delta.after, /answered 422/);

    const finish = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [acted['actRef'] as string],
    });
    assert.equal(
      (finish['rejected'] as { kind: string } | undefined)?.kind,
      'finish_rejected',
      `the gate must not spend a refused submit: ${JSON.stringify(finish)}`,
    );
  } finally {
    await session.close();
    await closeServer(server);
  }
});
