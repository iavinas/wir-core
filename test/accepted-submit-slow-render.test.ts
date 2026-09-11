// Regression for the settle-bound race: the act's VERDICT was decided by whether
// the resulting page had finished RENDERING, not by what the server answered.
//
// Measured, multisite-671/task-671 (network.har, attempts 2/3/6/7/8/9): the
// `POST /submit` was answered 302 in 660/635/655/630/597/938 ms — accepted, every
// time, in under a second — while the REDIRECTED GET of the resulting HTML took
// 13,804/13,690/13,741/13,163/10,182/11,947 ms. The act's document bound is 10 s,
// so the epoch had not moved when the verdict was written and the classification
// fell through to `unknown / no_observable_change_yet`, delta `name="(gone)"`.
// Task 671 is MUTATE: 12 finish rejections reading "MUTATE finish must cite an
// act with effect verdict verified", 6 of 6 attempts scored 0 on a submission the
// server had already accepted. The gate (ADR-003) was right; the act spine lied.
//
// Second half of the same race, from the same corpus: the runtime stopped
// LOOKING at the bound but the act kept WAITING — measured 2,437 ms blocked
// inside the AX probe after the observers came off, so the response's own
// envelope carried the post-commit epoch beside a verdict that said nothing had
// happened (field act ms 11,008…14,786 against a 10.55 s bound).
//
// A real HTTP server is required: only a server can answer a POST in
// milliseconds and then hold the redirected GET past the settle, or refuse one
// and never finish the response.
//
// The cases run CONCURRENTLY. Each needs the act's own 10 s + 5 s bounds to
// elapse in full — that is the condition under test, not slack — so serially the
// file costs ~50 s of almost pure waiting. Each subtest owns its own server and
// its own browser, and nothing here asserts on elapsed time, so concurrency
// changes no outcome; it only stops the waits being additive.
import { strict as assert } from 'node:assert';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { describe, test } from 'node:test';
import { WirSession } from '../src/session.js';

// The act's own bounds are 10 s (document request) + 5 s (the accepted-submit
// window). Longer than their sum by enough that no timing slop can make the
// positive pass by accident — the point of the case is that the render NEVER
// lands inside the act.
const HOLD_MS = 18_000;
// The application request in the correlation-boundary case, answered late enough
// to land INSIDE the extra window (which opens at ≈10.5 s) and early enough that
// the act is still in it.
const LATE_XHR_MS = 12_000;
// …and the main-frame POST that holds that act open. It must still be pending
// when the extra window closes (≈15.5 s) — that is what keeps the act inside the
// window while the XHR is answered — and it must then finish WITHOUT committing
// anything, because a pending main-frame navigation blocks page.evaluate and the
// mutation counter this case depends on is a page.evaluate. 204 does exactly
// that: it completes the navigation and leaves the document in place. (A request
// that literally never answers cannot be used here: the act blocks in the AX
// probe forever. Observed — the first draft of this case, killed at 300 s.)
const PENDING_POST_MS = 17_000;

const PAGE = `<!doctype html><title>submit</title><h1>Host</h1>
  <form method="POST" action="/slow-render"><button>Create submission</button></form>
  <form method="POST" action="/refuse-and-hang"><button>Create refused submission</button></form>
  <form method="POST" action="/dead-destination"><button>Create doomed submission</button></form>
  <form id="elsewhere" method="POST" action="/fast-elsewhere" hidden></form>
  <a href="/expected" onclick="document.getElementById('elsewhere').submit(); return false;">Open expected page</a>
  <form id="slow-elsewhere" method="POST" action="/slow-render" hidden></form>
  <a href="/declared" onclick="document.getElementById('slow-elsewhere').submit(); return false;">Follow slow link</a>
  <form id="stuck" method="POST" action="/pending-then-nothing" hidden></form>
  <div id="log"></div>
  <button id="xhr">Save and keep waiting</button>
  <script>
    document.getElementById('xhr').addEventListener('click', () => {
      // Local rendering: this is what carries the act to the mutation arm, where
      // request_committed is minted.
      document.getElementById('log').appendChild(document.createElement('p'))
        .textContent = 'saving…';
      // The APPLICATION request — same-origin, non-GET, admitted before the
      // settle closes, answered 2xx deep inside the extra window.
      fetch('/late-xhr', { method: 'POST', body: 'x' }).catch(() => {});
      // …and a main-frame POST the server never answers, which is the only
      // reason the act is still open when that 2xx lands.
      document.getElementById('stuck').submit();
    });
  </script>`;

