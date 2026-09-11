// `read {target, all:true}` — a collection exhausted into one typed table,
// bounded by bytes as pagination, never as loss.
//
// Proven on the real sites first (debug/probe_collect_read.mjs,
// debug/runs/collect-read/2026-09-02T10-52-24-813Z-admin-after): the Magento
// admin orders grid at 200 rows per page took SIX `read {target}` calls and
// 132,606 bytes to see by hand — 40 children a page, each child carrying its
// `descendants` census, and 201 children for 200 rows — and the aggregation
// (the count, the min, the max) was then the model's to assemble across the
// six. The same grid through all:true: three pages, 73,374 bytes, `itemCount:
// 200` stated first on every page, every row delivered exactly once and each
// agreeing with a WIR-free oracle on order id, name and total.
//
// The live site cannot produce the two conditions this pins on demand — a
// same-document act that removes DELIVERED rows between table pages, and a
// table that pages at all (the storefront's largest page size, 36, fits in
// one) without an authenticated grid whose page size is persisted server-side
// — so one self-served page carries them, the form every regression here takes.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// 120 rows of ~330 bytes each — about 40 KB of row JSON against the 24,000-byte
// table budget, so the table pages. Row i carries the sentinel "row-i-of-120"
// and a price, the page's own words, so the test can check every row arrived
// and that the arithmetic a caller would do over the table is over the whole
// population.
const ROWS = 120;
const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  + 'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud '
  + 'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure';
const PAGE = '<!doctype html><title>t</title><h1>Orders</h1>'
  + '<button id="prune">Prune</button>'
  + '<ul id="grid">'
  + Array.from({ length: ROWS }, (_, i) =>
      `<li id="r${i}"><span>row-${i}-of-${ROWS}</span> <span>$${(i + 1) * 1.5}</span> <span>${filler}</span></li>`).join('')
  + '</ul>'
  + '<script>document.getElementById("prune").addEventListener("click",function(){'
  + 'for (let i = 2; i < 7; i++) document.getElementById("r"+i).remove();});</script>';

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

test('all:true states the population first, pages by bytes at row boundaries, and delivers every row once', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null });
  try {
    await session.goto(srv.url);
    const overview = await session.dispatch({ verb: 'read' }) as Record<string, any>;
    const col = (overview['collections'] as any[]).find(c => c.itemCount === ROWS);
    assert.ok(col, `precondition: the grid compiles as one ${ROWS}-item collection`);

    // Page 1: the population is exact and stated up front; the cut is at a row
    // boundary within the budget; `complete` is false because it is not.
    const p1 = await session.dispatch({ verb: 'read', target: col.ref, all: true }) as Record<string, any>;
    assert.equal(p1['rejected'], undefined, JSON.stringify(p1['rejected']));
    const t1 = p1['table'];
    assert.equal(t1.itemCount, ROWS);
    assert.equal(t1.rowsBefore, 0);
    assert.equal(t1.complete, false);
    assert.ok(t1.rows.length > 0 && t1.rows.length < ROWS, `pages: ${t1.rows.length} of ${ROWS}`);
    assert.equal(t1.rowsAfter, ROWS - t1.rows.length, 'the remainder is exact');
    assert.equal(t1.moreRows.count, t1.rowsAfter);
    assert.equal(t1.moreRows.estimated, false);
    assert.equal(p1['withheld'].count, t1.rowsAfter, 'the envelope agrees with the table');
    const rowBytes = Buffer.byteLength(JSON.stringify(t1.rows));
    assert.ok(rowBytes <= 24_000, `rows within the byte budget: ${rowBytes}`);
    assert.ok(t1.pagedBy.used <= t1.pagedBy.bytes);
    for (const r of t1.rows) assert.equal(typeof r.ref, 'string');
    const delivered = new Set<string>(t1.rows.map((r: any) => r.ref));
    const epoch = session.currentEpoch();

    // A foreign cursor on an all:true read is rejected with the TABLE's own
    // continuation, never answered with the plain read's children.
    const foreign = await session.dispatch(
      { verb: 'read', target: col.ref, all: true, cursor: 'c_40' }) as Record<string, any>;
    assert.equal(foreign['rejected']?.kind, 'invalid_args', JSON.stringify(foreign));
    assert.equal(foreign['rejected'].repair, t1.moreRows.continuation);

    // Between pages, a same-document act removes five rows the FIRST page
    // delivered. Offset arithmetic would then skip five undelivered survivors;
    // identity resume serves exactly what the chain has not delivered.
    const prune = (overview['controls'] as any[]).find(c => c.name === 'Prune');
    const acted = await session.dispatch(
      { verb: 'act', ref: prune.ref, action: 'click' }) as Record<string, any>;
    assert.equal(acted['rejected'], undefined, JSON.stringify(acted['rejected']));
    assert.equal(session.currentEpoch(), epoch, 'precondition: same document');

    let next: Record<string, any> | null = JSON.parse(t1.moreRows.continuation);
    let last: Record<string, any> | null = null;
    let pages = 1;
    while (next && pages < 10) {
      const p = await session.dispatch(next as any) as Record<string, any>;
      assert.equal(p['rejected'], undefined, JSON.stringify(p['rejected']));
      assert.equal(p['cursorReset'], undefined, 'a resumable chain needs no disclosure');
      const t = p['table'];
      assert.equal(t.itemCount, ROWS - 5, 'the population is the document\'s, restated exactly');
      assert.equal(t.complete, false, '"complete" is never said of one page of a chain');
      for (const r of t.rows) {
        assert.ok(!delivered.has(r.ref), `row ${r.ref} re-served`);
        delivered.add(r.ref);
      }
      pages += 1;
      last = t;
      next = t.moreRows ? JSON.parse(t.moreRows.continuation) : null;
    }
    assert.ok(last && last.chainComplete === true, 'the last page says the chain is complete');
    assert.equal(last!.rowsAfter, 0);

    // The recall assertion: every row that exists NOW was delivered, and the
    // five pruned rows were delivered before they left — nothing on the page
    // is missing from the chain.
    const now = await session.dispatch({ verb: 'read', target: col.ref, all: true }) as Record<string, any>;
    const survivors: string[] = [];
    let cur: Record<string, any> | null = now;
    while (cur) {
      survivors.push(...cur['table'].rows.map((r: any) => r.ref));
      cur = cur['table'].moreRows ? await session.dispatch(JSON.parse(cur['table'].moreRows.continuation)) as Record<string, any> : null;
    }
    assert.equal(survivors.length, ROWS - 5);
    const skipped = survivors.filter(ref => !delivered.has(ref));
    assert.deepEqual(skipped, [], 'no row on the page may be undelivered after the chain is consumed');
    assert.equal(delivered.size, ROWS, 'and every original row was delivered exactly once');

    // Steering: all:true on an ITEM is rejected with its collection's own
    // all-read as the repair, and all without a target is rejected.
    const item = survivors[0]!;
    const r = await session.dispatch({ verb: 'read', target: item, all: true }) as Record<string, any>;
    assert.equal(r['rejected']?.kind, 'invalid_args', JSON.stringify(r));
    assert.equal(r['rejected'].repair, `{"verb":"read","target":"${col.ref}","all":true}`);
    const bare = await session.dispatch({ verb: 'read', all: true }) as Record<string, any>;
    assert.equal(bare['rejected']?.kind, 'invalid_args', 'all needs a target');
  } finally {
    await session.close();
    srv.close();
  }
});
