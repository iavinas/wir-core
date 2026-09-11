// Regression for the subtree ladder (docs/research-notes/projection-signal-2026-08-07.md):
// `read {target}` was depth-1, so a control two levels down was described only by
// an integer — `descendants: {count: N}` — and the caller spent one model call per
// rung of anonymous wrappers to turn a name it could already READ into a ref it
// could ACT on. 20 of the failed-10 arm's 45 adjacent read->read pairs were that
// walk; the measured one cost five reads, 10.6s and 164,180 input tokens.
//
// The fixture is the shape debug/probe_reachable.mjs reproduced on the live
// shopping login page: a labelled textbox under anonymous wrappers. It also
// carries a heading — named by the compiler, with no affordance at all — because
// the census filter is name-OR-affordance and an affordance-only census would
// filter `read` through `act`'s vocabulary, breaking "the graph is strictly
// upstream of action affordances" (docs/vision.md).
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

interface Child {
  ref: string;
  descendants?: {
    count: number;
    reachable?: { ref: string; role: string; name?: string }[];
    moreReachable?: { count: number; estimated: boolean; continuation: string };
    continuation: string;
  };
}
interface Match { ref: string; role: string; name: string; affordances?: string[] }

const start = (dir: string) => WirSession.start({
  headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
  debugScreenshots: false,
});

test('a control two levels down arrives as a ref, not as a count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-reachable-'));
  // The wrapper is a `fieldset` because that is what the live page actually
  // compiles to: on shopping's login form the probe found the textbox two rungs
  // under the form, behind an anonymous `group`. A bare <div> would prove
  // nothing — the compiler admits a node only if it is interactive, structural,
  // clickable, AX-named or carries its own text (core/compiler.ts:311-315), so
  // pure wrapper divs are flattened away and never produce a ladder at all.
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>p</title>
    <form aria-label="Invite dialog">
      <fieldset>
        <h3>Members are billed separately</h3>
        <label for="u">Username or email address</label>
        <input id="u" type="text">
        <button>Invite</button>
      </fieldset>
    </form>`);
  const session = await start(dir);
  try {
    await session.goto(`file://${dir}/a.html`);
    const boxes = await session.dispatch({ verb: 'find', role: 'textbox' });
    const textbox = (boxes['matches'] as Match[])[0];
    assert.ok(textbox, `no textbox compiled: ${JSON.stringify(boxes)}`);

    const entries = await session.dispatch({ verb: 'find', name: 'Invite dialog' });
    const entry = (entries['matches'] as Match[])[0];
    assert.ok(entry, `entry never compiled: ${JSON.stringify(entries)}`);

    // ONE read of the entry must hand over the textbox's ref. Before this change
    // the same read said only `descendants: {count: 1}` and cost four more calls.
    const read = await session.dispatch({ verb: 'read', target: entry.ref });
    const kids = (read['children'] ?? []) as Child[];
    const carrier = kids.find(k => (k.descendants?.reachable ?? []).some(x => x.ref === textbox.ref));
    assert.ok(carrier,
      `no child surfaced the textbox ref; a bare count is the ladder this fixes: ${JSON.stringify(kids)}`);

    const reachable = carrier.descendants!.reachable!;
    assert.ok(reachable.some(r => r.ref === textbox.ref && r.name === 'Username or email address'),
      `the page's own words, verbatim, must name the ref: ${JSON.stringify(reachable)}`);

    // The OR is load-bearing: this heading has a name and NO affordance, so an
    // affordance-only census would have dropped it.
    const headings = await session.dispatch({ verb: 'find', role: 'heading' });
    const heading = (headings['matches'] as Match[])[0]!;
    assert.equal(heading.affordances, undefined,
      `fixture assumption: the heading must carry no affordance, else it proves nothing`);
    assert.ok(reachable.some(r => r.ref === heading.ref),
      `a named read-only node must appear — read is upstream of act's vocabulary: ` +
      `${JSON.stringify(reachable)}`);

    // "complete" is never claimed, and a full census carries no residual block.
    assert.equal(JSON.stringify(carrier.descendants).includes('complete'), false);
  } finally { await session.close(); }
});

test('the per-response bound counts exactly what it drops, and its continuation is a real call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-reachable-bound-'));
  // 30 sibling wrappers of 5 named links each: 150 named descendants under one
  // node, far past the per-response budget. Nothing may be dropped silently.
  const block = (i: number) => `<fieldset>${[1, 2, 3, 4, 5]
    .map(j => `<a href="/x${i}-${j}">link ${i}-${j}</a>`).join('')}</fieldset>`;
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>p</title>
    <form aria-label="Wide entry">${Array.from({ length: 30 }, (_, i) => block(i)).join('')}</form>`);
  const session = await start(dir);
  try {
    await session.goto(`file://${dir}/a.html`);
    const entries = await session.dispatch({ verb: 'find', name: 'Wide entry' });
    const entry = (entries['matches'] as Match[])[0];
    assert.ok(entry, `entry never compiled: ${JSON.stringify(entries)}`);

    const read = await session.dispatch({ verb: 'read', target: entry.ref });
    const withDesc = ((read['children'] ?? []) as Child[]).filter(k => k.descendants);
    assert.ok(withDesc.length >= 20, `expected a wide read, got ${withDesc.length}`);

    for (const k of withDesc) {
      const d = k.descendants!;
      const shown = d.reachable?.length ?? 0;
      const left = d.moreReachable?.count ?? 0;
      assert.equal(shown + left, 5,
        `each wrapper holds exactly 5 named links; the accounting must be exact, ` +
        `got shown=${shown} left=${left}: ${JSON.stringify(d)}`);
      if (left > 0) assert.equal(d.moreReachable!.estimated, false,
        'the residual is counted, never estimated');
    }

    // A continuation that answers with a rejection is not a continuation. This is
    // why the residual points at a `read` and not at the `find {within}` the
    // research note proposed: bare `find {within}` is rejected by find's guard.
    const residual = withDesc.find(k => k.descendants!.moreReachable);
    assert.ok(residual, 'the bound must have withheld something on this fixture');
    const cont = residual.descendants!.moreReachable!.continuation;
    const resumed = await session.dispatch(JSON.parse(cont));
    assert.equal(resumed['rejected'], undefined,
      `the continuation must be a call that works: ${cont} -> ${JSON.stringify(resumed['rejected'])}`);
    // and it must actually reach the links the bound withheld
    const reached = ((resumed['children'] ?? []) as Child[])
      .flatMap(c => c.descendants?.reachable ?? []).length
      + ((resumed['children'] ?? []) as { role?: string }[]).filter(c => c.role === 'link').length;
    assert.ok(reached > 0, `the continuation reached nothing: ${JSON.stringify(resumed)}`);
  } finally { await session.close(); }
});
