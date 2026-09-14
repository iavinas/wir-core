// Regression for a recall defect — "the runtime saw it and did not show you":
// a control whose only word is its accessible DESCRIPTION compiled with no
// word at all, and no find could return it.
//
// Reproduced on the live Magento admin product page before this was written
// (debug/probe_pagebuilder.mjs, 2026-09-02): after "Edit with Page Builder" the
// stage's exit control is `<i class="icon-pagebuilder-fullscreen-exit"
// title="Close Full Screen">` — visible, a real click listener, and Chrome's AX
// node for it is role generic, name "", description "Close Full Screen" (ARIA
// prohibits naming a generic, so the title lands in the description). The
// compiler read only the AX name; `find {name:"close"}`, `{name:"Close Full
// Screen"}` and `{name:"Full Screen"}` all answered 0, and shopping_admin 464
// spent 15 clicks refused as blocked_by_overlay hunting for the exit. After the
// fix the same find returns the icon with its description, and clicking it
// through `act` leaves full screen.
//
// The fixture is that shape in miniature: a clickable `<i title>` with no text
// and no accname. The second condition is the same word hidden — a title-only
// unrendered control must be disclosed by its title, as text is. The control
// keeps it honest: a word nowhere on the page produces nothing.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>stage</title>' +
  '<h1>Editor</h1>' +
  '<div id="stage" style="position:fixed;inset:0;background:#fff">' +
  // The live shape: an icon control with a title, no text, no accname.
  '<i id="exit" title="Close Full Screen" style="display:inline-block;width:40px;height:40px;background:#ccc"' +
  " onclick=\"document.getElementById('stage').style.display='none';document.getElementById('status').textContent='windowed'\"></i>" +
  // Hidden: a title-only control the unrendered census must still disclose.
  '<i id="restore" title="Restore Window" style="display:none"></i>' +
  '</div>' +
  '<p id="status">full screen</p>';

test('a control whose only word is its accessible description is findable by that word, prints it, and clicks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-ax-description-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const overview = (await session.dispatch({ verb: 'read' })) as Record<string, any>;

    // 1. The word the page gave the control is the word that finds it.
    const full = (await session.dispatch({ verb: 'find', name: 'Close Full Screen' })) as Record<
      string,
      any
    >;
    assert.equal(full['population'].matched, 1, `exactly the icon: ${JSON.stringify(full)}`);
    const icon = full['matches'][0];
    assert.equal(
      icon.role,
      'generic',
      "the role is the browser's own — ARIA forbids naming a generic",
    );
    assert.equal(icon.name, '', 'the accname stays empty: description is never folded into name');
    assert.equal(icon.description, 'Close Full Screen', 'the description, verbatim');
    assert.ok(icon.affordances.includes('clickable'), 'and it is a control');

    // The substring rule is the same one name and text get.
    const close = (await session.dispatch({ verb: 'find', name: 'close' })) as Record<string, any>;
    assert.ok(
      (close['matches'] as { ref: string }[]).some((m) => m.ref === icon.ref),
      'a normalized substring of the description matches',
    );

    // 2. The word travels with every projection of the node, so a nameless
    // control never prints as a bare `generic ""`.
    const control = (overview['controls'] as Record<string, any>[]).find((c) => c.ref === icon.ref);
    assert.ok(control, "the icon is in the overview's controls");
    assert.equal(control!.description, 'Close Full Screen');
    const detail = (await session.dispatch({ verb: 'read', target: icon.ref })) as Record<
      string,
      any
    >;
    assert.equal(detail['node'].description, 'Close Full Screen', 'read target prints it too');

    // 3. Hidden, the same kind of control is disclosed by its title.
    const restore = (await session.dispatch({ verb: 'find', name: 'restore' })) as Record<
      string,
      any
    >;
    assert.equal(restore['population'].matched, 0);
    assert.equal(restore['unrendered']?.count, 1, 'the title-only hidden icon is a lead');
    assert.deepEqual(restore['unrendered'].containers[0].matches, ['Restore Window']);

    // 4. CONTROL: a word nowhere on the page stays absent.
    const absent = (await session.dispatch({ verb: 'find', name: 'zzzznotonthispage' })) as Record<
      string,
      any
    >;
    assert.equal(absent['population'].matched, 0);
    assert.equal(absent['unrendered'], undefined);
    assert.equal(
      absent['empty'].normalization,
      'NFKC, case-folded, whitespace-collapsed substring over name+text+description',
      'the empty result says what domain was searched',
    );

    // 5. It is a real target: the click lands and the page leaves full screen.
    const act = (await session.dispatch({ verb: 'act', ref: icon.ref, action: 'click' })) as Record<
      string,
      any
    >;
    assert.equal(
      act['rejected'],
      undefined,
      `the click is accepted: ${JSON.stringify(act['rejected'])}`,
    );
    assert.equal(act['effect'].verdict, 'verified');
    const after = (await session.dispatch({ verb: 'find', name: 'windowed' })) as Record<
      string,
      any
    >;
    assert.equal(after['population'].matched, 1, 'the stage is gone and the status changed');
  } finally {
    await session.close();
  }
});
