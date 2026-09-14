// A collection row is a RECORD beside its text, and a single-match find
// carries its read inline.
//
// Proven on the real sites first (debug/probe_read_records.mjs,
// debug/runs/read-records/2026-09-02T16-14-56-041Z-shopping-search,
// …T16-15-09-096Z-shopping-orders, …T16-15-43-904Z-gitlab): on develop-v2's
// second arm three `read {all:true}` episodes (shopping 279, 124, 141) read
// exact tables whose rows were one prose string — "… · 87% · 12 · Reviews ·
// $244.97 · Add to Cart" — and aggregated wrongly over their own re-parse of
// it. The record puts what the graph holds beside the text, mechanically:
// `numbers` (every numeric token in the row's own text runs, verbatim, under
// a stated grammar), `values` (controls under the row holding a value), and
// with fields:true `links` (ref, name, href) — opt-in because on all three
// live lists the hrefs alone put rows at 3.2-3.9x their bytes while
// numbers+values stayed at 1.08-1.96x. Three rows a site agreed with a
// WIR-free oracle on name, hrefs and numeric tokens exactly.
//
// The live sites cannot pin every branch on demand — a row holding a select
// AND a quantity box, a model number beside a price, a single match whose
// read pages — so one self-served page carries them, the form every
// regression here takes.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>records</title><h1>Catalog</h1>' +
  // Rows shaped like a storefront's: a name, a rating, a review count, a
  // price, a quantity box, a shipping select, and the action buttons every
  // Magento row carries — the text a real row has is what keeps its record
  // under the byte bound asserted below.
  '<table><thead><tr><th>Item</th><th>Price</th><th>Qty</th><th>Ship</th><th>Actions</th></tr></thead><tbody>' +
  '<tr><td><a href="/p/wh1000xm3">SONY WH1000XM3 Wireless Noise Canceling Headphones</a> ' +
  '<span>Rating: 87%</span> <a href="/p/wh1000xm3#reviews">12 Reviews</a></td>' +
  '<td>$1,299.00</td><td><input type="number" aria-label="Qty" value="2"></td>' +
  '<td><select aria-label="Ship"><option>Standard</option><option selected>Express</option></select></td>' +
  '<td><button>Add to Cart</button> <button>Add to Wish List</button> <button>Add to Compare</button></td></tr>' +
  '<tr><td><a href="/p/ch510">Sony WH-CH510 On-Ear Headset, Black</a></td>' +
  '<td>$58.00</td><td><input type="number" aria-label="Qty" value="1"></td>' +
  '<td><select aria-label="Ship"><option selected>Standard</option><option>Express</option></select></td>' +
  '<td><button>Add to Cart</button> <button>Add to Wish List</button> <button>Add to Compare</button></td></tr>' +
  '<tr><td>Gift card (no link, no controls)</td><td>$25</td><td></td><td></td>' +
  '<td><button>Add to Cart</button> <button>Add to Wish List</button> <button>Add to Compare</button></td></tr>' +
  '</tbody></table>' +
  '<ul id="deals"><li><a href="/d/1">Deal one</a> 18W adapter <b>$11.83</b></li>' +
  '<li><a href="/d/2">Deal two</a> 6-Feet cable <b>$9.99</b></li></ul>' +
  '<a href="/account">My Account</a>' +
  '<section aria-label="Wide">' +
  Array.from({ length: 45 }, (_, i) => `<p>entry ${i}</p>`).join('') +
  '</section>';

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

const bytes = (o: unknown): number => Buffer.byteLength(JSON.stringify(o));
const strip = (r: Record<string, unknown>): Record<string, unknown> => {
  const { links: _l, values: _v, numbers: _n, ...rest } = r;
  return rest;
};