function serve(): Promise<{ server: Server; base: string; held: ServerResponse[] }> {
  const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    // The 671 shape: the submit is ACCEPTED at once (302, the POST-redirect-GET
    // idiom), and the resulting page is what is slow.
    if (req.method === 'POST' && req.url === '/slow-render') {
      res.writeHead(302, { location: '/landed' }); res.end(); return;
    }
    if (req.url === '/landed') {
      // Held open past both of the act's windows: headers never arrive, so the
      // browser never commits and the epoch never moves inside the act.
      held.push(res);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>landed</title><h1>Your submission is live</h1>');
      }, HOLD_MS).unref();
      return;
    }
    // A refusal that also never finishes: the status is the fact that decides,
    // and it must decide the same way whether or not the response completes.
    if (req.method === 'POST' && req.url === '/refuse-and-hang') {
      held.push(res);
      res.writeHead(422, { 'content-type': 'text/html', 'content-length': '4096' });
      res.write('<!doctype html><title>rejected</title><h1>The change you requested was rejected</h1>');
      return;
    }
    // An accepted POST that commits at once, somewhere other than the clicked
    // link's declared href.
    if (req.method === 'POST' && req.url === '/fast-elsewhere') {
      res.writeHead(302, { location: '/other' }); res.end(); return;
    }
    // An accepted 302 whose destination the browser FINISHES without committing
    // anything — 204 completes the navigation and leaves the page in place.
    if (req.method === 'POST' && req.url === '/dead-destination') {
      res.writeHead(302, { location: '/nothing-to-show' }); res.end(); return;
    }
    if (req.url === '/nothing-to-show') { res.writeHead(204); res.end(); return; }
    // Unanswered for longer than the act's whole settle — no status, no headers,
    // so it holds the act in the extra window with nothing to classify — then 204,
    // which completes the navigation without replacing the document.
    if (req.method === 'POST' && req.url === '/pending-then-nothing') {
      held.push(res);
      setTimeout(() => { res.writeHead(204); res.end(); }, PENDING_POST_MS).unref();
      return;
    }
    if (req.method === 'POST' && req.url === '/late-xhr') {
      held.push(res);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
      }, LATE_XHR_MS).unref();
      return;
    }
    const body = req.url === '/'
      ? PAGE
      : `<!doctype html><title>${req.url}</title><h1>Page ${req.url}</h1>`;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve({ server, base: `http://127.0.0.1:${addr.port}`, held });
  }));
}

type Effect = { verdict: string; evidence: string; delta: { after: string } };

async function clickByName(session: WirSession, name: string): Promise<Record<string, unknown>> {
  const found = await session.dispatch({ verb: 'find', name });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `not found: ${name}`);
  return session.dispatch({ verb: 'act', ref, action: 'click' });
}

function startSession(): Promise<WirSession> {
  return WirSession.start({
    headless: true, expectedAction: 'MUTATE', storageStatePath: null,
    harPath: null, tracePath: null, debugScreenshots: false,
  });
}

function closeServer(server: Server, held: ServerResponse[]): Promise<void> {
  for (const res of held) res.destroy();
  return new Promise(resolve => server.close(() => resolve()));
}

