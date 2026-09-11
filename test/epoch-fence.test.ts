// Regression for review finding R2: the dispatch-time epoch fence protocol.md
// has promised since v1-path ("a stale epoch is a typed rejection, not a
// wrong-target click") was never implemented. The epoch was captured at act
// entry and never re-checked, while everything after it dispatches raw viewport
// COORDINATES computed from the old document — with unfenced awaits in between
// (Page.getFrameTree, Network.enable, armMutationCounter). A document replaced
// in that window took the click at whatever now sat at those coordinates.
//
// The executor is driven directly here because `epochNow` is a parameter of its
// public act() — the same call the session makes — and a real navigation cannot
// be timed into that few-millisecond window deterministically. Everything else
// is real: real Chromium, real page, real CDP, real dispatch path.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirHost } from '../src/host.js';
import { compile } from '../src/compiler.js';
import { ActExecutor } from '../src/act.js';

test('a document replaced mid-act is a typed stale_ref, never a wrong-target click', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-epoch-'));
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>a</title><h1>Host</h1>
    <button id="b" onclick="document.title = 'CLICKED'">Danger Button</button>`);
  const host = await WirHost.launch({ headless: true });
  try {
    await host.goto(`file://${dir}/a.html`);
    const graph = compile(await host.captureFacts());
    const target = [...graph.nodes.values()].find(n => n.name === 'Danger Button');
    assert.ok(target, 'fixture button must compile');

    const executor = new ActExecutor(host, () => host.drainBrowserEvents());
    // First call = the act's epochBefore; every later call reports a replaced
    // document, exactly as a concurrent navigation would.
    let calls = 0;
    const epochNow = (): string => (++calls === 1 ? 'epoch-original' : 'epoch-replaced');

    const result = await executor.act(graph, { ref: target.ref, action: 'click' }, epochNow);

    assert.ok('rejected' in result, `expected a typed rejection: ${JSON.stringify(result)}`);
    assert.equal(result.rejected.kind, 'stale_ref', JSON.stringify(result));
    assert.match(result.rejected.repair ?? '', /"verb":"find"/,
      'the rejection must carry the re-find repair');

    // The proof that nothing was dispatched: the button's own handler never ran.
    assert.equal(await host.page.title(), 'a',
      'no click may reach the page once the fence has fired');
  } finally { await host.close(); }
});