test('rows carry numbers and values by default, links with fields:true; nothing shown today is removed', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    const overview = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const grid = (overview['collections'] as any[]).find((c) => c.itemCount === 3);
    const deals = (overview['collections'] as any[]).find(
      (c) => c.itemCount === 2 && String(c.items?.[0]?.content ?? '').includes('Deal'),
    );
    assert.ok(
      grid && deals,
      `precondition: the table body (3) and the list (2) compile as collections: ${JSON.stringify(overview['collections'])}`,
    );

    // ---- the table, default arm --------------------------------------------
    const t = (await session.dispatch({ verb: 'read', target: grid.ref, all: true })) as Record<
      string,
      any
    >;
    assert.equal(t['rejected'], undefined, JSON.stringify(t['rejected']));
    const rows: Record<string, any>[] = t['table'].rows;
    assert.equal(rows.length, 3);
    assert.equal(t['table'].complete, true);
    // What was shown before is still shown: ref, label, content.
    for (const r of rows) {
      assert.equal(typeof r.ref, 'string');
      assert.equal(typeof r.label, 'string');
    }
    // numbers: the page's own characters, the stated grammar. The model number
    // "WH1000XM3" yields nothing; "87%", "12", "$1,299.00" and the qty "2"
    // (a control's value is not a text run) come out exactly.
    assert.deepEqual(rows[0]!.numbers, [
      { raw: '87%', number: 87, unit: '%' },
      { raw: '12', number: 12 },
      { raw: '$1,299.00', number: 1299, unit: '$' },
    ]);
    assert.deepEqual(rows[1]!.numbers, [{ raw: '$58.00', number: 58, unit: '$' }]);
    assert.deepEqual(rows[2]!.numbers, [{ raw: '$25', number: 25, unit: '$' }]);
    // values: each control under the row holding a value — the qty box and
    // the select (its value is the selected option's label, the AX value).
    const v0 = rows[0]!.values as any[];
    assert.ok(Array.isArray(v0) && v0.length === 2, JSON.stringify(rows[0]));
    assert.deepEqual(
      v0.map((v) => [v.role, v.name, v.value]),
      [
        ['spinbutton', 'Qty', '2'],
        ['combobox', 'Ship', 'Express'],
      ],
    );
    for (const v of v0) assert.equal(typeof v.ref, 'string');
    assert.deepEqual(
      (rows[1]!.values as any[]).map((v) => v.value),
      ['1', 'Standard'],
    );
    // Empty arrays are omitted, and links are not in the default arm.
    assert.equal(rows[2]!.values, undefined);
    for (const r of rows) assert.equal(r.links, undefined, 'links are opt-in');
    // The table says what its rows carry and the call that widens them.
    assert.deepEqual(t['table'].record.fields, ['values', 'numbers']);
    assert.deepEqual(t['table'].record.moreFields, {
      fields: ['links'],
      continuation: `{"verb":"read","target":"${grid.ref}","all":true,"fields":true}`,
    });
    // The byte bound the change was allowed: a record never doubles its row.
    assert.ok(
      bytes(rows) <= 2 * bytes(rows.map(strip)),
      `record ${bytes(rows)} B vs text ${bytes(rows.map(strip))} B`,
    );

    // ---- the table, fields:true --------------------------------------------
    const w = (await session.dispatch(
      JSON.parse(t['table'].record.moreFields.continuation),
    )) as Record<string, any>;
    assert.equal(w['rejected'], undefined, JSON.stringify(w['rejected']));
    const wide: Record<string, any>[] = w['table'].rows;
    assert.deepEqual(w['table'].record, { fields: ['links', 'values', 'numbers'] });
    assert.deepEqual(
      (wide[0]!.links as any[]).map((l) => [l.name, l.href]),
      [
        ['SONY WH1000XM3 Wireless Noise Canceling Headphones', `${srv.url}/p/wh1000xm3`],
        ['12 Reviews', `${srv.url}/p/wh1000xm3#reviews`],
      ],
    );
    for (const l of wide[0]!.links as any[]) assert.equal(typeof l.ref, 'string');
    assert.equal(wide[2]!.links, undefined, 'a row with no link carries no empty array');
    // Same rows, same numbers and values — fields only ADDS.
    assert.deepEqual(
      wide.map((r) => [r.ref, r.numbers, r.values]),
      rows.map((r) => [r.ref, r.numbers, r.values]),
    );

    // ---- the list: numbers with trailing units, links ------------------------
    const d = (await session.dispatch({
      verb: 'read',
      target: deals.ref,
      all: true,
      fields: true,
    })) as Record<string, any>;
    const items: Record<string, any>[] = d['table'].rows;
    assert.deepEqual(items[0]!.numbers, [
      { raw: '18W', number: 18, unit: 'W' },
      { raw: '$11.83', number: 11.83, unit: '$' },
    ]);
    assert.deepEqual(items[1]!.numbers, [
      { raw: '6', number: 6 },
      { raw: '$9.99', number: 9.99, unit: '$' },
    ]);
    assert.deepEqual(
      (items[1]!.links as any[]).map((l) => [l.name, l.href]),
      [['Deal two', `${srv.url}/d/2`]],
    );

    // ---- steering: fields without all is a rejection, not a silent no-op ----
    const bare = (await session.dispatch({
      verb: 'read',
      target: grid.ref,
      fields: true,
    } as any)) as Record<string, any>;
    assert.equal(bare['rejected']?.kind, 'invalid_args', JSON.stringify(bare));
    assert.equal(
      bare['rejected'].repair,
      `{"verb":"read","target":"${grid.ref}","all":true,"fields":true}`,
    );
  } finally {
    await session.close();
    srv.close();
  }
});

