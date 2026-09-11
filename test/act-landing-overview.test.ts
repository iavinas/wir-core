// An act that REPLACED the document returns its landing overview; an act that did
// not, does not.
//
// Measured over the recorded corpus: 1,974 acts replaced the document and 1,424
// (72.1%) were followed immediately by a bare `read {}`. Of the 1,133 bare reads
// following a *verified* act, 996 (87.9%) follow a replacement. That read is not
// ceremony — every ref the caller holds was minted under the old epoch and is dead,
// so it is forced. At ~5.1s of model latency per round trip that is ~2 minutes of
// pure transport per episode.
//
// THE SCOPING IS THE DESIGN, and the second test is what pins it. A same-document
// act is excluded because only 137 bare reads follow one, and in those 79.6% of the
// refs returned were ALREADY in the caller's hands — refs are sha1(epoch:backendNodeId)
// and survive a same-document recompile. Folding an overview into all 3,845 acts
// would ship ~17 MB to save at most 137 more calls: a 2.1x net byte LOSS against a
// transcript that is 95.4% prefix-cached only because it grows at the end.
//
// Verified on real sites before this was written (debug/verify_landing.mjs, seeds 42
// and 7 over the 101-site list, plus WebArena): 4 of 4 document-replacing acts
// carried an honest landing.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const s: Server = createServer((q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      if (q.url === '/second') {
        r.end('<!doctype html><title>second</title><h1>Second</h1>'
          + '<ul>' + Array.from({ length: 6 }, (_, i) => `<li>landed row ${i}</li>`).join('') + '</ul>');
        return;
      }
      // A link that replaces the document, and a button that only mutates in place.
      r.end('<!doctype html><title>first</title><h1>First</h1>'
        + '<a href="/second">Go second</a>'
        + '<button id="b" aria-expanded="false">Toggle</button>'
        + '<div id="sink"></div>'
        + '<script>document.getElementById("b").addEventListener("click",function(){'
        + 'this.setAttribute("aria-expanded","true");'
        + 'document.getElementById("sink").innerHTML="<p>grown</p>";});</script>');
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });
}

test('a document-replacing act carries a landing overview whose refs are citable',
  async () => {
    const srv = await serve();
    const session = await WirSession.start({
      headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
    try {
      await session.goto(srv.url);
      const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
      const link = (ov['controls'] ?? []).find((c: any) => String(c.name ?? '').includes('Go second'));
      assert.ok(link, 'precondition: the link is in the overview');
      const before = session.currentEpoch();

      const acted = await session.dispatch(
        { verb: 'act', ref: link.ref, action: 'click' }) as Record<string, any>;
      assert.notEqual(session.currentEpoch(), before, 'precondition: the document was replaced');

      const landing = acted['landing'];
      assert.ok(landing, `a replacing act must carry its landing: ${JSON.stringify(Object.keys(acted))}`);
      assert.match(String(landing.title), /second/i, 'and it must be the NEW document');

      // The envelope vouches for the graph the landing came from, not the dead one.
      assert.equal(acted['freshness'], 'recompiled');
      assert.equal(acted['documentEpoch'], session.currentEpoch());

      // LANDMINE 1 — the refs must be citable. observedRefs is fed only from
      // doRead/doFind, so a landing that skips recordObserved delivers refs the
      // runtime's own gate then rejects: delivered but uncitable.
      const refs: string[] = [];
      const walk = (v: any): void => {
        if (typeof v === 'string') { if (/^n_[0-9a-f]{12,40}$/.test(v)) refs.push(v); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(landing);
      assert.ok(refs.length > 0, 'the landing delivered refs at all');
      const fin = await session.dispatch({ verb: 'finish', answer: 'landed',
        evidenceRefs: refs.slice(0, 8), status: 'success' }) as Record<string, any>;
      assert.doesNotMatch(String(fin['rejected']?.reason ?? ''), /never observed/,
        'refs the runtime itself delivered must be citable');
    } finally {
      await session.close();
      srv.close();
    }
  });

test('a same-document act carries no landing, and the episode is unharmed', async () => {
  // THE CONTROL. Paying an overview here is the 2.1x byte loss the scoping avoids —
  // and the caller's refs are still valid, so there is nothing to re-deliver.
  const srv = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(srv.url);
    const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    const button = (ov['controls'] ?? []).find((c: any) => String(c.name ?? '').includes('Toggle'));
    assert.ok(button, 'precondition: the button is in the overview');
    const before = session.currentEpoch();

    const acted = await session.dispatch(
      { verb: 'act', ref: button.ref, action: 'click' }) as Record<string, any>;
    assert.equal(session.currentEpoch(), before, 'precondition: same document');
    assert.equal(acted['landing'], undefined,
      'a same-document act must not pay for an overview nobody needs');
    assert.equal(acted['freshness'], 'dirty',
      'and it still vouches for nothing, because the graph was dropped');

    // The pre-act ref survives: refs are sha1(epoch:backendNodeId), so a
    // same-document recompile re-mints the identical ref. This is WHY the landing
    // is unnecessary here, and asserting it keeps the reasoning checkable.
    const after = await session.dispatch({ verb: 'read', target: button.ref }) as Record<string, any>;
    assert.equal(after['rejected'], undefined,
      `the caller's refs are still good after a same-document act: ${JSON.stringify(after['rejected'])}`);
  } finally {
    await session.close();
    srv.close();
  }
});
