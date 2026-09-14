// Regression for the type false-verified (score-program kg2, earned by
// failed10-develop-1/task-442/attempt-1): a GitLab confirm-modal's focus trap
// swallowed the chord+insertText entirely — the textarea's window was
// byte-identical before and after — and the postcondition still minted
// verified/text_typed off 4 AMBIENT mutation records. Mechanism reproduced
// end-to-end through the real dispatch path in
// debug/runs/probe/2026-08-05T10-27-59-270Z-phase2-442 (activeElement = the
// modal's button, containsActive true, input landing in the void).
// The rule this pins: verified/text_typed requires the TARGET-SCOPED signal
// (the readable window moved); ambient mutations alone mint only
// unknown/no_observable_change_yet, with the count still reported in the
// delta. The fixture models the swallowed-input condition minimally: a
// readonly textarea (focusable, input discarded — as under the focus trap)
// plus an unrelated timer mutating the document through the settle window.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>ambient</title><h1>Host</h1>
  <textarea aria-label="Editor content" readonly>original content</textarea>
  <div id="ticker"></div>
  <script>
    // Unrelated ambient activity: mutation records land every 100ms whether
    // or not any typing succeeds — exactly what comfort-minted the false
    // verified in the field.
    setInterval(() => {
      ticker.textContent = 'tick ' + Date.now();
    }, 100);
  </script>`;

test('type whose input is swallowed reads unknown, never text_typed off ambient mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-ambient-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
    harPath: null,
    tracePath: null,
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const found = await session.dispatch({ verb: 'find', role: 'textbox', name: 'Editor content' });
    const ref = (found['matches'] as { ref: string }[])[0]?.ref;
    assert.ok(ref, JSON.stringify(found));
    const acted = await session.dispatch({
      verb: 'act',
      ref,
      action: 'type',
      value: 'replacement\ntext',
    });
    const effect = acted['effect'] as {
      verdict: string;
      evidence: string;
      delta: { after: string };
    };
    assert.ok(effect, JSON.stringify(acted));
    assert.equal(
      effect.verdict,
      'unknown',
      `ambient mutations must not prove typing: ${JSON.stringify(acted)}`,
    );
    assert.equal(effect.evidence, 'no_observable_change_yet');
    // The ambient activity is still REPORTED — honesty about what was seen.
    assert.match(
      effect.delta.after,
      /mutationRecords=[1-9]/,
      `the delta must still carry the ambient count: ${JSON.stringify(effect.delta)}`,
    );
  } finally {
    await session.close();
  }
});