describe('an accepted submit is not vetoed by its own render', { concurrency: 6 }, () => {
  test('an ACCEPTED submit whose page never renders inside the act still reads verified navigation_post', async () => {
    const { server, base, held } = await serve();
    const session = await startSession();
    try {
      await session.goto(`${base}/`);
      const acted = await clickByName(session, 'Create submission');
      const effect = acted['effect'] as Effect;
      assert.equal(effect.evidence, 'navigation_post',
        `the server accepted this submit: ${JSON.stringify(acted)}`);
      assert.equal(effect.verdict, 'verified',
        `the render's clock must not decide the verdict: ${JSON.stringify(acted)}`);
      // The answer that made the verdict travels with the delta…
      assert.match(effect.delta.after, /answered 302/);
      // …and so does the honest half: the caller is NOT looking at the result yet.
      assert.match(effect.delta.after, /had not committed/);
      assert.doesNotMatch(effect.delta.after, /\(gone\)/);

      const finish = await session.dispatch({
        verb: 'finish', answer: '', evidenceRefs: [acted['actRef'] as string],
      });
      assert.equal(finish['accepted'], true,
        `an accepted submit must be finishable: ${JSON.stringify(finish)}`);
    } finally {
      await session.close();
      await closeServer(server, held);
    }
  });

  // CONTROL 1 — the refusal. 4xx/5xx keeps exactly the behaviour it had: the
  // evidence may still name the POST, the verdict never says verified, and the
  // gate cannot spend it. Held open on purpose so it takes the same
  // never-finishes path as the positive above; only the status differs.
  test('a submit the server REFUSES never mints verified, however long the response hangs', async () => {
    const { server, base, held } = await serve();
    const session = await startSession();
    try {
      await session.goto(`${base}/`);
      const acted = await clickByName(session, 'Create refused submission');
      const effect = acted['effect'] as Effect;
      assert.notEqual(effect.verdict, 'verified',
        `a refused submit must never read verified: ${JSON.stringify(acted)}`);
      assert.match(effect.delta.after, /422/,
        `the status that withheld the verdict must be reported: ${JSON.stringify(acted)}`);

      const finish = await session.dispatch({
        verb: 'finish', answer: '', evidenceRefs: [acted['actRef'] as string],
      });
      assert.equal((finish['rejected'] as { kind: string } | undefined)?.kind, 'finish_rejected',
        `the gate must not spend a refused submit: ${JSON.stringify(finish)}`);
    } finally {
      await session.close();
      await closeServer(server, held);
    }
  });

  // CONTROL 2 — the conjunct the narrowing rests on. `!documentSettled` is what
  // separates "the browser is still fetching the result" from "the browser is
  // DONE and nothing replaced the page". Only the first is a slow render; the
  // second proves nothing about a document that will never arrive, and the act
  // must keep withholding there. (The neighbouring recorded shape — a 302 to a
  // host that never answers — is not this case: Chrome commits its own error
  // document, so the epoch moves and the pre-existing navigation branch owns it,
  // unchanged by this fix.)
  //
  // It also pins the residual's transparency note, and the fact that the note is
  // NOT a refusal marker: this act's POST was answered 302 — ACCEPTED — and it
  // still lands here, which is precisely why core/act.ts calls the string
  // `postAnswerNote` and says only what the server answered.
  test('an accepted 302 the browser finishes without committing does not mint verified', async () => {
    const { server, base, held } = await serve();
    const session = await startSession();
    try {
      await session.goto(`${base}/`);
      const acted = await clickByName(session, 'Create doomed submission');
      const effect = acted['effect'] as Effect;
      assert.notEqual(effect.verdict, 'verified',
        `a finished request that committed nothing proves nothing: ${JSON.stringify(acted)}`);
      assert.match(effect.delta.after, /answered 302; no new document committed/,
        `an ACCEPTED answer reaches the residual too — the note must not call it a `
        + `refusal: ${JSON.stringify(acted)}`);

      const finish = await session.dispatch({
        verb: 'finish', answer: '', evidenceRefs: [acted['actRef'] as string],
      });
      assert.equal((finish['rejected'] as { kind: string } | undefined)?.kind, 'finish_rejected',
        `the gate must not spend it either: ${JSON.stringify(finish)}`);
    } finally {
      await session.close();
      await closeServer(server, held);
    }
  });

  // CONTROL 3 — the fast contradiction is untouched. The href branch owns 53
  // recorded `contradicted/navigated_elsewhere` acts; this is one of their shape,
  // and it must read exactly as it did before the change.
  //
  // What it does NOT pin, stated because an earlier draft of this file claimed it
  // did: PLACEMENT. `submitAccepted` is false here (the POST commits at once, so
  // the epoch has moved), and a `|| submitAccepted` wrongly hoisted into the href
  // branch would leave this test green. CONTROL 4 is the one that discriminates.
  test('a click that lands somewhere other than its href stays contradicted, POST or not', async () => {
    const { server, base, held } = await serve();
    const session = await startSession();
    try {
      await session.goto(`${base}/`);
      const acted = await clickByName(session, 'Open expected page');
      const effect = acted['effect'] as Effect;
      assert.equal(effect.verdict, 'contradicted',
        `a link that went elsewhere must stay contradicted: ${JSON.stringify(acted)}`);
      assert.equal(effect.evidence, 'navigated_elsewhere', JSON.stringify(acted));
    } finally {
      await session.close();
      await closeServer(server, held);
    }
  });

  // CONTROL 4 — PLACEMENT, discriminating. `|| submitAccepted` belongs on the
  // second navigation gate, BELOW the href branch, and this is the case that can
  // tell the two placements apart: a link declaring /declared whose click submits
  // an accepted POST that has not rendered. `submitAccepted` is TRUE here (epoch
  // and URL both unmoved), so the href branch is live to the relaxation.
  //   correct placement: `navigated` is false, the href branch is skipped, the
  //     gate below reads the accepted POST -> verified / navigation_post.
  //   hoisted into the href branch: it enters with urlAfter still the old page,
  //     sameOriginPath(/declared, old url) is false -> unknown / navigated_elsewhere.
  // So an assertion on this evidence string fails the moment the condition moves
  // up, which is exactly what CONTROL 3 cannot do.
  //
  // Read the pair honestly rather than as a proof of virtue: the SAME page shape
  // reads `contradicted` when the POST commits fast (CONTROL 3) and `verified
  // navigation_post` when it does not commit inside the act (here). That is not
  // an oversight — an act that never observed a destination cannot be
  // contradicted by one — but it is the sharp edge of this fix, recorded so the
  // next reader meets it in a test and not in a trajectory.
  test('an accepted-but-unrendered submit is classified below the href branch, not inside it', async () => {
    const { server, base, held } = await serve();
    const session = await startSession();
    try {
      await session.goto(`${base}/`);
      const acted = await clickByName(session, 'Follow slow link');
      const effect = acted['effect'] as Effect;
      assert.notEqual(effect.evidence, 'navigated_elsewhere',
        `the href branch must not own an act whose URL never moved: ${JSON.stringify(acted)}`);
      assert.equal(effect.evidence, 'navigation_post', JSON.stringify(acted));
      assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    } finally {
      await session.close();
      await closeServer(server, held);
    }
  });

  // CONTROL 5 — THE CORRELATION BOUNDARY. The extra window keeps the network
  // observers installed past the settle. `onResponse` pushes same-origin non-GET
  // 2xx into `committed`, and `request_committed` is NOT in LOCAL_ONLY_EVIDENCE
  // (core/session.ts) — it is gate-eligible, licensed by a G1 bound derived over
  // the OLD, shorter window. So a 2xx arriving inside the EXTRA window must not
  // be admitted, or a slow document silently promotes an act from ineligible
  // `dom_mutated` to eligible `request_committed`.
  //
  // The shape: the click renders locally (mutation records), fires an XHR POST
  // answered 2xx at 12 s, and submits a main-frame POST that stays unanswered
  // until 17 s — the last is only there to hold the act open into the extra
  // window. The document POST is unanswered while the act runs, so
  // `submitAccepted` is false and the act falls through to the mutation arm,
  // which is where the two behaviours differ:
  //   boundary closed (correct): committed is empty -> verified / dom_mutated,
  //     local-only, and the MUTATE gate refuses to spend it.
  //   boundary open: verified / request_committed, gate-eligible, and the finish
  //     is ACCEPTED — a MUTATE episode passing on an XHR the runtime only saw
  //     because an unrelated document request was slow.
  test('a 2xx that lands inside the extra window is not correlated into request_committed', async () => {
    const { server, base, held } = await serve();
    const session = await startSession();
    try {
      await session.goto(`${base}/`);
      const acted = await clickByName(session, 'Save and keep waiting');
      const effect = acted['effect'] as Effect;
      assert.notEqual(effect.evidence, 'request_committed',
        `the extra window must not widen the correlated population: ${JSON.stringify(acted)}`);
      assert.equal(effect.evidence, 'dom_mutated', JSON.stringify(acted));

      const finish = await session.dispatch({
        verb: 'finish', answer: '', evidenceRefs: [acted['actRef'] as string],
      });
      assert.equal((finish['rejected'] as { kind: string } | undefined)?.kind, 'finish_rejected',
        `local-only evidence must stay unspendable: ${JSON.stringify(finish)}`);
    } finally {
      await session.close();
      await closeServer(server, held);
    }
  });
});
