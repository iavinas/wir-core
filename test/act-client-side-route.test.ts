// A link click that moves the URL without loading a document must SAY so.
//
// Reproduced on the live map container first (debug/probe.mjs, headless, via the
// same session.dispatch the agent calls): clicking a search result moved the URL
// from /search?query=Carnegie%20Music%20Hall to /way/154257484 with documentEpoch
// IDENTICAL on both sides — no document was ever served — and the act returned
//
//     verdict: verified, evidence: navigated_to_destination
//     delta.after: "http://localhost:3000/way/154257484"
//
// with nothing about the document. core/act.ts COMPUTED that fact and threw it
// away: the href branch returned 46 lines before the note was built, so the note
// could reach every click EXCEPT a link — the one case where a URL moves.
//
// This is a truth fix, not a benchmark fix. It changes no verdict and no gate
// arithmetic: `navigated_to_destination` is LOCAL_ONLY (core/session.ts:765), so
// such a click never minted gate-eligible proof and still does not. It only stops
// the runtime asserting a destination was navigated to when nothing was loaded.
//
// An http fixture is justified per the method rule: pushState to a different path
// throws SecurityError on file://, so the proven condition cannot be produced on a
// local file, and the live map container cannot be a test dependency. One page,
// one condition, and the control below shares it.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>routes</title><h1>Places</h1>
  <a id="spa" href="/way/154257484">Carnegie Music Hall</a>
  <a id="real" href="/real">A real link</a>
  <script>
    // The map's shape: a genuine href, intercepted and turned into a history
    // entry. The address bar moves; no request leaves the browser.
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
      resolve({
        server,
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
      });
    });
  });
}

async function startSession(): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-csr-'));
  return WirSession.start({
    headless: true,
    expectedAction: 'NAVIGATE',
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
}

async function linkRef(session: WirSession, name: string): Promise<string> {
  const page = await session.dispatch({ verb: 'read' });
  const controls = page['controls'] as { ref: string; role: string; name: string }[];
  const hit = controls.find((c) => c.role === 'link' && c.name.includes(name));
  assert.ok(hit, `no link named ${name}: ${JSON.stringify(controls).slice(0, 400)}`);
  return hit.ref;
}

test('a pushState link click reports that no document was loaded', async () => {
  const site = await serve();
  const session = await startSession();
  try {
    await session.goto(site.url);
    const before = await session.dispatch({ verb: 'read' });
    const ref = await linkRef(session, 'Carnegie Music Hall');

    const act = await session.dispatch({ verb: 'act', action: 'click', ref });
    const effect = act['effect'] as { verdict: string; evidence: string; delta: { after: string } };

    assert.equal(
      act['documentEpoch'],
      before['documentEpoch'],
      'the fixture must not replace the document, or it tests nothing',
    );
    assert.match(
      String(act['url']),
      /\/way\/154257484$/,
      `the URL must have moved: ${JSON.stringify(act).slice(0, 300)}`,
    );
    assert.match(
      effect.delta.after,
      /client-side route/,
      'a URL that moved with no document served must say so, or the model is told ' +
        `it navigated to a destination that was never loaded: ${JSON.stringify(effect)}`,
    );
  } finally {
    await session.close();
    site.close();
  }
});

// THE CONTROL. A link that really navigates must NOT carry the note — otherwise
// the fix is a blanket string on every click and proves nothing.
test('a real navigation is untouched and carries no client-side-route note', async () => {
  const site = await serve();
  const session = await startSession();
  try {
    await session.goto(site.url);
    const before = await session.dispatch({ verb: 'read' });
    const ref = await linkRef(session, 'A real link');

    const act = await session.dispatch({ verb: 'act', action: 'click', ref });
    const effect = act['effect'] as { verdict: string; delta: { after: string } };

    assert.notEqual(
      act['documentEpoch'],
      before['documentEpoch'],
      'this arm must genuinely replace the document, or the control is vacuous',
    );
    assert.doesNotMatch(
      effect.delta.after,
      /client-side route/,
      `a real document load must not be labelled a client-side route: ${JSON.stringify(effect)}`,
    );
  } finally {
    await session.close();
    site.close();
  }
});
