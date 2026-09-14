// Regression for the finish-loop defect: the gate remembered ONE rejected
// finish, so it could only ever catch the tightest circle. A model alternating
// between two bad finishes — A, B, A, B — overwrote the other's hash on every
// rejection and was answered as if each resubmission were the first.
//
// `finish` is the worst repeat loop in the recorded corpus (708 episodes; one
// carried 11 finish rejections), and the agent's mid-episode repeat nudge
// excludes `finish` because this ledger is supposed to own it.
//
// Reproduced on a real page before the fix (debug/probe_finish_repeat.mjs,
// debug/runs/probe/2026-08-14T06-01-39-219Z-finish-repeat): on Hacker News the
// second A and the second B came back byte-identical to the first, while the
// immediate identical repeat did carry the marker.
//
// The fix is MESSAGES ONLY. Nothing rejected today is accepted, nothing accepted
// today is rejected; the ledger chooses wording, never a verdict — which is what
// the second test pins.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const rows = Array.from({ length: 6 }, (_, i) => `<li>row ${i + 1}</li>`).join('');
const PAGE = `<!doctype html><title>repeat</title><h1>Host</h1><ul>${rows}</ul>`;

const MARKER = /\(already submitted and rejected this episode/;

const rejection = (r: Record<string, unknown>) =>
  r['rejected'] as { kind: string; reason: string; repair?: string } | undefined;

/** A session on the fixture page, plus one ref it actually delivered — the gate
 *  only accepts evidence this episode received. */
const openPage = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-finish-repeat-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  await session.goto(`file://${join(dir, 'a.html')}`);
  const overview = await session.dispatch({ verb: 'read' });
  const refs = [
    ...new Set([...JSON.stringify(overview).matchAll(/n_[0-9a-f]{12,40}/g)].map((m) => m[0])),
  ];
  const observed = refs[0];
  assert.ok(observed, 'precondition: the overview delivered a ref to cite');
  return { session, observed };
};

test('two bad finishes alternating are each told they have been seen before', async () => {
  const { session, observed } = await openPage();
  try {
    // Two DIFFERENT invalid finishes, each rejected for its own reason.
    const A = { verb: 'finish' as const, answer: '', evidenceRefs: [observed] };
    const B = { verb: 'finish' as const, answer: 'row 1', evidenceRefs: [] };

    const a1 = rejection(await session.dispatch(A));
    const b1 = rejection(await session.dispatch(B));
    assert.ok(a1 && b1, 'precondition: both finishes are rejected');
    assert.doesNotMatch(a1.reason, MARKER, 'a first submission is not a repeat');
    assert.doesNotMatch(b1.reason, MARKER, JSON.stringify(b1));
    assert.notEqual(a1.reason, b1.reason, 'precondition: two distinct rejections');

    // THE PIN. B in between must not erase A: the loop the single-hash memory
    // could not see is the loop that actually happens.
    const a2 = rejection(await session.dispatch(A));
    assert.ok(a2, JSON.stringify(a2));
    assert.match(
      a2.reason,
      MARKER,
      `an alternated resubmission must say it was seen before: ${JSON.stringify(a2)}`,
    );
    const b2 = rejection(await session.dispatch(B));
    assert.ok(b2);
    assert.match(b2.reason, MARKER, JSON.stringify(b2));

    // The marker is an ADDITION to the same repair logic, not a new vocabulary:
    // the reason still opens with what this finish lacks, and the repair — the
    // one chosen by the claim, not by local history — is untouched (ADR-004).
    assert.ok(
      a2.reason.startsWith(a1.reason),
      `the reason must still say what it lacks: ${JSON.stringify(a2)}`,
    );
    assert.ok(b2.reason.startsWith(b1.reason), JSON.stringify(b2));
    assert.equal(a2.repair, a1.repair, 'the repair is chosen by the claim, not by the ledger');
    assert.equal(a2.kind, a1.kind, 'and the verdict is the one it always was');

    // Today's behaviour survives as a subset: the tightest circle — the same
    // finish twice in a row — is still marked.
    const C = { verb: 'finish' as const, answer: 'row 1', evidenceRefs: ['n_000000000000'] };
    const c1 = rejection(await session.dispatch(C));
    const c2 = rejection(await session.dispatch(C));
    assert.ok(c1 && c2);
    assert.doesNotMatch(c1.reason, MARKER, JSON.stringify(c1));
    assert.match(
      c2.reason,
      MARKER,
      `an immediate resubmit must still be marked: ${JSON.stringify(c2)}`,
    );
  } finally {
    await session.close();
  }
});

test('an accepted finish gains nothing from the ledger — same verdict, same bytes', async () => {
  const { session, observed } = await openPage();
  try {
    const D = { verb: 'finish' as const, answer: 'row 1', evidenceRefs: [observed] };
    const d1 = await session.dispatch(D);
    const d2 = await session.dispatch(D);
    assert.equal(d1['accepted'], true, JSON.stringify(d1));
    // Every reply now carries the document block, and its callsSinceServed is
    // a per-call counter by definition — it advances between two dispatches
    // whether or not the ledger exists. Strip that one field before the
    // byte comparison; everything else, including the rest of the block, is
    // still held to "no marker, no new bytes".
    const stable = (r: Record<string, unknown>) => {
      const c = JSON.parse(JSON.stringify(r));
      if (c.document) delete c.document.callsSinceServed;
      return JSON.stringify(c);
    };
    assert.equal(
      stable(d2),
      stable(d1),
      `an accepted finish is not a circle — no marker, no new bytes: ${JSON.stringify(d2)}`,
    );
    assert.doesNotMatch(JSON.stringify(d1), MARKER, JSON.stringify(d1));

    // And a rejection never poisons a later acceptance: the ledger changes
    // wording, never a verdict.
    const bad = { verb: 'finish' as const, answer: '', evidenceRefs: [observed] };
    await session.dispatch(bad);
    await session.dispatch(bad);
    const d3 = await session.dispatch(D);
    assert.equal(
      stable(d3),
      stable(d1),
      `a repaired finish is accepted exactly as before: ${JSON.stringify(d3)}`,
    );
  } finally {
    await session.close();
  }
});
