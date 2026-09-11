// Regression for the "present but unrevealed" class: a node that is in the
// document and not rendered is dropped by admission — correctly — but the drop
// was SILENT, so a find for its text answered `matched: 0` with no lead.
//
// Reproduced on the live Magento admin dashboard before this was written
// (debug/probe_unrendered.mjs, 2026-09-02): `find {name:"review"}` returned 0 of
// 229 while the DOMSnapshot held "All Reviews" and "Pending Reviews" inside the
// collapsed Marketing flyout; shopping_admin 771 spent 36 calls circling the
// dashboard and gave up. After the fix the same find discloses 3 unrendered
// matches under two rendered containers, and one click on the Marketing item
// makes `link "All Reviews"` an ordinary match (5 of 286). Reddit's collapsed
// user dropdown ("Log out", a button) confirmed the second shape.
//
// The fixture is the live shape in miniature: a collapsed menu whose items are
// display:none, and a closed <details>. The two controls keep it honest — text
// that is nowhere in the document must produce no lead, and a find that already
// has a rendered answer must not be widened by a hidden duplicate.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = '<!doctype html><title>unrendered</title>'
  + '<h1>Dashboard</h1>'
  + '<ul>'
  // The handler sits on the <li>, as Magento's does: the container itself is
  // what Chrome reports clickable, so the repair is the click on it.
  + '<li id="mk" onclick="document.getElementById(\'sub\').style.display=\'block\'"><a href="#" onclick="return false">Marketing</a>'
  + '<ul id="sub" style="display:none"><li><a href="/reviews">All Reviews</a></li>'
  + '<li><a href="/reviews/pending">Pending Reviews</a></li></ul></li>'
  + '<li><a href="/sales">Sales</a></li>'
  + '</ul>'
  + '<details><summary>Shipping</summary><p>Returns are accepted within 30 days.</p></details>'
  // A rendered copy of a word that also appears hidden: the rendered answer must stand alone.
  + '<p>Sales this week</p>';

test('an empty find discloses unrendered matches under their rendered container, and opening it makes them ordinary matches',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wir-unrendered-'));
    writeFileSync(join(dir, 'a.html'), PAGE);
    const session = await WirSession.start({
      headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    });
    try {
      await session.goto(`file://${join(dir, 'a.html')}`);
      await session.dispatch({ verb: 'read' });

      // 1. The live shape: the text is in the document, nothing rendered carries it.
      const before = await session.dispatch({ verb: 'find', name: 'review' }) as Record<string, any>;
      assert.equal(before['population'].matched, 0, 'precondition: no rendered node matches');
      const u = before['unrendered'];
      assert.ok(u, 'the empty result carries the unrendered block');
      assert.equal(u.count, 2, 'both hidden links are counted, exactly');
      assert.equal(u.estimated, false);
      assert.equal(u.containers.length, 1, 'both sit under one rendered container');
      const c = u.containers[0];
      assert.equal(c.name, 'Marketing', "the container is named by the page's own words");
      assert.deepEqual(c.matches, ['All Reviews', 'Pending Reviews'], 'the hidden texts, verbatim');
      assert.equal(c.matchesTotal, 2);
      assert.equal(c.open, JSON.stringify({ verb: 'act', ref: c.ref, action: 'click' }),
        'the repair is the literal act on the container');
      assert.equal(before['empty'].fallback, c.open, 'and the empty block points at it');

      // The role filter applies to the disclosure exactly as to the matches.
      const asButton = await session.dispatch({ verb: 'find', name: 'review', role: 'button' }) as Record<string, any>;
      assert.equal(asButton['unrendered'], undefined, 'hidden LINKS are not offered to a button query');

      // 2. A closed <details>: hidden prose with no interactive shape is still a lead.
      const prose = await session.dispatch({ verb: 'find', name: '30 days' }) as Record<string, any>;
      assert.equal(prose['population'].matched, 0);
      assert.equal(prose['unrendered']?.count, 1);
      const d = prose['unrendered'].containers[0];
      assert.equal(d.name, 'Shipping', 'the container is the details element, named by its summary');
      // The repair follows the container's own affordance, never a guess: a
      // clickable container gets the click, any other the read that shows its controls.
      assert.equal(d.open, d.affordances.includes('clickable')
        ? JSON.stringify({ verb: 'act', ref: d.ref, action: 'click' })
        : JSON.stringify({ verb: 'read', target: d.ref }));

      // 3. CONTROL: text that is nowhere must not sprout a lead.
      const absent = await session.dispatch({ verb: 'find', name: 'zzzznotonthispage' }) as Record<string, any>;
      assert.equal(absent['population'].matched, 0);
      assert.equal(absent['unrendered'], undefined, 'a genuine absence stays a genuine absence');

      // 4. CONTROL: a rendered answer is not widened by hidden copies.
      const sales = await session.dispatch({ verb: 'find', name: 'Sales' }) as Record<string, any>;
      assert.ok(sales['population'].matched >= 1, 'precondition: Sales is rendered');
      assert.equal(sales['unrendered'], undefined,
        'with a rendered answer and no larger hidden count, nothing is disclosed');

      // 5. Opening the container turns the lead into ordinary, ref-bearing matches.
      const act = await session.dispatch(JSON.parse(c.open)) as Record<string, any>;
      assert.equal(act['rejected'], undefined, `the open act is accepted: ${JSON.stringify(act['rejected'])}`);
      const after = await session.dispatch({ verb: 'find', name: 'review', role: 'link' }) as Record<string, any>;
      const names = (after['matches'] as { name: string }[]).map(m => m.name);
      assert.deepEqual(names, ['All Reviews', 'Pending Reviews'], 'the hidden links are now real matches');
      assert.equal(after['unrendered'], undefined, 'and nothing hidden remains to disclose');
    } finally {
      await session.close();
    }
  });
