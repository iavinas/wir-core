// Regression for review finding B6: subtreeText deduped the item's label out of
// its content with `parts.filter(p => p !== label)` — which drops EVERY part
// equal to the label, not the one that sourced it. Genuine repeats of the page's
// own words vanished silently. That is the exact silent-loss class the
// label-only dedup was introduced to fix (review C2), reintroduced one line
// lower: "a page where the vote count and the comment count are both 10 must
// show both" applies to the label string too.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

test('a repeated label string keeps its other occurrences in content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-projection-'));
  // aria-label pins the item's accname to "Reply" (a bare <li> takes its name
  // from content, which on a list includes the ::marker — not a stable anchor
  // for this assertion). "Reply" then occurs TWICE inside the subtree: once as
  // the link that reads like the label, once as real body text. Only the first
  // is the label's source; the second is a page fact.
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>p</title><h1>Thread</h1>
    <ul>
      <li id="item" aria-label="Reply"><a href="/r">Reply</a><span>Reply</span><span>tail</span></li>
      <li aria-label="Other"><a href="/s">Other</a></li>
    </ul>`);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const collections = overview['collections'] as
      { items: { ref: string; label: string; content?: string }[] }[];
    const items = collections.flatMap(c => c.items);
    const item = items.find(i => (i.content ?? '').includes('tail'));
    assert.ok(item, `item not projected: ${JSON.stringify(collections)}`);

    const occurrences = (item.content ?? '').split('Reply').length - 1;
    assert.equal(occurrences, 1,
      `exactly one occurrence sources the label and is removed; the other is a ` +
      `page fact and must survive: ${JSON.stringify(item)}`);
  } finally { await session.close(); }
});

// `controls` was the one overview list still in raw graph order, while the
// contract at the top of core/read.ts — obeyed by regions, headings and
// collections — is named entries first. The cost of the exception is a page
// whose named controls sit late in the document: they fall past the 50-cut
// behind anonymous ones. Measured on the live shopping storefront, ranking
// rescues one named control per truncated overview for +8 bytes.
test('the overview puts named controls before anonymous ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-controls-rank-'));
  // two sized, contentless links (clickable, no accname) ahead of a named
  // button in document order — raw order would show the button last
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>p</title>
    <a href="/1" style="display:inline-block;width:20px;height:20px"></a>
    <a href="/2" style="display:inline-block;width:20px;height:20px"></a>
    <button>Save</button>`);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const controls = overview['controls'] as { ref: string; name: string }[];
    assert.equal(controls.length, 3, `all three controls stay reachable: ${JSON.stringify(controls)}`);
    assert.equal(controls[0]!.name, 'Save',
      `the named control must lead: ${JSON.stringify(controls)}`);
    // ordering may reorder, never remove: the anonymous pair is still there
    assert.equal(controls.filter(c => !c.name).length, 2, JSON.stringify(controls));
  } finally { await session.close(); }
});
