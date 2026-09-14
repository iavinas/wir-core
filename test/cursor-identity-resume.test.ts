// A continuation resumes by IDENTITY, never by offset — the zero-tolerance
// recall class.
//
// Proven on a real page first (debug/probe_cursor_recall.mjs, an HN comment
// thread): read {} paged 50 of 269 controls and minted c_50; one
// comment-collapse act — same document, verified — removed controls above the
// cursor; consuming c_50 then resumed at offset 50 of the re-ranked list, and
// control n_d336b2a72e86 ("[–]"), present on the page, was never delivered by
// any page. Zero disclosure. Every act nulls the graph cache, so this fires
// on the ordinary read → act → continue sequence.
//
// The rule: the session keeps a delivery record per minted continuation, and
// the next page serves what that record LACKS, in current rank order —
// complete by construction under any recomposition. A well-formed cursor with
// no record (replaced document, or never minted) serves from the start and
// says so (cursorReset): before, it silently served offset n of a list whose
// first n entries the caller had never seen.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Prune removes five EARLY links — delivered on page 1 — so the withheld tail
// shifts up under the cursor: offset resume would skip exactly five
// undelivered survivors.
const PAGE =
  '<!doctype html><title>t</title><h1>Host</h1>' +
  '<button id="prune">Prune</button>' +
  Array.from({ length: 60 }, (_, i) => `<a id="l${i}" href="/l${i}">link ${i}</a>`).join('') +
  '<script>document.getElementById("prune").addEventListener("click",function(){' +
  'for (let i = 5; i < 10; i++) document.getElementById("l"+i).remove();});</script>';

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
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

test('a continuation after a same-document recompile delivers every survivor', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    const page1 = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const delivered = new Set((page1['controls'] as any[]).map((c) => c.ref));
    assert.equal(delivered.size, 50, 'precondition: 61 controls page at 50');
    assert.equal(page1['withheld'].count, 11);
    const epoch = session.currentEpoch();

    const prune = (page1['controls'] as any[]).find((c) => c.name === 'Prune');
    const acted = (await session.dispatch({
      verb: 'act',
      ref: prune.ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(acted['rejected'], undefined, JSON.stringify(acted['rejected']));
    assert.equal(session.currentEpoch(), epoch, 'precondition: same document');

    // Consume the pre-act continuation. Five delivered links are gone; the
    // survivors shifted up. Offset 50 of the 56-entry list would serve six
    // and silently skip five — identity resume serves all eleven undelivered.
    const page2 = (await session.dispatch(JSON.parse(page1['withheld'].continuation))) as Record<
      string,
      any
    >;
    assert.equal(page2['rejected'], undefined, JSON.stringify(page2['rejected']));
    assert.equal(page2['cursorReset'], undefined, 'a resumable chain needs no disclosure');
    for (const c of page2['controls'] as any[]) delivered.add(c.ref);

    // The recall assertion: everything that exists NOW was delivered.
    const full = new Set<string>();
    let fresh = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    for (const c of fresh['controls'] as any[]) full.add(c.ref);
    let guard = 0;
    while (fresh['withheld'] && guard++ < 5) {
      fresh = (await session.dispatch(JSON.parse(fresh['withheld'].continuation))) as Record<
        string,
        any
      >;
      for (const c of fresh['controls'] as any[]) full.add(c.ref);
    }
    assert.equal(full.size, 56, 'precondition: five links left the page');
    const skipped = [...full].filter((ref) => !delivered.has(ref));
    assert.deepEqual(
      skipped,
      [],
      'no ref on the page may be undelivered after the chain is consumed',
    );
  } finally {
    await session.close();
    srv.close();
  }
});

test('a cursor with no delivery record serves from the start and says so', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    // Well-formed, never minted: before the fix this served offset 999 — an
    // empty page indistinguishable from completeness.
    const resp = (await session.dispatch({ verb: 'read', cursor: 'c_999' })) as Record<string, any>;
    assert.equal(resp['rejected'], undefined, JSON.stringify(resp['rejected']));
    assert.ok(resp['cursorReset'], `the reset is disclosed: ${JSON.stringify(Object.keys(resp))}`);
    assert.equal(resp['cursorReset'].received, 'c_999');
    assert.equal((resp['controls'] as unknown[]).length, 50, 'and the list starts over');
    assert.equal(resp['withheld'].count, 11, 'with honest accounting');
  } finally {
    await session.close();
    srv.close();
  }
});

test('find continuations resume by identity too', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    const page1 = (await session.dispatch({
      verb: 'find',
      role: 'link',
      name: 'link',
      limit: 5,
    })) as Record<string, any>;
    const delivered = new Set((page1['matches'] as any[]).map((m) => m.ref));
    assert.equal(delivered.size, 5);

    const ov = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const prune = (ov['controls'] as any[]).find((c) => c.name === 'Prune');
    await session.dispatch({ verb: 'act', ref: prune.ref, action: 'click' });

    // link 5..9 are gone — two pages of the pre-act chain still reach every
    // surviving match exactly once each page, none skipped.
    let resp = page1;
    let guard = 0;
    while (resp['withheld'] && guard++ < 20) {
      resp = (await session.dispatch(JSON.parse(resp['withheld'].continuation))) as Record<
        string,
        any
      >;
      assert.equal(resp['rejected'], undefined, JSON.stringify(resp['rejected']));
      for (const m of resp['matches'] as any[]) delivered.add(m.ref);
    }
    const fresh = (await session.dispatch({
      verb: 'find',
      role: 'link',
      name: 'link',
      limit: 100,
    })) as Record<string, any>;
    const skipped = (fresh['matches'] as any[]).filter((m) => !delivered.has(m.ref));
    assert.deepEqual(
      skipped.map((m) => m.name),
      [],
      'every surviving match was reached through the chain',
    );
  } finally {
    await session.close();
    srv.close();
  }
});
