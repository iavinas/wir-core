// Earned by shopping_admin task 0 (2026-08-14): FIVE finish rejections in one
// episode, all carrying the one sentence that listed three constraints and
// named none of them — "finish: answer must be a string, evidenceRefs an array
// of strings, status success|not_found_error".
//
// Two unrelated faults hid behind it. First an `answer` passed as a real array,
// because the task declares an array results schema and the natural reading of
// "your answer must be JSON that validates against it" is to send one. Then,
// after the answer was correctly encoded, a `status` of "SUCCESS" — the
// spelling the prompt's prose uses, because that IS the agent RESPONSE status,
// while this ARGUMENT's enum is lower-case. Two vocabularies, one word.
//
// The driver read "answer must be a string" while holding a string, concluded
// the fault was its evidence, and resent the same call three times with
// different refs. It could not repair what the rejection would not name, and
// this is the last call of an episode, so every wasted attempt lands at the end
// of a budget.
//
// These assertions pin the DISCRIMINATION, not the prose: each fault must name
// its own field and must not name the others.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

async function withSession(fn: (s: WirSession, ref: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-finishargs-'));
  writeFileSync(
    join(dir, 'a.html'),
    '<!doctype html><title>a</title><h1>Bestsellers</h1><p>Quest Lumaflex Band</p>',
  );
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: join(dir, 'network.har'),
    tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const heading = (overview['headings'] as { ref: string }[] | string[])[0];
    const ref = typeof heading === 'string' ? heading : heading?.ref;
    assert.ok(ref, JSON.stringify(overview).slice(0, 300));
    await fn(session, ref);
  } finally {
    await session.close();
  }
}

const reason = (r: Record<string, unknown>): string =>
  String((r['rejected'] as { reason?: string } | undefined)?.reason ?? '');

test('an array answer names ANSWER, and says the encoding', async () => {
  await withSession(async (session, ref) => {
    const out = await session.dispatch({
      verb: 'finish',
      answer: ['Quest Lumaflex Band'] as unknown as string,
      evidenceRefs: [ref],
    });
    const why = reason(out);
    assert.match(why, /answer must be a string/, why);
    assert.match(why, /array/, `the value it actually got must be shown back: ${why}`);
    assert.match(why, /ENCODED/, `the repair is the encoding, so it must be stated: ${why}`);
    // The fault is the answer. Naming the other two is what made the original
    // message unusable — the caller cannot tell which constraint it broke.
    assert.doesNotMatch(why, /evidenceRefs must be/, why);
    assert.doesNotMatch(why, /status must be/, why);
  });
});

test('an upper-case status names STATUS and hands back the lower-case call', async () => {
  await withSession(async (session, ref) => {
    const out = await session.dispatch({
      verb: 'finish',
      answer: '["Quest Lumaflex Band"]',
      evidenceRefs: [ref],
      status: 'SUCCESS' as unknown as 'success',
    });
    const why = reason(out);
    assert.match(why, /status must be/, why);
    assert.match(why, /"success"/, why);
    // The whole point: a correctly-encoded answer must NOT be blamed.
    assert.doesNotMatch(
      why,
      /answer must be a string/,
      `the answer was a string; blaming it is what caused three wasted retries: ${why}`,
    );
  });
});

test('a non-string ref names EVIDENCEREFS, and says it is never encoded', async () => {
  await withSession(async (session) => {
    const out = await session.dispatch({
      verb: 'finish',
      answer: '["x"]',
      evidenceRefs: '["n_abc"]' as unknown as string[],
    });
    const why = reason(out);
    assert.match(why, /evidenceRefs must be an array/, why);
    assert.doesNotMatch(why, /answer must be a string/, why);
  });
});

test('the control: lower-case status and an encoded answer are accepted', async () => {
  await withSession(async (session, ref) => {
    const out = await session.dispatch({
      verb: 'finish',
      answer: '["Quest Lumaflex Band"]',
      evidenceRefs: [ref],
      status: 'success',
    });
    assert.equal(
      out['accepted'],
      true,
      `a well-formed finish must still pass — a stricter message must not become a stricter gate: ${JSON.stringify(out).slice(0, 300)}`,
    );
  });
});
