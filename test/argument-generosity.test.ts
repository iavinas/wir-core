// Argument generosity: four spellings the runtime can read without guessing are
// applied and echoed under `applied`; a spelling with two readings still rejects.
//
// PROVEN IN THE FIELD FIRST. debug/rejection_ledger.mjs over 1,182 episodes
// (docsV2/plans/evidence/rejection-ledger-2026-09-02.md) ranked every
// invalid_args: read.cursor carrying the continuation object whole (104
// rejections), find's name filter called query/text (74), act key "Return" (69,
// one per episode — every model learned it once and paid a turn), act's ref
// called target (7). Reproduced live on reddit and GitLab through the agent's
// own dispatch path by debug/probe_argument_generosity.mjs before this test
// existed; the evidence is docsV2/plans/evidence/wt-argument-generosity.md.
//
// THE CONTROL: a cursor that is neither a bare id nor a continuation this
// runtime minted stays invalid_args, with the literal continuation in the
// repair — generosity is a rewrite with one reading, never a guess.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// 60 links so the overview withholds 10 controls and mints c_50; a search form
// whose only submit path is Enter, so key "Return" has to reach the page as
// Enter to move it.
const PAGE =
  '<!doctype html><title>t</title><h1>Host</h1>' +
  '<form action="/search" method="get"><input name="q" aria-label="Search"></form>' +
  Array.from({ length: 60 }, (_, i) => `<a href="/l${i}">link ${i}</a>`).join('');

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s: Server = createServer((q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(
        q.url?.startsWith('/search') ? '<!doctype html><title>s</title><h1>Results</h1>' : PAGE,
      );
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
    });
  });
}

test('an unambiguous alias is applied and echoed; an ambiguous one still rejects', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    const bare = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const cont = bare['withheld'].continuation as string;
    assert.deepEqual(
      JSON.parse(cont),
      { verb: 'read', cursor: 'c_50' },
      'precondition: the overview mints c_50',
    );
    assert.equal(bare['applied'], undefined, 'a canonical call echoes nothing');

    // 1. read.cursor carrying the continuation whole — as its JSON string, and
    // as the parsed object — is unwrapped, applied, and echoed.
    for (const cursor of [cont, JSON.parse(cont)]) {
      const r = (await session.dispatch({ verb: 'read', cursor } as any)) as Record<string, any>;
      assert.equal(r['rejected'], undefined, JSON.stringify(r['rejected']));
      assert.deepEqual(r['applied'], { verb: 'read', cursor: 'c_50' });
      assert.equal(
        (r['controls'] as unknown[]).length,
        11,
        'c_50 reached the withheld tail: 60 links + the search field - 50',
      );
    }
    // The control: a wrapped call that is not a read continuation stays
    // invalid_args, with the literal continuation as the repair.
    const foreign = (await session.dispatch({
      verb: 'read',
      cursor: '{"verb":"find","name":"link","cursor":"c_20"}',
    })) as Record<string, any>;
    assert.equal(foreign['rejected']?.kind, 'invalid_args', JSON.stringify(foreign).slice(0, 300));
    assert.equal(foreign['rejected'].repair, cont);
    assert.equal(foreign['applied'], undefined);

    // 2. find query= / text= stand in for name= when name is absent.
    for (const key of ['query', 'text']) {
      const r = (await session.dispatch({ verb: 'find', [key]: 'link 3' } as any)) as Record<
        string,
        any
      >;
      assert.equal(r['rejected'], undefined, JSON.stringify(r['rejected']));
      assert.deepEqual(r['applied'], { verb: 'find', name: 'link 3' });
      assert.ok((r['matches'] as any[]).length >= 1, 'the filter was applied as name');
    }
    // Both given and different: two readings, so a rejection that echoes both.
    const both = (await session.dispatch({
      verb: 'find',
      name: 'link 3',
      query: 'link 4',
    } as any)) as Record<string, any>;
    assert.equal(both['rejected']?.kind, 'invalid_args');
    assert.match(String(both['rejected'].reason), /name: "link 3", query: "link 4"/);

    // 3. act target= stands in for ref= when ref is absent.
    const box = (
      (await session.dispatch({ verb: 'find', role: 'textbox', name: 'Search' })) as Record<
        string,
        any
      >
    )['matches'][0];
    const fill = (await session.dispatch({
      verb: 'act',
      target: box.ref,
      action: 'fill',
      value: 'squash',
    } as any)) as Record<string, any>;
    assert.equal(fill['rejected'], undefined, JSON.stringify(fill['rejected']));
    assert.deepEqual(fill['applied'], {
      verb: 'act',
      ref: box.ref,
      action: 'fill',
      value: 'squash',
    });
    assert.equal(fill['effect'].verdict, 'verified');

    // 4. act key "Return" is Enter — pressed for real: the form submits.
    const ret = (await session.dispatch({
      verb: 'act',
      ref: box.ref,
      action: 'key',
      value: 'Return',
    })) as Record<string, any>;
    assert.equal(ret['rejected'], undefined, JSON.stringify(ret['rejected']));
    assert.deepEqual(ret['applied'], { verb: 'act', ref: box.ref, action: 'key', value: 'Enter' });
    assert.equal(ret['effect'].key, 'Enter', 'the applied key is echoed in the effect');
    assert.equal(ret['effect'].verdict, 'verified', JSON.stringify(ret['effect']));
    assert.match(
      session.host.page.url(),
      /\/search\?q=squash$/,
      'Enter reached the page and submitted the form',
    );
    // A chord keeps its modifiers; only the main key is aliased.
    const ov2 = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    assert.equal(ov2['applied'], undefined);
    const h1 = (
      (await session.dispatch({ verb: 'find', role: 'heading', name: 'Results' })) as Record<
        string,
        any
      >
    )['matches'][0];
    const chord = (await session.dispatch({
      verb: 'act',
      ref: h1.ref,
      action: 'key',
      value: 'Control+Down',
    })) as Record<string, any>;
    assert.equal(chord['applied']?.value, 'Control+ArrowDown', JSON.stringify(chord).slice(0, 300));
    // And a real key name is not rewritten.
    const plain = (await session.dispatch({
      verb: 'act',
      ref: h1.ref,
      action: 'key',
      value: 'ArrowDown',
    })) as Record<string, any>;
    assert.equal(plain['applied'], undefined);
  } finally {
    await session.close();
    srv.close();
  }
});
