// Regression for the "named the wrong thing, offered no way out" class of
// blocked_by_overlay: the refusal named the element under the pointer and
// told the caller to find it, which on Page Builder's full-screen stage was a
// panel heading INSIDE the overlay ("Elements"); the model then searched
// "close" / "X" / "exit" through 15 refusals while the exit control —
// `<i title="Close Full Screen">`, in the graph as a generic with that
// description and a clickable affordance — was never named.
//
// Reproduced on the live Magento admin before this was written
// (debug/probe_top_layer.mjs --site pagebuilder, 2026-09-02): after the fix
// the same refusal names the stage wrapper as the layer (position fixed),
// lists the exit by its description with a literal `act click` continuation,
// and performing that continuation lifts the stage so the covered click
// succeeds. GitLab's keyboard-shortcuts modal confirmed the second shape.
//
// The fixture is both shapes in miniature: a fixed full-screen overlay whose
// only exit is a title-only icon, and a modal <dialog> whose only control is
// a `form method=dialog` button carrying no dismissal word at all. The two
// controls keep it honest — a click that reaches its target is not refused,
// and a click covered by a layer with no dismiss control says so rather than
// inventing one.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>top layer</title>' +
  '<h1>Product</h1>' +
  '<p><a id="behind" href="/x">Show / Hide Editor</a></p>' +
  '<p><a id="free" href="/y">Uncovered link</a></p>' +
  // A modal <dialog>: in the browser's top layer once showModal() runs. Its
  // one button says "OK" — no word from the dismissal list — and closes the
  // dialog only because its form's method is dialog.
  '<dialog id="dlg"><h2>Confirm</h2><form method="dialog"><button id="ok">OK</button></form></dialog>' +
  // The stage: fixed, full-screen, z-index 800, a bare div with no name of
  // its own; an absolutely-positioned panel inside it carries the heading the
  // hit-test lands on, and a title-only icon is the only exit.
  '<div id="stage" style="position:fixed;inset:0;z-index:800;background:rgba(255,255,255,.5)">' +
  '<div style="position:absolute;top:0;left:0;width:100%;height:100%"><h3>Elements</h3>' +
  '<span><i id="exit" title="Close Full Screen" style="display:inline-block;width:40px;height:40px"' +
  ' onclick="document.getElementById(\'stage\').remove()"></i></span></div></div>' +
  // A second fixed layer with NO dismiss control, shown on demand. Its words
  // are neutral on purpose: "Loading" here would now make it a loading
  // indicator (test/transient-overlay-wait.test.ts pins that class), and this
  // case is the layer no rule classifies — nothing to dismiss, nothing to wait on.
  '<div id="bare" hidden style="position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.3)"><p>Members only</p></div>';