test('a find with exactly one match carries its read inline as detail; two or more do not', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    // One match: detail is what read {target} returns for it.
    const one = (await session.dispatch({
      verb: 'find',
      role: 'link',
      name: 'My Account',
    })) as Record<string, any>;
    assert.equal(one['population'].matched, 1);
    assert.equal(one['matches'].length, 1);
    const ref = one['matches'][0].ref;
    assert.ok(one['detail'], 'a single match carries detail');
    const plain = (await session.dispatch({ verb: 'read', target: ref })) as Record<string, any>;
    assert.deepEqual(
      one['detail'],
      { node: plain['node'], children: plain['children'], childrenTotal: plain['childrenTotal'] },
      'detail is the read, verbatim',
    );
    assert.equal(one['detail'].node.ref, ref);
    // Two or more: unchanged.
    const many = (await session.dispatch({ verb: 'find', role: 'link', name: 'Deal' })) as Record<
      string,
      any
    >;
    assert.equal(many['population'].matched, 2);
    assert.equal(many['detail'], undefined);
    // A single match whose read PAGES: the detail carries the exact residual
    // and its continuation, and that continuation resumes the chain — the
    // detail's delivery record rode the find, so the next page is the rest,
    // with no cursorReset.
    const wide = (await session.dispatch({ verb: 'find', role: 'region', name: 'Wide' })) as Record<
      string,
      any
    >;
    assert.equal(wide['population'].matched, 1);
    const det = wide['detail'];
    assert.equal(det.childrenTotal, 45);
    assert.equal(det.children.length, 40);
    assert.equal(det.withheld.count, 5);
    assert.equal(det.withheld.estimated, false);
    const rest = (await session.dispatch(JSON.parse(det.withheld.continuation))) as Record<
      string,
      any
    >;
    assert.equal(rest['rejected'], undefined, JSON.stringify(rest['rejected']));
    assert.equal(rest['cursorReset'], undefined, 'the chain the detail minted resumes');
    assert.equal(rest['children'].length, 5);
    const seen = new Set<string>(det.children.map((c: any) => c.ref));
    for (const c of rest['children']) assert.ok(!seen.has(c.ref), `child ${c.ref} re-served`);
  } finally {
    await session.close();
    srv.close();
  }
});
