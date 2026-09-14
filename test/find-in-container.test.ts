// Two find matches printed byte-identical apart from the ref — `generic ""
// text:"Content"` twice — on the Magento product edit page (shopping_admin 464,
// arm 4, rows 76-82): the admin nav flyout's label under the `navigation`
// landmark, and the product form's collapsible section header under `main`.
// The model clicked the first, the flyout opened, and the field the task
// needed was never found. The graph held both parent chains the whole time.
//
// Reproduced through the agent's path in debug/probe_find_context.mjs, before
// and after (docsV2/plans/evidence/wt-find-context-{before,after}.txt).
//
// FIXTURE JUSTIFIED: the chain case needs two containers that READ the same
// (same role and name, different nodes) under different landmarks, which no
// probed page produced on demand.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

type Container = { ref: string; role: string; name?: string };
type Match = {
  ref: string;
  role: string;
  name: string;
  text?: string;
  in?: Container | Container[];
};

const PAGE = `<!doctype html><title>in</title>
<nav><ul><li><a href="#"><span>Content</span></a></li></ul></nav>
<main>
  <form aria-label="Product">
    <section><h2>Basics</h2><div><span>Content</span></div></section>
  </form>
  <p><span>Only once</span></p>
  <section aria-label="Panel"><div><span>Twin</span></div></section>
</main>
<aside><section aria-label="Panel"><div><span>Twin</span></div></section></aside>`;

async function open(): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-in-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  await session.goto(`file://${dir}/a.html`);
  return session;
}

test('two matches that print alike are told apart by `in`', async () => {
  const session = await open();
  try {
    const r = await session.dispatch({ verb: 'find', name: 'Content' });
    const generics = ((r['matches'] ?? []) as Match[]).filter((m) => m.role === 'generic');
    assert.equal(generics.length, 2, JSON.stringify(r));
    const [a, b] = generics as [Match, Match];
    assert.ok(a.in && b.in, `both must carry in: ${JSON.stringify(generics)}`);
    assert.notDeepEqual(a.in, b.in, `in must differ: ${JSON.stringify(generics)}`);
    const roles = generics.map((m) => (m.in as Container).role).sort();
    // Nearest first: the nav one sits in its link (a named container), the form
    // one in the form — the page's own landmark, not an invented label.
    assert.deepEqual(roles, ['form', 'link'], JSON.stringify(generics));
    const inForm = generics.find((m) => (m.in as Container).role === 'form')!;
    assert.equal((inForm.in as Container).name, 'Product', JSON.stringify(inForm));
    // The link's container is printed with its name, so the reader sees the
    // words, not just a role.
    const inLink = generics.find((m) => (m.in as Container).role === 'link')!;
    assert.equal((inLink.in as Container).name, 'Content', JSON.stringify(inLink));
  } finally {
    await session.close();
  }
});

test('a unique match carries no `in` in find; its read does', async () => {
  // Measured cost decided this: `in` on every match was +35.5% on a 20-link
  // find of a busy admin page (evidence file), so a match nothing collides
  // with does not pay for it, and read {target} — one node — always says.
  const session = await open();
  try {
    const r = await session.dispatch({ verb: 'find', name: 'Only once' });
    const matches = (r['matches'] ?? []) as Match[];
    assert.equal(matches.length, 1, JSON.stringify(r));
    assert.equal(matches[0]!.in, undefined, JSON.stringify(matches));
    const d = await session.dispatch({ verb: 'read', target: matches[0]!.ref });
    const node = d['node'] as { in?: Container };
    assert.equal(node.in?.role, 'main', JSON.stringify(d['node']));
  } finally {
    await session.close();
  }
});

test('when the nearest containers read the same, `in` is the chain until they differ', async () => {
  const session = await open();
  try {
    const r = await session.dispatch({ verb: 'find', name: 'Twin' });
    const matches = (r['matches'] ?? []) as Match[];
    assert.equal(matches.length, 2, JSON.stringify(r));
    for (const m of matches) {
      assert.ok(Array.isArray(m.in), `a chain, nearest first: ${JSON.stringify(matches)}`);
      const chain = m.in as Container[];
      assert.equal(chain.length, 2, JSON.stringify(chain));
      assert.equal(chain[0]!.role, 'region');
      assert.equal(chain[0]!.name, 'Panel');
    }
    const outer = matches.map((m) => (m.in as Container[])[1]!.role).sort();
    assert.deepEqual(outer, ['complementary', 'main'], JSON.stringify(matches));
  } finally {
    await session.close();
  }
});
