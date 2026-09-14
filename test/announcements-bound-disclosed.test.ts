// The announcements bound was a silent slice: `.slice(0, 4)` on entries and
// `.slice(0, 200)` on text, with no total, no marker, no continuation — while
// the comment above it claimed "Bounded like every other list here." A 5th
// alert, or char 201 of a long one, appeared NOWHERE in the response and no
// call could reach it (probe_announce_bound.mjs, before-fixture run
// debug/runs/announce-bound/2026-08-13T07-30-37-105Z-before-fixture: DOM oracle
// 5 alert-role nodes / 540-char text, overview 4 entries / 200 chars, both
// sentinels absent from the entire response, withheld null). Announcements
// exist because a hidden alert once cost a completed task; a hidden bound on
// them is the same defect one layer up.
//
// FIXTURE JUSTIFIED: the real-site attempt failed. On browser-use's
// stress-tests, formik and material-ui are the only role=alert producers —
// each one hardcoded 63-char success banner that deletes itself after 3s — and
// an invalid submit mints ZERO role=alert nodes (per-field errors are plain
// divs; oracle in the before run's events.jsonl). >4 simultaneous alerts and a
// >200-char alert are unproducible there. One page, both proven conditions.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const LONG = `The import failed with 17 validation errors. ${'Row rejected because the SKU column is empty and the price field is negative. '.repeat(6)}End-of-alert-tail-sentinel.`;
const PAGE = `<!doctype html><title>announce bound</title>
<main>
  <div role="alert">First: saved.</div>
  <button id="more" type="button">Raise More</button>
  <div id="rest" style="display:none">
    <div role="alert">${LONG}</div>
    <div role="status">Third: 3 items queued.</div>
    <div role="alert">Fourth: session expires soon.</div>
    <div role="alert">Fifth-alert-sentinel: the hidden one.</div>
  </div>
</main>
<script>
  document.getElementById('more').addEventListener('click', () => {
    document.getElementById('rest').style.display = 'block';
  });
</script>`;

test('the announcements bound is disclosed and its continuations reach everything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-announce-bound-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    // (c) control: one short alert is exactly what it always was — the page's
    // words, no marker, no total, no more-block. The common case pays nothing.
    const one = await session.dispatch({ verb: 'read' });
    const first = one['announcements'] as { text: string }[];
    assert.equal(first.length, 1);
    assert.equal(first[0]!.text, 'First: saved.');
    assert.equal(one['announcementsTotal'], undefined, 'no total when nothing was withheld');
    assert.equal(one['moreAnnouncements'], undefined, 'no more-block when nothing was withheld');

    const found = await session.dispatch({ verb: 'find', name: 'Raise More' });
    const btn = ((found['matches'] ?? []) as { ref: string }[])[0];
    assert.ok(btn, 'precondition: the button is findable');
    await session.dispatch({ verb: 'act', ref: btn.ref, action: 'click' });

    // (a) 5 alerts: 4 shown, exact residual, and the continuation REACHES the 5th.
    const ov = await session.dispatch({ verb: 'read' });
    const shown = ov['announcements'] as { ref: string; text: string }[];
    assert.equal(shown.length, 4, JSON.stringify(shown));
    assert.equal(ov['announcementsTotal'], 5);
    const more = ov['moreAnnouncements'] as {
      count: number;
      unit: string;
      estimated: boolean;
      continuation: string;
    };
    assert.equal(more.count, 1);
    assert.equal(more.unit, 'announcements');
    assert.equal(more.estimated, false);
    const page2 = await session.dispatch(JSON.parse(more.continuation));
    const fifth = page2['announcements'] as { text: string }[];
    assert.ok(
      fifth.some((x) => x.text.includes('Fifth-alert-sentinel')),
      `the continuation must deliver the withheld alert: ${JSON.stringify(fifth)}`,
    );

    // (b) long text: complete-so-far + inline marker whose continuation reaches
    // the remainder — followed as minted, not reconstructed.
    const long = shown.find((x) => x.text.includes('…[+'));
    assert.ok(long, `one entry carries the bound marker: ${JSON.stringify(shown)}`);
    assert.ok(
      long!.text.startsWith(LONG.slice(0, 320)),
      'complete-so-far: the visible prefix is the text itself',
    );
    const m = /…\[\+(\d+) chars: (\{.*\})\]$/.exec(long!.text);
    assert.ok(m, `marker carries count and continuation: ${long!.text.slice(-120)}`);
    assert.equal(Number(m![1]), LONG.length - 320, 'the residual is exact');
    const rest = await session.dispatch(JSON.parse(m![2]!));
    assert.equal(rest['textOffset'], 320);
    assert.ok(
      String(rest['content']).includes('End-of-alert-tail-sentinel'),
      `the continuation must deliver the withheld characters: ${JSON.stringify(rest['content'])}`,
    );
  } finally {
    await session.close();
  }
});
