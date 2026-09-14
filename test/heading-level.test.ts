// `h1` through `h6` all compile to the role `heading`, and no projection ever
// emitted the tag — so the overview's heading list was a flat sequence of
// names. On a page with 189 headings that is a list, not an outline: nothing
// says which are sections and which are items inside them, which is the one
// thing a heading list exists to convey.
//
// Level comes from the browser's own AX `level` property (confirmed present in
// the local browser_protocol.json snapshot's AXPropertyName enum) rather than
// from the tag, so `<div role="heading" aria-level="3">` is level 3 exactly as
// `<h3>` is. Deriving it from `h1`-`h6` would have handled the common case and
// silently mislabelled every ARIA heading as unknown.
//
// FIXTURE JUSTIFIED: needs a known outline — every level present, in a
// scrambled order so a passing result cannot come from document position, plus
// an ARIA heading whose level lives only in an attribute.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>outline</title>
<main>
  <h2>section two</h2>
  <h4>deep four</h4>
  <h1>top one</h1>
  <div role="heading" aria-level="3">aria three</div>
  <h6>deepest six</h6>
</main>`;

test('the heading list carries the level that makes it an outline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-outline-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const headings = (overview['headings'] ?? []) as { name: string; level?: number }[];
    const levelOf = new Map(headings.map((h) => [h.name, h.level]));

    for (const [name, want] of [
      ['top one', 1],
      ['section two', 2],
      ['deep four', 4],
      ['deepest six', 6],
    ] as [string, number][]) {
      assert.equal(
        levelOf.get(name),
        want,
        `"${name}" must report level ${want}: ${JSON.stringify(headings)}`,
      );
    }

    // The ARIA heading is the case a tag-derived level would have missed.
    assert.equal(
      levelOf.get('aria three'),
      3,
      `an aria-level heading must carry its level: ${JSON.stringify(headings)}`,
    );
  } finally {
    await session.close();
  }
});

test('a non-heading carries no level', async () => {
  // `level` on anything else would be an invented fact. The AX tree computes
  // `level` for list items and tree items too, so gating on the heading role is
  // load-bearing, not decoration.
  const dir = mkdtempSync(join(tmpdir(), 'wir-outline-neg-'));
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>neg</title>
    <main><h2>a heading</h2><ul><li>an item</li><li>another item</li></ul></main>`,
  );
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const headings = (overview['headings'] ?? []) as { name: string; level?: number }[];
    assert.ok(
      !headings.some((h) => h.name === 'an item'),
      `a list item is not a heading: ${JSON.stringify(headings)}`,
    );
    assert.equal(headings.find((h) => h.name === 'a heading')?.level, 2, JSON.stringify(headings));
  } finally {
    await session.close();
  }
});
