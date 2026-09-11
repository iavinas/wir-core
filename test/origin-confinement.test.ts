// Origin confinement is a RUNNER POLICY, and both directions are load-bearing.
//
// The bug this pins: `navigate` and the host's route filter were two closures over
// the same question, and they disagreed. The verb admits a URL whose origin+path the
// GRAPH has shown; the host admitted only origins named at session start. So an agent
// that found a link in search results was told yes by the verb and no by the browser
// — and before test/navigation-failure.test.ts, that killed the episode outright.
// Observed live 2026-08-11 on an open-web task that named no URL: the agent started at
// a search engine, found its destination, and died reaching it.
//
// Both policies must keep working, because two deployments need opposite answers:
//
//   'declared' (default) — only origins the runner named. WebArena needs this. An
//     agent once escaped to github.com through Magento's own "Report Bugs" footer
//     link, and that link WAS shown by the graph — so an observed-origins rule would
//     re-open precisely that hole. This half of the test is the escape regression.
//
//   'observed' — additionally any origin the graph has shown. The open web needs
//     this: a task naming no URL starts at a search engine and its destinations
//     cannot be enumerated in advance.
//
// A fix that proved only the new direction would let the old hole back in quietly,
// which is why both are asserted here rather than in separate files.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

function serve(body: string): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const s: Server = createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(body);
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });
}

// The chicken-and-egg the 'observed' policy created, caught by hand-driving a live
// open-web task on its very first call: seenOrigins is empty at session start, so a
// route filter reading it blocks the FIRST navigation — nothing can be visited until
// it is observed, and nothing is observed until it is visited. session.goto is the
// RUNNER's navigation, carrying the same authority as knownUrls, so it seeds before
// it moves.
test('the runner\'s own first navigation is not blocked by the observed policy',
  async () => {
    const only = await serve('<!doctype html><title>solo</title><h1>Solo</h1>');
    try {
      const session = await WirSession.start({
        headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
        originPolicy: 'observed',      // and NO knownUrls: the open-web shape
      });
      try {
        await session.goto(only.url);   // threw before the fix
        const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
        assert.match(String(ov['url']), /^http:\/\/127\.0\.0\.1:/,
          'an open-web episode can start at all');
      } finally { await session.close(); }
    } finally { only.close(); }
  });

test('confinement follows the declared set, or the observed one, as the runner says',
  async () => {
    const target = await serve('<!doctype html><title>target</title><h1>Target reached</h1>');
    const start = await serve('<!doctype html><title>start</title><h1>Start</h1>'
      + `<a href="${target.url}/page">Go to target</a>`);
    try {
      for (const policy of ['declared', 'observed'] as const) {
        const session = await WirSession.start({
          headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
          knownUrls: [start.url],          // only the START is declared
          originPolicy: policy,
        });
        try {
          await session.goto(start.url);
          const overview = await session.dispatch({ verb: 'read' }) as Record<string, any>;
          const shown = (overview['controls'] ?? [])
            .some((c: any) => String(c.name ?? '').includes('Go to target'));
          assert.ok(shown, 'precondition: the graph showed the cross-origin link');

          const out = await session.dispatch(
            { verb: 'navigate', url: `${target.url}/page` }) as Record<string, any>;

          if (policy === 'declared') {
            // The escape regression. An origin the runner did not name stays
            // unreachable EVEN THOUGH a page offered it — that is the whole point.
            assert.equal(out['rejected']?.kind, 'navigation_failed',
              `declared policy must not follow a link off the declared origins: ${JSON.stringify(out)}`);
            // And it is a rejection, never a dead episode.
            const alive = await session.dispatch({ verb: 'read' }) as Record<string, any>;
            assert.ok(alive['url'] !== undefined, 'the episode survives the refusal');
          } else {
            assert.equal(out['rejected'], undefined,
              `observed policy must reach an origin the graph showed: ${JSON.stringify(out)}`);
            const after = await session.dispatch({ verb: 'read' }) as Record<string, any>;
            assert.match(String(after['url']), /\/page$/, 'and it actually arrives');
          }
        } finally {
          await session.close();
        }
      }
    } finally {
      start.close();
      target.close();
    }
  });
