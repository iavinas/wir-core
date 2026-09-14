// Regression for the XHR-then-self-reload class, reproduced on the LIVE gitlab
// container before this file existed (debug/probe_659_invite.mjs, headless,
// offsets from script start): click the invite modal's "Invite" →
// POST xhr /api/v4/projects/183/invitations +4880 → 201 +5340 → the page's own
// success handler reloads, GET document +5342 → 200 +6130. The act returned at
// +6278 with `unknown / no_observable_change_yet`, after `name="(gone)"`, while
// the oracle (page.evaluate, no WIR) showed the member added. Four recorded
// task-659 acts carry that signature.
//
// The cause was a sampling point, not a missing signal: at the first document
// settle check the reload had not been issued yet (documentRequestId null, the
// wait skipped), and by the time the 1.5 s request-correlation wait released on
// the 201, the reload HAD been issued and nothing looked again. core/act.ts now
// samples the document request twice against ONE deadline.
//
// An http fixture is justified here per the score-program spec: the live page
// proves the class but cannot hold its timings still, and the two controls below
// need a server that answers on command. The delays are the live measurement's
// shape, not round numbers picked to pass — the POST must answer AFTER the 400 ms
// settle (or `navigationStarted` short-circuits the whole question through the
// load wait) and the reloaded document must answer slowly enough that the old
// code genuinely misses the commit, exactly as it did on GitLab.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>members</title><h1>Members</h1>
  <button id="commit">Invite</button>
  <button id="ping">Ping only</button>
  <button id="silent">Send unanswered</button>
  <script>
    commit.addEventListener('click', () => {
      fetch('/invite', { method: 'POST', body: 'user=x' })
        .then((r) => { if (r.status === 201) location.reload(); });
    });
    // No reload: the request is answered 2xx and the page keeps its document.
    ping.addEventListener('click', () => {
      fetch('/ping', { method: 'POST', body: 'x' }).catch(() => {});
    });
    // Sent and never answered: no 2xx, no reload, nothing to see.
    silent.addEventListener('click', () => {
      fetch('/silent', { method: 'POST', body: 'x' }).catch(() => {});
    });
  </script>`;

function serve(): Promise<{ server: Server; url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/invite') {
        // Answered after the act's 400 ms same-tick settle, as on the live site.
        setTimeout(() => {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end('{}');
        }, 900);
        return;
      }
      if (req.method === 'POST' && req.url === '/ping') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.url === '/silent') return; // socket held open, never answered
      // The document — slow enough that a commit missed at classification time
      // stays missed, which is what made the live defect visible.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE);
      }, 1_200);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => {
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

async function start(url: string): Promise<WirSession> {
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
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

test('an XHR-committed click whose page then reloads itself reports the replacement', async () => {
  const { url, close } = await serve();
  const session = await start(url);
  try {
    const before = session.currentEpoch();
    const acted = await clickByName(session, 'Invite');
    const effect = acted['effect'] as { verdict: string; evidence: string };

    // Ground truth first: the document really was replaced during that act.
    assert.notEqual(session.currentEpoch(), before, 'precondition: the reload committed');
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(effect.evidence, 'navigation_get', JSON.stringify(acted));
    // And the act must not have told the model that nothing happened.
    assert.doesNotMatch(
      String((acted['effect'] as { delta: { after: string } }).delta.after),
      /\(gone\)/,
      'the dead-node delta is the defect signature',
    );
  } finally {
    await session.close();
    close();
  }
});

test('CONTROL — a 2xx XHR with NO document replacement still mints nothing', async () => {
  // This one is expected to pass with and without the fix; that IS its job.
  // Same request shape, same act window, same 2xx — only the reload differs.
  // If the second sample ever starts manufacturing a navigation, or if this
  // gets widened into minting request_committed off a bare 2xx (the arm at
  // core/act.ts is deliberately still gated behind observed mutations, and the
  // G1 bound for a wider population has never been re-derived), this fails.
  const { url, close } = await serve();
  const session = await start(url);
  try {
    const before = session.currentEpoch();
    const acted = await clickByName(session, 'Ping only');
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(session.currentEpoch(), before, 'precondition: same document');
    assert.equal(effect.verdict, 'unknown', JSON.stringify(acted));
    assert.notEqual(effect.evidence, 'navigation_get');
    assert.notEqual(effect.evidence, 'request_committed');
  } finally {
    await session.close();
    close();
  }
});

test('CONTROL — an unanswered request mints nothing and stays bounded', async () => {
  // The other half of the brief's negative: the request is sent and never
  // answered. Nothing was committed and no document moved, so the act must
  // report an honest `unknown` — and must still return, on the correlation
  // wait's own bound, rather than sit on the second document sample.
  //
  // NOT tested here, and said plainly rather than faked: the case where the
  // document request itself never settles, which is what would expose the two
  // samples' shared 10 s deadline. It cannot be driven — the post-act recompile
  // calls page.evaluate, and Playwright blocks that on a pending main-frame
  // navigation, so the episode hangs before any assertion (observed: this file's
  // earlier draft, killed at 240 s). The shared budget is verified by reading
  // core/act.ts, not by this suite.
  const { url, close } = await serve();
  const session = await start(url);
  try {
    const before = session.currentEpoch();
    const t0 = Date.now();
    const acted = await clickByName(session, 'Send unanswered');
    const ms = Date.now() - t0;
    const effect = acted['effect'] as { verdict: string; evidence: string };
    assert.equal(session.currentEpoch(), before, 'precondition: same document');
    assert.equal(effect.verdict, 'unknown', JSON.stringify(acted));
    assert.notEqual(effect.evidence, 'navigation_get');
    assert.ok(ms < 8_000, `the act must stay bounded; it took ${ms}ms`);
  } finally {
    await session.close();
    close();
  }
});
