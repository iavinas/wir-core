// Regressions for review finding R10: act-time revalidation was incomplete.
// (1) The name check was skipped entirely for refs minted with an empty accname,
//     so a node that had SINCE acquired a name — the clearest sign the backend id
//     now points at different content — revalidated clean.
// (2) probe.role was fetched and never compared at all.
//
// The predicate that ships is narrower than "compare role always", because that
// reading fails this step's own no-new-false-stale bar. Measured on 517 act
// targets across 9 authenticated live GitLab pages
// (debug/runs/scratch/revalidation_candidates.mjs):
//     derived-role vs raw AX probe .................. 9 false stales
//     raw-vs-raw, 'none' normalised to a value ...... 1 false stale
//     raw-vs-raw, only where BOTH sides have a role . 0 false stales
//     empty-name -> now-named drift .................. 0 false stales
// getPartialAXTree reports 'none' for nodes the full tree gave a real role, so
// only the last two merge. The recorded trajectories cannot serve as the replay
// bar here: they carry compile-time names and roles but not the act-time probe
// values the predicate reads, so the live sweep is the adequate check.
//
// The executor is driven directly because the session drops its cached graph
// after every act; these cases need a graph compiled BEFORE the page moves,
// which is exactly the stale-identity condition. Real Chromium, real CDP.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirHost } from '../src/host.js';
import { compile } from '../src/compiler.js';
import { ActExecutor } from '../src/act.js';
import type { WirGraph } from '../src/types.js';

async function stage(html: string): Promise<{ host: WirHost; graph: WirGraph; executor: ActExecutor }> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-reval-'));
  writeFileSync(join(dir, 'a.html'), html);
  const host = await WirHost.launch({ headless: true });
  await host.goto(`file://${dir}/a.html`);
  const graph = compile(await host.captureFacts());
  return { host, graph, executor: new ActExecutor(host, () => host.drainBrowserEvents()) };
}

const refOfTag = (graph: WirGraph, id: string, tag: string): string => {
  const node = [...graph.nodes.values()].find(n => n.tag === tag && n.geometry !== null && n.name === '');
  assert.ok(node, `nameless ${tag} (${id}) must compile`);
  return node.ref;
};

test('a ref minted nameless is stale once the node acquires a name', async () => {
  const { host, graph, executor } = await stage(
    `<!doctype html><title>a</title><h1>Host</h1>
     <button id="b" style="width:120px;height:28px"></button>`);
  try {
    const ref = refOfTag(graph, 'b', 'button');
    await host.page.evaluate(() => {
      (document.getElementById('b') as HTMLElement).textContent = 'Now Named';
    });
    const result = await executor.act(graph, { ref, action: 'click' }, () => host.currentEpoch());
    assert.ok('rejected' in result, `expected stale_ref: ${JSON.stringify(result)}`);
    assert.equal(result.rejected.kind, 'stale_ref', JSON.stringify(result));
    assert.match(result.rejected.reason, /now reads "Now Named"/, JSON.stringify(result));
  } finally { await host.close(); }
});

test('a role change on a stable name is stale', async () => {
  const { host, graph, executor } = await stage(
    `<!doctype html><title>a</title><h1>Host</h1>
     <div id="d" role="button" aria-label="Stable Label" style="width:120px;height:28px"></div>`);
  try {
    const node = [...graph.nodes.values()].find(n => n.name === 'Stable Label');
    assert.ok(node, 'the labelled control must compile');
    assert.equal(node.axRole, 'button', 'the raw AX role is what revalidation compares');
    await host.page.evaluate(() => {
      document.getElementById('d')!.setAttribute('role', 'link');
    });
    const result = await executor.act(graph, { ref: node.ref, action: 'click' }, () => host.currentEpoch());
    assert.ok('rejected' in result, `expected stale_ref: ${JSON.stringify(result)}`);
    assert.equal(result.rejected.kind, 'stale_ref', JSON.stringify(result));
    assert.match(result.rejected.reason, /role/, JSON.stringify(result));
  } finally { await host.close(); }
});

// The no-new-false-stale bar, pinned: an unchanged nameless control still acts.
test('an unchanged nameless control is not falsely stale', async () => {
  const { host, graph, executor } = await stage(
    `<!doctype html><title>a</title><h1>Host</h1>
     <button id="b" style="width:120px;height:28px"
       onclick="document.title='CLICKED'"></button>`);
  try {
    const ref = refOfTag(graph, 'b', 'button');
    const result = await executor.act(graph, { ref, action: 'click' }, () => host.currentEpoch());
    assert.ok(!('rejected' in result), `a nameless control that did not move must act: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'delivered', JSON.stringify(result));
    assert.equal(await host.page.title(), 'CLICKED', 'the click must actually reach the page');
  } finally { await host.close(); }
});
