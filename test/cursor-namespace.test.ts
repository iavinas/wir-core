// A malformed or wrong-namespace cursor is a steering rejection, never a
// silent page 1.
//
// Proven on a real page first (debug/probe_cursor_namespace.mjs,
// news.ycombinator.com): parseCursor answers any cursor that does not match
// this list's prefix+digits shape with offset 0, so a `t_x` typo, `c_2O`
// (letter O), or another list's cursor re-served page 1 byte-identical to the
// bare call — 6 of 6 shapes silent. Apparent non-progress the caller cannot
// tell from a stuck runtime.
//
// Preserved on purpose: an ABSENT cursor still means page 1, and the
// overview's five lists still share one cursor argument without a foreign
// prefix advancing the wrong list (`c_50` pages controls, never regions).
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// 60 links: the overview withholds 10 controls and mints c_50, so the valid
// continuation the repair must carry is computable and non-trivial.
const PAGE = '<!doctype html><title>t</title><h1>Host</h1>'
  + Array.from({ length: 60 }, (_, i) => `<a href="/l${i}">link ${i}</a>`).join('');

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const s: Server = createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });
}

test('a cursor no list minted rejects with the computed valid continuation', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(srv.url);

    // Overview: the typo names itself and the repair is the real continuation.
    const typo = await session.dispatch({ verb: 'read', cursor: 't_x' }) as Record<string, any>;
    assert.equal(typo['rejected']?.kind, 'invalid_args', JSON.stringify(typo).slice(0, 300));
    assert.match(String(typo['rejected'].reason), /t_x/, 'the received cursor is named');
    assert.deepEqual(JSON.parse(typo['rejected'].repair), { verb: 'read', cursor: 'c_50' },
      'the repair is the literal continuation this overview mints');

    // Find: another list's cursor is not this find's namespace.
    const fnd = await session.dispatch(
      { verb: 'find', role: 'link', name: 'link', cursor: 'k_25' }) as Record<string, any>;
    assert.equal(fnd['rejected']?.kind, 'invalid_args', JSON.stringify(fnd).slice(0, 300));
    assert.match(String(fnd['rejected'].reason), /k_25/);
    const repair = JSON.parse(fnd['rejected'].repair);
    assert.equal(repair.cursor, 'c_20', 'the repair continues THIS query');
    assert.equal(repair.name, 'link', 'with the caller\'s own filters');

    // Target read: the overview's namespaces are not a target's.
    const found = await session.dispatch({ verb: 'find', name: 'link 3' }) as Record<string, any>;
    const ref = found['matches'][0].ref as string;
    const tgt = await session.dispatch({ verb: 'read', target: ref, cursor: 'k_25' }) as Record<string, any>;
    assert.equal(tgt['rejected']?.kind, 'invalid_args', JSON.stringify(tgt).slice(0, 300));
    assert.equal(JSON.parse(tgt['rejected'].repair).target, ref,
      'the repair reaches this target, not the overview');

    // Preserved: absent cursor is page 1; a valid foreign-list cursor still
    // pages its own list only; the minted continuation still works.
    const bare = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    assert.equal(bare['rejected'], undefined);
    assert.equal((bare['controls'] as unknown[]).length, 50);
    const cont = await session.dispatch(JSON.parse(bare['withheld'].continuation)) as Record<string, any>;
    assert.equal(cont['rejected'], undefined, JSON.stringify(cont['rejected']));
    assert.equal((cont['controls'] as unknown[]).length, 10,
      'c_50 still reaches the withheld tail of the 60 links');

    // An unknown target still answers unknown_ref, not a cursor complaint.
    const ghost = await session.dispatch(
      { verb: 'read', target: 'n_000000000000', cursor: 'zzz' }) as Record<string, any>;
    assert.equal(ghost['rejected']?.kind, 'unknown_ref', JSON.stringify(ghost).slice(0, 300));
  } finally {
    await session.close();
    srv.close();
  }
});
