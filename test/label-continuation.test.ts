// `find` labelled an unnamed collection item with `item.text.slice(0, 80)` —
// a bare byte prefix with no marker, no count and no continuation. A model
// could not tell a short item from a cut one, and had no call to reach the
// rest. That is the truncation the pagination invariant forbids outright, and
// it sat directly beside `read`'s `itemSummary`, which already routed the same
// kind of string through `bounded`.
//
// The subtle half is WHICH string gets bounded. `bounded` hands back an offset
// as a `t_` cursor, and read's `t_` branch pages `subtreeText(node)`. Bounding
// `item.text` — the item's own runs, without its descendants' — would have
// produced an offset into a different string, so the continuation would resume
// at the wrong place while looking perfectly well-formed. That is defect C4
// wearing a marker: exact accounting, unreachable content.
//
// So this test does not check that a marker is present. It follows the
// continuation and asserts the returned characters are the ones the label
// stopped at.
//
// FIXTURE JUSTIFIED: needs a collection whose items are UNNAMED (no heading, no
// aria-label — the branch the label fallback exists for) and longer than the
// 80-character bound. Real pages name their list items; the recorded corpus has
// the shape only incidentally, and pinning cursor arithmetic needs the text to
// be known exactly, which no live page can promise.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Predictable, countable, and long enough that 80 characters cannot hold it.
const body = (n: number): string =>
  Array.from({ length: 12 }, (_, k) => `item${n}part${k}`).join(' ');

const LIST = `<!doctype html><title>list</title>
<main><ul>
  ${[1, 2, 3].map((n) => `<li><span>${body(n)}</span><button>Reply ${n}</button></li>`).join('\n  ')}
</ul></main>`;

test('a truncated item label carries a continuation that reaches the next characters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-label-'));
  writeFileSync(join(dir, 'a.html'), LIST);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    const found = await session.dispatch({ verb: 'find', name: 'Reply 1' });
    const match = ((found['matches'] ?? []) as { item?: { ref: string; label: string } }[])[0];
    assert.ok(match?.item, `the button must be owned by an item: ${JSON.stringify(found)}`);
    const label = match.item.label;

    // 1. The cut is declared, not silent.
    assert.match(
      label,
      /…\[\+\d+ chars: /,
      `a cut label must say it was cut: ${JSON.stringify(label)}`,
    );

    // 2. The continuation is a literal next call, and it parses.
    const m = /: (\{.*\})\]$/.exec(label);
    assert.ok(m, `the marker must carry a callable continuation: ${JSON.stringify(label)}`);
    const next = JSON.parse(m[1]!) as Record<string, unknown>;

    // 3. THE POINT, stated as the invariant rather than as an offset: following
    //    the continuation, and then its continuations, must reach EVERY
    //    character the label cut off. A bound whose call cannot get there is
    //    defect C4 — exact accounting, unreachable content — and it passes
    //    every check above.
    //
    //    The label offers a plain read of the item rather than a `t_` cursor,
    //    so it re-serves from the start and the node's single text chain takes
    //    over from there. Redundant by 80 characters, and one chain instead of
    //    two that never consumed each other.
    let seen = '';
    let call: Record<string, unknown> | null = next;
    for (let hop = 0; hop < 12 && call !== null; hop += 1) {
      const r = await session.dispatch(call as never);
      const body = JSON.stringify(r);
      seen += body;
      const m = /…\[\+\d+ chars: (\{[^}]*\})\]/.exec(body.replace(/\\"/g, '"'));
      call = m ? (JSON.parse(m[1]!) as Record<string, unknown>) : null;
    }
    for (const k of [0, 5, 11]) {
      assert.ok(
        seen.includes(`item1part${k}`),
        `part ${k} is unreachable through the label's continuation chain`,
      );
    }
  } finally {
    await session.close();
  }
});

test('a short item label is served whole, with no marker', async () => {
  // The other half: `bounded` must not decorate text that fits. A marker on a
  // complete string is its own lie, and "complete" may appear only when true.
  const dir = mkdtempSync(join(tmpdir(), 'wir-label-short-'));
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>short</title>
    <main><ul>
      <li><span>alpha</span><button>Reply 1</button></li>
      <li><span>beta</span><button>Reply 2</button></li>
      <li><span>gamma</span><button>Reply 3</button></li>
    </ul></main>`,
  );
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const found = await session.dispatch({ verb: 'find', name: 'Reply 2' });
    const match = ((found['matches'] ?? []) as { item?: { label: string } }[])[0];
    assert.ok(match?.item, JSON.stringify(found));
    assert.ok(
      !/…\[\+/.test(match.item.label),
      `an item that fits must not be marked as cut: ${JSON.stringify(match.item.label)}`,
    );
  } finally {
    await session.close();
  }
});

// One node's text must have ONE pagination chain.
//
// `bounded` mints a `t_<offset>` cursor. `find` cut an item's label at 80 and
// `read`'s itemSummary cut the same item's content at 320, so each node grew two
// independent chains and following either never consumed the other. Measured on
// three items: six ledger entries for three nodes, and after reading every
// character the finish confrontation still announced 1,139 withheld per item —
// telling a caller that read everything to go back and read it again.
//
// A label is a pointer, not a delivery, so it now offers the plain read of the
// item: reachable (that read returns the item's content, verified below), and
// consumable, which the second chain never was.
test('a label and a content bound do not mint two chains for one node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-chains-'));
  const body = (n: number): string =>
    Array.from({ length: 120 }, (_, k) => `item${n}part${k}`).join(' ');
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>chains</title><main><ul>${[1, 2]
      .map((n) => `<li><span>${body(n)}</span><button>Reply ${n}</button></li>`)
      .join('')}</ul></main>`,
  );
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    await session.dispatch({ verb: 'read' });
    const found = await session.dispatch({ verb: 'find', name: 'Reply 1' });

    // At most one `t_` cursor per node across BOTH projections.
    const byNode = new Map<string, string[]>();
    for (const o of session.unconsumedContinuations()) {
      const m = /"target":"([^"]+)"/.exec(o.call);
      const cursor = /"cursor":"(t_\d+)"/.exec(o.call)?.[1];
      if (!m || !cursor) continue;
      byNode.set(m[1]!, [...(byNode.get(m[1]!) ?? []), cursor]);
    }
    for (const [ref, cursors] of byNode) {
      assert.equal(
        cursors.length,
        1,
        `node ${ref} has ${cursors.length} text chains: ${cursors.join(', ')}`,
      );
    }

    // And the label's own offer must deliver, then be consumed.
    const item = ((found['matches'] ?? []) as { item?: { label: string } }[])[0]?.item;
    assert.ok(item, JSON.stringify(found));
    const call = /(\{"verb":"read"[^}]*\})/.exec(item.label);
    assert.ok(call, `a cut label must carry a callable continuation: ${item.label}`);
    const r = await session.dispatch(JSON.parse(call[1]!) as never);
    const text = JSON.stringify(r);
    assert.ok(
      text.includes('item1part0') && text.includes('item1part119'),
      `the label's continuation must deliver the item's text: ${text.slice(0, 200)}`,
    );
    assert.ok(
      !session.unconsumedContinuations().some((o) => o.call === call[1]),
      'following the label offer must consume it',
    );
  } finally {
    await session.close();
  }
});
