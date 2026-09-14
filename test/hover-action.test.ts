// `hover` — the eighth action. Click's first half and nothing more.
//
// EARNED BY A FAILING CASE, not a hunch (docs/vision.md, deferred features).
// The browser-use stress test's hover task listens for `mouseenter` on a bare
// <div>. With seven actions there was no call that could produce one: `act click`
// on it returned unknown/no_observable_change_yet and scored nothing, because a
// click's mouseMoved is followed by press+release, and the task's own listener
// pair (mouseenter starts a 1000 ms timer, mouseleave cancels it) is not what a
// click expresses. A whole class of web UI is reachable no other way — CSS
// :hover menus, tooltips, and any mouseenter listener.
//
// WHAT IT DOES NOT DO, and each is load-bearing:
//   - no press, no release. It is a pointer move, full stop.
//   - it does not LEAVE. The pointer stays where it was put, exactly as a human's
//     would, so a :hover menu it opened is still open for the next act. That is
//     the entire point of hovering a menu.
//   - it does not wait. The stress test wants a second of dwell; that is time
//     passing, not something an act should block on.
//
// Verified on the real page before this was written: the target received
// ["mouseover","mouseenter","mousemove"] and the task scored after the dwell.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>hover</title><h1>Hover</h1>' +
  '<div id="t" style="width:200px;height:60px;background:#eee">Hover over me</div>' +
  '<button id="b">Button</button>' +
  '<script>' +
  'window.seen = [];' +
  'const t = document.getElementById("t");' +
  'for (const e of ["mouseover","mouseenter","mousemove","mousedown","mouseup","click"]) {' +
  '  t.addEventListener(e, () => window.seen.push(e));' +
  '}' +
  '</script>';

async function withPage(fn: (s: WirSession) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-hover-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await fn(session);
  } finally {
    await session.close();
  }
}

const findRef = async (s: WirSession, name: string): Promise<string> => {
  await s.dispatch({ verb: 'read' });
  const r = (await s.dispatch({ verb: 'find', name })) as Record<string, any>;
  const m = (r['matches'] ?? [])[0];
  assert.ok(m, `precondition: ${name} is findable: ${JSON.stringify(r['matches'])}`);
  return m.ref;
};

test('hover delivers mouseenter to a plain div', async () => {
  await withPage(async (s) => {
    const ref = await findRef(s, 'Hover over me');
    const r = (await s.dispatch({ verb: 'act', ref, action: 'hover' })) as Record<string, any>;
    assert.equal(r['rejected'], undefined, `accepted: ${JSON.stringify(r['rejected'])}`);
    const seen = await s.host.page.evaluate(() => (window as any).seen as string[]);
    assert.ok(
      seen.includes('mouseenter'),
      `mouseenter delivered — the whole reason this action exists: ${JSON.stringify(seen)}`,
    );
    assert.ok(seen.includes('mouseover'), `and mouseover: ${JSON.stringify(seen)}`);
  });
});

test('CONTROL — hover presses nothing, so it is not a click', async () => {
  // If hover ever grew a press, every :hover menu probe would also activate
  // whatever it hovered. The distinction IS the action.
  await withPage(async (s) => {
    const ref = await findRef(s, 'Hover over me');
    await s.dispatch({ verb: 'act', ref, action: 'hover' });
    const seen = await s.host.page.evaluate(() => (window as any).seen as string[]);
    assert.equal(
      seen.filter((e) => e === 'mousedown').length,
      0,
      `no mousedown: ${JSON.stringify(seen)}`,
    );
    assert.equal(seen.filter((e) => e === 'mouseup').length, 0, 'no mouseup');
    assert.equal(
      seen.filter((e) => e === 'click').length,
      0,
      `and above all no click: ${JSON.stringify(seen)}`,
    );
  });
});

test('CONTROL — click still delivers the full press, unchanged', async () => {
  // hover was inserted as a branch BEFORE click's. If that branch ever swallowed
  // click, every click on the site would silently become a hover.
  await withPage(async (s) => {
    const ref = await findRef(s, 'Hover over me');
    await s.dispatch({ verb: 'act', ref, action: 'click' });
    const seen = await s.host.page.evaluate(() => (window as any).seen as string[]);
    assert.ok(seen.includes('mousedown'), `click still presses: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('mouseup'), 'and releases');
    assert.ok(seen.includes('click'), 'and clicks');
  });
});
