// Every relative href was resolved against the TOP PAGE URL. Two documents
// resolve differently from that, and the compiler folds both into one graph:
//
//   - a page carrying `<base href>` redirects resolution for its whole document
//     (Magento serves one), and
//   - an iframe resolves against its own document, not its parent's.
//
// So `href` named a URL the page would never navigate to. That is not cosmetic:
// `href` feeds act's navigation verdict, and a verdict computed against a URL
// the click could not produce is a false `contradicted` — the failure
// lessons.md records as having poisoned attempt 6's world model.
//
// The fix resolves against the owning document's `baseURL`, which CDP defines
// as "Base URL that Document or FrameOwner node uses for URL completion"
// (verified in the local browser_protocol.json snapshot) — i.e. exactly the
// base the browser itself would use, `<base href>` included.
//
// FIXTURE JUSTIFIED: needs a document whose base differs from its URL, and a
// child document whose base differs from its parent's. Neither can be asked of
// a real site on demand, and the assertion is about an exact string.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Read at the graph, not through a verb, because `href` is not projected by any
// of them — `nodeDetail` never emits it. It is compiled for act's navigation
// verdict alone, so the graph IS the surface under test here. (That the model
// cannot see a link's destination at all is a separate finding, recorded in
// debug/NEXT.md, and not something to change from inside a regression test.)
async function hrefOf(session: WirSession, name: string): Promise<string> {
  const found = await session.dispatch({ verb: 'find', name });
  const ref = ((found['matches'] ?? []) as { ref: string }[])[0]?.ref;
  assert.ok(ref, `link ${JSON.stringify(name)} not found: ${JSON.stringify(found)}`);
  const g = await (
    session as unknown as {
      ensureGraph(): Promise<{ nodes: Map<string, { href: string | null }> }>;
    }
  ).ensureGraph();
  return g.nodes.get(ref)?.href ?? '';
}

test('<base href> is the resolution base, not the page URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-base-'));
  mkdirSync(join(dir, 'deep'));
  writeFileSync(
    join(dir, 'deep', 'a.html'),
    `<!doctype html><title>based</title><base href="/elsewhere/">
     <a href="target.html">go there</a>`,
  );

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/deep/a.html`);
    const href = await hrefOf(session, 'go there');
    // The browser would fetch /elsewhere/target.html. Resolving against the page
    // URL gives .../deep/target.html — a path the page never points at.
    assert.match(
      href,
      /\/elsewhere\/target\.html$/,
      `href must resolve against <base href>: ${href}`,
    );
    assert.ok(
      !/\/deep\/target\.html$/.test(href),
      `href resolved against the page URL instead of its base: ${href}`,
    );
  } finally {
    await session.close();
  }
});

test("a frame's relative href resolves against the frame, not the parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-base-frame-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(
    join(dir, 'sub', 'child.html'),
    '<!doctype html><title>child</title><a href="inner.html">frame link</a>',
  );
  writeFileSync(
    join(dir, 'a.html'),
    `<!doctype html><title>host</title><h1>Host</h1>
    <a href="outer.html">host link</a>
    <iframe src="sub/child.html" width="400" height="200"></iframe>`,
  );

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);

    // The frame's link resolves inside sub/ ...
    const inner = await hrefOf(session, 'frame link');
    assert.match(
      inner,
      /\/sub\/inner\.html$/,
      `a frame's href must resolve against the frame's document: ${inner}`,
    );

    // ... and the host's link is unchanged, so the fix is per-document rather
    // than a blanket re-base.
    const outer = await hrefOf(session, 'host link');
    assert.match(outer, /\/outer\.html$/, outer);
    assert.ok(!/\/sub\//.test(outer), `the host's href was re-based into the frame: ${outer}`);
  } finally {
    await session.close();
  }
});
