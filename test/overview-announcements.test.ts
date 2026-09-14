// The page announced the answer and the overview did not carry it.
//
// `alert` and `status` exist in ARIA for one purpose: an announcement the user
// must receive NOW. After an action that announcement is usually the answer —
// what the form rejected, or that it was accepted — and `read {}` listed only
// landmark regions (banner, navigation, main, contentinfo, search, form), so it
// went unmentioned.
//
// Measured on browser-use's React form: the submit SUCCEEDED, the page put
// "Form submitted successfully! The secret is: …" into a role=alert node, `find`
// matched that node, and `read {}` returned regionsTotal 1 with no trace of it.
// The episode searched for the message, found nothing, and gave up on a task it
// had already completed. The banner then deleted itself 3s later.
//
// The TEXT travels with the ref because an alert's accessible name is normally
// empty — content is not a name source for the role — so a bare ref would
// announce that something was announced and charge another call to learn what.
//
// FIXTURE JUSTIFIED: needs an alert that appears in response to an action, beside
// a landmark, so "the overview carries it" is decidable rather than incidental.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>announce</title>
<main>
  <form><button id="go" type="button">Submit Form</button></form>
  <div id="out" role="alert" style="display:none">Saved. The code is orange-tortoise.</div>
</main>
<script>
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('out').style.display = 'block';
  });
</script>`;

test('an alert the page raises is in the overview, with its words', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-announce-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    // Nothing announced yet: the key must be absent, not empty. An overview that
    // always carries the field would train the reader to ignore it.
    const before = await session.dispatch({ verb: 'read' });
    assert.equal(
      before['announcements'],
      undefined,
      `nothing has been announced yet: ${JSON.stringify(before['announcements'])}`,
    );

    const found = await session.dispatch({ verb: 'find', name: 'Submit Form' });
    const btn = ((found['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(btn, 'precondition: the button is findable');
    await session.dispatch({ verb: 'act', ref: btn.ref, action: 'click' });

    const after = await session.dispatch({ verb: 'read' });
    const announcements = after['announcements'] as { role: string; text: string }[] | undefined;
    assert.ok(
      announcements && announcements.length > 0,
      `the overview must carry what the page announced: ${JSON.stringify(after).slice(0, 400)}`,
    );
    assert.equal(announcements[0]!.role, 'alert');
    assert.match(
      announcements[0]!.text,
      /orange-tortoise/,
      `and its words, not just its ref: ${JSON.stringify(announcements)}`,
    );
  } finally {
    await session.close();
  }
});