test('a covered click names the overlay root and lists its own dismiss controls; a top-layer element is a region in read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-top-layer-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    const page = session.host.page;
    const overlayRepair = /(\{"verb":"act","ref":"[^"]+","action":"click"\})/;

    // 1. The Page Builder shape: a fixed stage, a title-only exit.
    const behind = (await session.dispatch({ verb: 'find', name: 'Show / Hide Editor' })) as Record<
      string,
      any
    >;
    const ref = behind['matches'][0].ref as string;
    const blocked = (await session.dispatch({ verb: 'act', ref, action: 'click' })) as Record<
      string,
      any
    >;
    assert.equal(blocked['rejected']?.kind, 'blocked_by_overlay');
    const reason = blocked['rejected'].reason as string;
    const repair = blocked['rejected'].repair as string;
    assert.match(
      reason,
      /received by div "Elements" instead/,
      'the element under the pointer is still named',
    );
    assert.match(
      reason,
      /covered by div #stage "Elements" \(position fixed/,
      'the LAYER is named — the fixed stage, not the absolute panel or the heading',
    );
    assert.match(
      repair,
      /"description":"Close Full Screen"/,
      'the exit is listed by its description',
    );
    assert.match(
      repair,
      /Re-reading will NOT help: the page has not changed, something is layered over it\./,
    );
    const cont = overlayRepair.exec(repair);
    assert.ok(cont, 'a literal act click continuation is offered');
    const exit = (await session.dispatch({ verb: 'find', name: 'Close Full Screen' })) as Record<
      string,
      any
    >;
    assert.equal(
      JSON.parse(cont[1] as string).ref,
      exit['matches'][0].ref,
      'and it is the exit control itself',
    );

    // CONTROL: a click that reaches its target is not an overlay question.
    // (The stage covers the whole viewport, so this is checked after the exit.)
    const lifted = (await session.dispatch(JSON.parse(cont[1] as string))) as Record<string, any>;
    assert.equal(
      lifted['rejected'],
      undefined,
      `the continuation is accepted: ${JSON.stringify(lifted['rejected'])}`,
    );
    const again = (await session.dispatch({ verb: 'act', ref, action: 'click' })) as Record<
      string,
      any
    >;
    assert.equal(again['rejected'], undefined, 'the same click now reaches its target');

    // 2. A layer with nothing that looks like a dismissal says so — no invented control.
    await page.goto(`file://${join(dir, 'a.html')}`);
    await page.evaluate(() => {
      document.getElementById('stage')!.remove();
      document.getElementById('bare')!.hidden = false;
    });
    const link = (await session.dispatch({ verb: 'find', name: 'Uncovered link' })) as Record<
      string,
      any
    >;
    const bare = (await session.dispatch({
      verb: 'act',
      ref: link['matches'][0].ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(bare['rejected']?.kind, 'blocked_by_overlay');
    assert.match(bare['rejected'].reason, /covered by div #bare "Members only" \(position fixed/);
    assert.doesNotMatch(
      bare['rejected'].reason,
      /loading indicator/,
      'no rule fires for a bare layer with neutral words',
    );
    assert.match(
      bare['rejected'].repair,
      /^no control inside the overlay carries a dismissal word/,
    );
    assert.match(
      bare['rejected'].repair,
      /cannot take keyboard focus/,
      'no key path is invented for an unfocusable root',
    );
    assert.doesNotMatch(bare['rejected'].repair, /"action":"click"/);

    // 3. The <dialog> shape: top layer, and a form method=dialog button with no dismissal word.
    await page.goto(`file://${join(dir, 'a.html')}`);
    await page.evaluate(() => {
      document.getElementById('stage')!.remove();
      (document.getElementById('dlg') as HTMLDialogElement).showModal();
    });
    const overview = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    const regions = overview['regions'] as { ref: string; role: string; topLayer?: boolean }[];
    const dlg = regions.find((r) => r.topLayer === true);
    assert.ok(dlg, `the open modal is a region in the overview: ${JSON.stringify(regions)}`);
    assert.equal(dlg.role, 'dialog');
    assert.equal(regions[0], dlg, 'and it is listed first');
    const under = (await session.dispatch({ verb: 'find', name: 'Uncovered link' })) as Record<
      string,
      any
    >;
    const covered = (await session.dispatch({
      verb: 'act',
      ref: under['matches'][0].ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(covered['rejected']?.kind, 'blocked_by_overlay');
    assert.match(
      covered['rejected'].reason,
      new RegExp(`covered by dialog ${dlg.ref} \\(in the browser's top layer\\)`),
      'the dialog is named by its ref, as a top-layer root',
    );
    assert.match(
      covered['rejected'].repair,
      /\(or that submit a form method=dialog\): \[\{"ref":"[^"]+","role":"button","name":"OK"\}\]/,
      'the method=dialog button is listed although it carries no dismissal word',
    );
    const close = overlayRepair.exec(covered['rejected'].repair);
    assert.ok(close);
    const closed = (await session.dispatch(JSON.parse(close[1] as string))) as Record<string, any>;
    assert.equal(closed['rejected'], undefined);
    const after = (await session.dispatch({ verb: 'read' })) as Record<string, any>;
    assert.equal(
      (after['regions'] as { topLayer?: boolean }[]).some((r) => r.topLayer),
      false,
      'the closed dialog leaves the top layer, and the overview',
    );

    // 4. CONTROL: with no layer, an uncovered click is simply delivered.
    const free = (await session.dispatch({ verb: 'find', name: 'Uncovered link' })) as Record<
      string,
      any
    >;
    const ok = (await session.dispatch({
      verb: 'act',
      ref: free['matches'][0].ref,
      action: 'click',
    })) as Record<string, any>;
    assert.equal(ok['rejected'], undefined, JSON.stringify(ok['rejected']));
  } finally {
    await session.close();
  }
});
