// The wire contract is closed and the validator must enforce it.
//
// Proven on a real page first (debug/probe_unknown_keys.mjs, news.ycombinator.com):
// the published schemas say additionalProperties:false on every verb, but the
// runtime validator only type-checked keys it knew. Five garbled calls passed
// silently — `read {"ref":"n_x"}` returned the full overview as if asked for
// it, and an act carrying stray keys clicked anyway. A model that garbles
// act's `ref` into read (act addresses by ref, read by target, find by
// within) believed it had read the node.
//
// The rejection names the stray keys and the verb's accepted set; the repair
// echoes the caller's own value into the corrected literal call for the
// obvious renames.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = '<!doctype html><title>t</title><h1>Host</h1>'
  + '<a href="/away">Leave</a><p>Some words to find</p>';

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

test('unknown argument keys reject with the corrected call, never pass silently', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(srv.url);
    const found = await session.dispatch({ verb: 'find', name: 'Leave' }) as Record<string, any>;
    const ref = found['matches'][0].ref as string;

    // read {ref} — the plausible garble. Steered, with the caller's own value.
    const read = await session.dispatch({ verb: 'read', ref } as any) as Record<string, any>;
    assert.equal(read['rejected']?.kind, 'invalid_args', JSON.stringify(read).slice(0, 300));
    assert.match(String(read['rejected'].reason), /unknown key/);
    assert.match(String(read['rejected'].reason), /\bref\b/);
    assert.match(String(read['rejected'].reason), /target/, 'accepted keys are named');
    assert.deepEqual(JSON.parse(read['rejected'].repair), { verb: 'read', target: ref },
      'the repair maps ref to target and echoes the value');

    // find {ref} — same garble, find's own rename.
    const fnd = await session.dispatch({ verb: 'find', ref, name: 'Leave' } as any) as Record<string, any>;
    assert.equal(fnd['rejected']?.kind, 'invalid_args', JSON.stringify(fnd).slice(0, 300));
    assert.deepEqual(JSON.parse(fnd['rejected'].repair), { verb: 'find', name: 'Leave', within: ref },
      'the repair maps ref to within and keeps the valid keys');

    // act with a stray key must not execute: the link would have navigated.
    const before = session.currentEpoch();
    const acted = await session.dispatch(
      { verb: 'act', ref, action: 'click', force: true } as any) as Record<string, any>;
    assert.equal(acted['rejected']?.kind, 'invalid_args', JSON.stringify(acted).slice(0, 300));
    assert.equal(session.currentEpoch(), before,
      'a rejected act performed nothing — the document did not move');

    // The clean calls still pass — the closed schema rejects strays, not use.
    const clean = await session.dispatch({ verb: 'read', target: ref }) as Record<string, any>;
    assert.equal(clean['rejected'], undefined, JSON.stringify(clean['rejected']));
  } finally {
    await session.close();
    srv.close();
  }
});
