// A scroll that moved and is NOT at the end reports `scrolled`, not
// `scrolled_no_new_content`.
//
// PROVEN DEFECT, and the file it lives in already predicted the cost. The
// new-content test is a text digest, built for a VIRTUALIZED list — one that
// recycles its nodes, so its text genuinely changes as you scroll. An ordinary
// overflow container already holds all of its text and merely clips it: scrolling
// reveals a screenful to the reader while changing nothing measurable. Both read
// `scrolled_no_new_content`, and core/act.ts states in writing that "the system
// prompt turns that token into an instruction to stop".
//
// Measured on the browser-use stress test's legal-text box (432 px of scroll,
// 130 px per call): calls 1-3 each advanced a screenful and each reported
// `scrolled_no_new_content`; only call 4, which reached the bottom, said
// `scrolled`. A caller obeying the evidence stops three screens early — and the
// accept button that box gates stayed `disabled`, so the task could not be
// completed at all. After the fix the same sequence scores.
//
// `atEnd` is the honest discriminator and was already computed on both sides of
// every scroll. This does not weaken the stop signal; it moves it to where
// stopping is actually right.
//
// THE CONTROL IS THE SECOND TEST: at the bottom, the evidence must STILL be
// `scrolled_no_new_content`. Without that, "stop" never arrives and a caller
// scrolls a finished container forever — the failure this evidence string was
// introduced to prevent.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// A plain overflow container: all the text is in the DOM from the start, so
// nothing about it changes as you scroll. That is the whole point.
const PAGE =
  '<!doctype html><title>scroll</title><h1>Scroll</h1>' +
  '<div id="box" style="height:120px;overflow-y:scroll;border:1px solid #ccc">' +
  Array.from({ length: 40 }, (_, i) => `<p>paragraph number ${i} of the long legal text</p>`).join(
    '',
  ) +
  '</div>';

async function withPage(fn: (s: WirSession) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-scroll-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });
    await fn(session);
  } finally {
    await session.close();
  }
}

const inner = async (s: WirSession): Promise<string> => {
  const r = (await s.dispatch({ verb: 'find', name: 'paragraph number 0' })) as Record<string, any>;
  const m = (r['matches'] ?? [])[0];
  assert.ok(
    m,
    `precondition: a paragraph inside the box is findable: ${JSON.stringify(r['matches'])}`,
  );
  return m.ref;
};

const pos = (s: WirSession): Promise<{ top: number; max: number }> =>
  s.host.page.evaluate(() => {
    const e = document.getElementById('box') as HTMLElement;
    return { top: Math.round(e.scrollTop), max: Math.round(e.scrollHeight - e.clientHeight) };
  });

test('a scroll with more below reports `scrolled`, even when the DOM is unchanged', async () => {
  await withPage(async (s) => {
    const ref = await inner(s);
    const before = await pos(s);
    assert.equal(before.top, 0, 'precondition: starts at the top');
    assert.ok(before.max > 200, `precondition: there is plenty to scroll: ${before.max}`);

    const r = (await s.dispatch({ verb: 'act', ref, action: 'scroll' })) as Record<string, any>;
    const after = await pos(s);
    assert.ok(after.top > before.top, `precondition: it actually moved: ${JSON.stringify(after)}`);
    assert.ok(after.top < after.max, 'precondition: and is NOT yet at the end');

    assert.equal(
      r['effect']?.evidence,
      'scrolled',
      'more remains below, so this is new content to the reader — not a stop signal',
    );
    assert.equal(r['effect']?.verdict, 'verified');
  });
});

test('CONTROL — at the end it STILL says scrolled_no_new_content, so stop arrives', async () => {
  await withPage(async (s) => {
    const ref = await inner(s);
    // Drive to the bottom, then scroll once more.
    // ~80 px per call (clientHeight - 40) over ~1,256 px of scroll.
    for (let i = 0; i < 30; i += 1) {
      await s.dispatch({ verb: 'act', ref, action: 'scroll' });
      const p = await pos(s);
      if (p.top >= p.max - 2) break;
    }
    const end = await pos(s);
    assert.ok(end.top >= end.max - 2, `precondition: at the bottom: ${JSON.stringify(end)}`);

    const r = (await s.dispatch({ verb: 'act', ref, action: 'scroll' })) as Record<string, any>;
    assert.equal(
      r['effect']?.evidence,
      'scrolled_no_new_content',
      'the stop signal must still exist, or a caller scrolls forever',
    );
  });
});

test('scroll "end" reaches the bottom in ONE call, and says how far it went', async () => {
  // One viewport per call is right for reading, but reaching the bottom then
  // costs one MODEL ROUND TRIP per screen — ~3.1 s each against ~40 ms of
  // runtime. Measured: mimo-v2.5 exhausted its 60-call budget mid-scroll on a
  // legal-text box, its last thought "let me keep scrolling to the bottom".
  // The task was reachable; the transport was not affordable.
  await withPage(async (s) => {
    const ref = await inner(s);
    const r = (await s.dispatch({ verb: 'act', ref, action: 'scroll', value: 'end' })) as Record<
      string,
      any
    >;
    assert.equal(r['rejected'], undefined, `accepted: ${JSON.stringify(r['rejected'])}`);
    const p = await pos(s);
    assert.ok(p.top >= p.max - 2, `one call reached the bottom: ${JSON.stringify(p)}`);
    // The bound is ACCOUNTED, not hidden: it says how many screens it spent.
    assert.match(
      String(r['effect']?.delta?.after),
      /\[\d+ screens?\]/,
      `the delta reports the screens traversed: ${r['effect']?.delta?.after}`,
    );
    assert.match(String(r['effect']?.delta?.after), /at the end of this container/);
  });
});

test('CONTROL — an unknown scroll value is refused, never guessed at', async () => {
  // The value is a CLOSED set. Silently treating "bottom" or "down" as "end"
  // would make the action mean whatever the model happened to type.
  await withPage(async (s) => {
    const ref = await inner(s);
    const r = (await s.dispatch({
      verb: 'act',
      ref,
      action: 'scroll',
      value: 'sideways',
    })) as Record<string, any>;
    assert.equal(r['rejected']?.kind, 'invalid_args');
    assert.match(
      String(r['rejected']?.repair),
      /"value":"end"/,
      'and the repair shows the one value it does take',
    );
    const p = await pos(s);
    assert.equal(p.top, 0, 'and nothing moved');
  });
});

test('CONTROL — omitting the value still advances exactly one viewport', async () => {
  // The default must not change. A caller reading a list one screen at a time
  // depends on it, and every existing scroll call omits the value.
  await withPage(async (s) => {
    const ref = await inner(s);
    await s.dispatch({ verb: 'act', ref, action: 'scroll' });
    const p = await pos(s);
    assert.ok(p.top > 0, 'it moved');
    assert.ok(p.top < p.max, `but nowhere near the end: ${JSON.stringify(p)}`);
  });
});
