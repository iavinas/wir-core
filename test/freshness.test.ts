// Regression for the freshness defect reproduced in the probe on 2026-08-05
// (debug/runs/probe/2026-08-05T11-38-43-087Z/events.jsonl): a page that grew from
// 20 to 40 links with no navigation and no act was re-served from cache at 20
// controls and stamped `freshness: "live"`. The graph cache was keyed on the epoch
// alone, so the only same-document invalidation in the runtime was the one after
// an act — and docs/vision.md §Freshness promised a mutation-driven mechanism that
// did not exist. That is the zero-tolerance recall class: the runtime saw it and
// did not show it.
// Fixtures justified: same-document growth WITHOUT an act cannot be produced on a
// real page through the verbs (the probe has no scroll and no timer), and the
// shadow-tree condition needs a page whose content the observer provably cannot
// reach. One page per proven condition, no farm.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const fixture = (name: string, html: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-freshness-'));
  const path = join(dir, name);
  writeFileSync(path, html);
  return `file://${path}`;
};

test('same-document growth is never re-served as live stale content', async () => {
  const url = fixture('lazy.html', `<!doctype html><title>lazy</title><h1>Feed</h1><ul id="l"></ul><script>
let n = 0;
const add = () => { for (let i = 0; i < 20; i++) {
  const li = document.createElement('li');
  li.innerHTML = '<a href="/p' + (++n) + '">Post number ' + n + '</a>';
  document.getElementById('l').appendChild(li); } };
add(); setTimeout(add, 400);
</script>`);

  const session = await WirSession.start({ headless: true, expectedAction: 'RETRIEVE' });
  try {
    await session.goto(url);
    const first = await session.dispatch({ verb: 'read' });
    assert.equal(first['controlsTotal'], 20, JSON.stringify(first));

    // The anti-case, and the half that keeps the cache real: an unchanged document
    // must still be served from cache and may then honestly claim `live`. Without
    // this, "recompile every call" would pass the test above.
    const unchanged = await session.dispatch({ verb: 'read' });
    assert.equal(unchanged['freshness'], 'live', JSON.stringify(unchanged));
    assert.equal(unchanged['controlsTotal'], 20);

    // The page grows on its own timer: no navigation, no act, same epoch.
    await session.host.page.waitForFunction(() => document.querySelectorAll('a[href]').length === 40);
    const grown = await session.dispatch({ verb: 'read' });

    assert.equal(grown['documentEpoch'], first['documentEpoch'], 'growth must not fake a new document');
    assert.equal(grown['controlsTotal'], 40,
      `the runtime saw 40 links and returned ${String(grown['controlsTotal'])}: ${JSON.stringify(grown)}`);
    assert.notEqual(grown['freshness'], 'live',
      `a result compiled before the growth may never be stamped live: ${JSON.stringify(grown)}`);
  } finally {
    await session.close();
  }
});

test('a document holding shadow content is never vouched for as live', async () => {
  // Measured (scratchpad shadow probes, 2026-08-05): DOMSnapshot compiles shadow
  // trees — open and closed — into the top document, so `find` returns their links;
  // a MutationObserver reaches neither, and arming roots as they are added cannot
  // fix it (attachShadow follows insertion and emits no record). The graph must
  // therefore refuse to be cached, or `live` would be a lie on any such page.
  const url = fixture('shadow.html', `<!doctype html><title>shadow</title><h1>Host</h1>
<a href="/light">Light link</a><div id="h"></div><script>
document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML =
  '<a href="/s1">Shadow link one</a>';
</script>`);

  const session = await WirSession.start({ headless: true, expectedAction: 'RETRIEVE' });
  try {
    await session.goto(url);
    const links = await session.dispatch({ verb: 'find', role: 'link' });
    const names = (links['matches'] as { name: string }[]).map(m => m.name);
    assert.ok(names.includes('Shadow link one'), `shadow content is compiled: ${JSON.stringify(names)}`);

    // Two identical reads back to back: the second cannot claim `live`, because
    // nothing in the runtime can prove the shadow tree did not change.
    await session.dispatch({ verb: 'read' });
    const second = await session.dispatch({ verb: 'read' });
    assert.equal(second['freshness'], 'recompiled', JSON.stringify(second));
  } finally {
    await session.close();
  }
});
