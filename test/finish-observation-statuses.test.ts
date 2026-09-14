// The finish vocabulary covers three claims about the WORLD, not two.
//
// PROVEN DEFECT: `core/toolschemas.ts` offered only `success` and
// `not_found_error` while WebArena-Verified also expects
// `action_not_allowed_error` (shopping 793-797, gitlab 805, 807) and
// `permission_denied_error` (gitlab 783). Measured across the 764-episode sweep:
// 9 episodes reached the correct conclusion — the agent found the blocker,
// understood it, and had no word for it — so `give_up` reported UNKNOWN_ERROR
// and a correct investigation was recorded as a crash. Several were otherwise
// fully solved, which makes this a scoring change and not only a correctness one.
//
// The bar is the OBSERVATION bar, identical to not_found_error's: the answer may
// be empty, the evidence refs may not. "I looked and it is barred" is a finding
// about the world and must cite where the model looked. It is NOT an exemption
// from the MUTATE gate — nothing here can launder a failed mutation into
// success, because each status travels to the official evaluator as itself and a
// task expecting a change scores 0 on it exactly as give_up does.
//
// FIXTURE JUSTIFIED: needs a page with a ref to cite and no mutation available,
// so "accepted with an empty answer" is decidable without a live site.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>barred</title>
<main><p id="msg">Members can be added by project Maintainers or Owners.</p></main>`;

async function open(expectedAction: 'MUTATE' | 'RETRIEVE') {
  const dir = mkdtempSync(join(tmpdir(), 'wir-finish-status-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction,
    storageStatePath: null,
  });
  await session.goto(`file://${dir}/a.html`);
  return session;
}

async function aRef(session: WirSession): Promise<string> {
  const found = await session.dispatch({ verb: 'find', name: 'Maintainers' });
  const m = ((found['matches'] ?? []) as { ref: string }[])[0];
  assert.ok(m, `nothing to cite: ${JSON.stringify(found)}`);
  return m.ref;
}

for (const status of ['action_not_allowed_error', 'permission_denied_error'] as const) {
  test(`${status} is accepted with an empty answer when it cites where the model looked`, async () => {
    const session = await open('MUTATE');
    try {
      const ref = await aRef(session);
      const out = await session.dispatch({
        verb: 'finish',
        answer: '',
        evidenceRefs: [ref],
        status,
      });
      assert.ok(!out['rejected'], `must be accepted, got ${JSON.stringify(out)}`);
      assert.equal(out['status'], status, 'the claim must travel as itself, not be rewritten');
    } finally {
      await session.close();
    }
  });

  test(`${status} without evidence refs is refused`, async () => {
    const session = await open('MUTATE');
    try {
      const out = await session.dispatch({ verb: 'finish', answer: '', evidenceRefs: [], status });
      assert.ok(
        out['rejected'],
        'an unevidenced refusal is a claim about the world with nothing behind it',
      );
    } finally {
      await session.close();
    }
  });
}

test('a status outside the vocabulary is still refused, and the message names the set', async () => {
  const session = await open('RETRIEVE');
  try {
    const ref = await aRef(session);
    const out = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [ref],
      status: 'unknown_error' as never,
    });
    assert.ok(out['rejected'], 'give_up is an agent-local tool and never a finish status');
    const reason = JSON.stringify(out);
    assert.ok(
      reason.includes('action_not_allowed_error'),
      `the rejection should name the set: ${reason}`,
    );
  } finally {
    await session.close();
  }
});
