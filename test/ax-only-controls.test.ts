// Controls the accessibility tree reports and the DOM snapshot does not.
//
// The graph is a DOMSnapshot-AX join on backendNodeId, and it assumed the
// snapshot was the superset. Chrome's CSS carousel pseudo-elements break that:
// `::scroll-button()` renders as a focusable `button`, `::scroll-marker` as a
// `tab`, `::scroll-marker-group` as a `tablist` — each with a real backend node
// id that DOM.describeNode, DOM.getContentQuads and getPartialAXTree answer for,
// and none of them in DOMSnapshot's node walk (which carries ::before/::after
// only). Measured on https://chrome.dev/carousel/horizontal/cards/ (2026-09-02):
// the AX tree held "Scroll Left"/"Scroll Right" and five named tabs; `find
// role=button` returned 0, `find role=tab` 0, and `read` said controlsTotal 48
// with nothing withheld. The runtime saw them and did not show them — the
// zero-tolerance recall class — while a coordinate click on the button's quad
// scrolled the carousel, so they were exactly as actionable as any DOM button.
//
// FIXTURE JUSTIFIED: the live page is chrome.dev, and a regression cannot
// depend on the network. One page, one proven condition: a scroller whose
// buttons and markers exist only as pseudo-elements. Evidence:
// docsV2/plans/evidence/wt-recall-audits.md.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>carousel</title>
<style>
  .carousel { display: flex; width: 300px; overflow-x: auto; scroll-snap-type: x mandatory;
    scroll-marker-group: after; }
  .carousel::scroll-button(inline-start) { content: "\\2190" / "Scroll Left"; }
  .carousel::scroll-button(inline-end) { content: "\\2192" / "Scroll Right"; }
  .carousel::scroll-marker-group { display: flex; gap: 8px; }
  .slide { flex: 0 0 300px; height: 120px; scroll-snap-align: start; }
  .slide::scroll-marker { content: "" / "Slide"; width: 16px; height: 16px; border: 1px solid; }
  .slide:nth-child(1)::scroll-marker { content: "" / "Alpha"; }
  .slide:nth-child(2)::scroll-marker { content: "" / "Bravo"; }
  .slide:nth-child(3)::scroll-marker { content: "" / "Charlie"; }
</style>
<main>
  <div class="carousel">
    <div class="slide">one</div>
    <div class="slide">two</div>
    <div class="slide">three</div>
  </div>
</main>`;

test('pseudo-element carousel controls are in find, in read.controls, and act reaches them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-ax-only-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    // The oracle: what the browser itself says exists. If this Chromium does not
    // render carousel pseudo-elements, there is nothing to withhold and the
    // condition is absent, not passed.
    const rendered = await session.host.page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.carousel')!, '::scroll-button(inline-end)')
          .content,
    );
    assert.ok(
      rendered.includes('Scroll Right'),
      `this Chromium renders ::scroll-button: ${rendered}`,
    );

    const buttons = await session.dispatch({ verb: 'find', role: 'button' });
    const names = ((buttons['matches'] ?? []) as { name?: string }[]).map((m) => m.name);
    assert.deepEqual(
      [...names].sort(),
      ['Scroll Left', 'Scroll Right'],
      `both scroll buttons the AX tree names must be findable: ${JSON.stringify(buttons)}`,
    );
    const tabs = await session.dispatch({ verb: 'find', role: 'tab' });
    const tabMatches = (tabs['matches'] ?? []) as {
      ref: string;
      name?: string;
      state?: Record<string, unknown>;
    }[];
    assert.deepEqual(
      tabMatches.map((m) => m.name),
      ['Alpha', 'Bravo', 'Charlie'],
      `every scroll marker is a tab with its own alt text: ${JSON.stringify(tabs)}`,
    );

    // Recall through read as well: a control find returns and read omits, while
    // read reports nothing withheld, is the same defect at the other verb.
    const overview = await session.dispatch({ verb: 'read' });
    const controls = (overview['controls'] ?? []) as { ref: string; name?: string }[];
    const right = ((buttons['matches'] ?? []) as { ref: string; name?: string }[]).find(
      (m) => m.name === 'Scroll Right',
    )!;
    assert.ok(
      controls.some((c) => c.ref === right.ref),
      `read.controls must hold the button find returns: ${JSON.stringify(controls.map((c) => c.name))}`,
    );

    // And the ref is one act can drive: the same backend id, the same
    // revalidation, a real hit point. The oracle is the scroller's own position.
    const before = await session.host.page.evaluate(
      () => document.querySelector('.carousel')!.scrollLeft,
    );
    const clicked = await session.dispatch({ verb: 'act', ref: right.ref, action: 'click' });
    assert.equal(
      clicked['outcome'],
      'delivered',
      `click must not be refused: ${JSON.stringify(clicked)}`,
    );
    await session.host.page.waitForTimeout(600);
    const after = await session.host.page.evaluate(
      () => document.querySelector('.carousel')!.scrollLeft,
    );
    assert.ok(after > before, `the scroll button must move the carousel: ${before} -> ${after}`);

    // A tab click is verified by the browser's own state: the marker's
    // `selected` follows scroll position, and act's revalidation reads it.
    const bravo = tabMatches.find((m) => m.name === 'Charlie')!;
    const tabbed = await session.dispatch({ verb: 'act', ref: bravo.ref, action: 'click' });
    const effect = tabbed['effect'] as { verdict?: string; evidence?: string } | undefined;
    assert.equal(effect?.verdict, 'verified', `tab click must verify: ${JSON.stringify(tabbed)}`);
    assert.equal(effect?.evidence, 'target_state_changed');
    const selected = await session.dispatch({ verb: 'find', role: 'tab', state: 'selected' });
    assert.deepEqual(
      ((selected['matches'] ?? []) as { name?: string }[]).map((m) => m.name),
      ['Charlie'],
      `selection moved with no DOM mutation, so the graph must not have been re-served: ${JSON.stringify(selected)}`,
    );
  } finally {
    await session.close();
  }
});
