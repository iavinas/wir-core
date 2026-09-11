// An unnamed collection item must not ship its content twice.
//
// Proven on a real page first (debug/probe_item_label_content.mjs,
// getbootstrap.com, read {cursor:"k_8"}): the footer's list-style:none
// `<li>Currently v5.3.8.</li>` compiles unnamed with no named or texted
// descendant, so itemSummary's label fallback is bounded(content) — and the
// content guard compared the PRE-fallback label variable, empty in exactly
// that case, so `content` rode along byte-identical to `label` and the inline
// bound was minted twice for one string.
//
// The rule: `content` is emitted only when it differs from the label actually
// chosen. A named item whose text says more than its name keeps its content —
// that is the task-67 scar itemSummary exists for.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// list-style:none, as the proving page had: no ::marker pseudo-node, so the
// leaf items really do compile with nothing for the label fallback to find.
const PAGE = '<!doctype html><title>t</title><h1>Site</h1>'
  + '<ul style="list-style:none">'
  + '<li>Currently v9.9.9.</li>'
  + '<li>Entirely plain second line with no markup at all</li>'
  + '<li><a href="/x">Named thing</a> plus trailing words the name does not carry</li>'
  + '</ul>';

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

test('an unnamed item never ships content byte-identical to its label', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(srv.url);
    const ov = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    const items = (ov['collections'] ?? []).flatMap((c: any) => c.items ?? []);
    assert.ok(items.length >= 3, `precondition: the list previews: ${JSON.stringify(ov['collections'])}`);

    for (const it of items) {
      if (it.content !== undefined) {
        assert.notEqual(it.content, it.label,
          `content must differ from the label actually chosen: ${JSON.stringify(it)}`);
      }
    }

    // The unnamed leaf keeps its words — in the label, once.
    const leaf = items.find((it: any) => String(it.label).includes('Currently v9.9.9.'));
    assert.ok(leaf, `the leaf item's text still arrives: ${JSON.stringify(items)}`);
    assert.equal(leaf.content, undefined, 'and not a second time as content');

    // The control: a named item whose subtree says more than its name keeps
    // its content. This is the delivery the guard must not overshoot into.
    const named = items.find((it: any) => it.label === 'Named thing');
    assert.ok(named, `precondition: the named item previews: ${JSON.stringify(items)}`);
    assert.ok(String(named.content ?? '').includes('trailing words'),
      `a named item's extra words still travel as content: ${JSON.stringify(named)}`);
  } finally {
    await session.close();
    srv.close();
  }
});
