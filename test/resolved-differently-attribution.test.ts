// `resolvedDifferently` must name the field the caller actually typed into.
//
// It reports "what the page did with what you typed": a control that now holds
// MORE than you typed has resolved your text to something specific. That signal
// is load-bearing on a geocoding page — it is the only place the resolved
// destination name appears, and it has prevented a confidently wrong answer.
//
// But it paired a node's value against EVERY string typed this session, by
// shared word alone, with no check that the string was typed into THAT node.
// Two drivers reported the same false reading on the same day:
//
//   task 767: 'youTyped "Carnegie Mellon University, Pittsburgh" -> nowReads
//             "Pittsburgh International Airport, ..." — two different fields,
//             two documents apart'
//   task 55:  'I typed neither of those into those fields; it appears to pair
//             geocoded results against a stale typing history by position
//             rather than by node'
//
// A false signal is the attempt-6 failure mode — docs/vision.md is explicit that
// a wrong `contradicted` poisoned that world model — and this one is worse than
// silence, because a driver reads it as confirmation that an endpoint geocoded
// when it never did.
//
// A fixture rather than the live map: the condition needs one field holding a
// value that expands to share a word with text typed into a DIFFERENT field, and
// on the real site that only happens through an async geocoder whose timing
// cannot be staged deterministically. One page, one proven condition.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// `to` already holds the long value — as it would after the page resolved it —
// and nothing was ever typed into it. `from` is the only field the caller writes.
const PAGE = `<!doctype html><title>directions</title><h1>Directions</h1>
  <label for="from">From</label>
  <input id="from" type="text" value=""
    oninput="if(this.value && this.value.indexOf('Forbes')===-1){this.value=this.value+', Forbes Avenue, Pittsburgh';}">
  <label for="to">To</label>
  <input id="to" type="text" value="Chatham University, North Woodland Road, Pittsburgh">`;

function serve(): Promise<{ server: Server; url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

async function session(): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-resolved-'));
  return WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: join(dir, 'network.har'), tracePath: join(dir, 'trace.zip'),
    debugScreenshots: false,
  });
}

test('a value typed into one field is not attributed to another', async () => {
  const site = await serve();
  const s = await session();
  try {
    await s.goto(site.url);
    const found = await s.dispatch({ verb: 'find', role: 'textbox' });
    const matches = found['matches'] as Record<string, unknown>[];
    const from = matches.find(m => String(m['name'] ?? '').includes('From'));
    assert.ok(from, `the From field must compile: ${JSON.stringify(matches)}`);

    // Shares the word "university" with the OTHER field's standing value and is
    // shorter than it — exactly the shape that produced the false pair. The typed
    // value is recorded after this envelope is built, so the following call is
    // where it could be mis-paired.
    await s.dispatch({
      verb: 'act', action: 'fill', ref: String(from['ref']),
      value: 'Carnegie Mellon University',
    });
    const next = await s.dispatch({ verb: 'read' });

    const resolved = next['resolvedDifferently'] as
      { youTyped: string; nowReads: string }[] | undefined;
    const bogus = (resolved ?? []).filter(r => r.nowReads.includes('Chatham'));
    assert.equal(bogus.length, 0,
      'the To field was never typed into, so nothing the caller typed resolved to '
      + `its value: ${JSON.stringify(resolved)}`);
  } finally {
    await s.close();
    site.close();
  }
});

// THE CONTROL. The signal has to keep firing where it earned its place — the same
// field the caller wrote, expanding its own value, as a geocoder does. Without
// this the fix could "pass" by disabling the feature.
test('a field that expands what you typed into IT still reports', async () => {
  const site = await serve();
  const s = await session();
  try {
    await s.goto(site.url);
    const found = await s.dispatch({ verb: 'find', role: 'textbox' });
    const matches = found['matches'] as Record<string, unknown>[];
    const from = matches.find(m => String(m['name'] ?? '').includes('From'))!;

    // The page rewrites this field in place on input.
    await s.dispatch({
      verb: 'act', action: 'fill', ref: String(from['ref']), value: 'Carnegie Mellon',
    });
    const next = await s.dispatch({ verb: 'read' });

    const resolved = next['resolvedDifferently'] as
      { youTyped: string; nowReads: string }[] | undefined;
    assert.ok(resolved && resolved.some(r =>
      r.youTyped === 'Carnegie Mellon' && r.nowReads.includes('Forbes')),
      'the field the caller wrote expanded its own value and must still be '
      + `reported: ${JSON.stringify(resolved)}`);
  } finally {
    await s.close();
    site.close();
  }
});

// A field written more than once resolves what was written LAST. Taking the
// earliest match quoted a value from three fills earlier as the one that had just
// resolved — reported on map 367 once the ref check landed. Both typed values
// share the word "university" with the final value, so the earliest-match code
// picks the wrong one and this test fails against it.
test('a field written twice reports the value written LAST', async () => {
  const site = await serve();
  const s = await session();
  try {
    await s.goto(site.url);
    const found = await s.dispatch({ verb: 'find', role: 'textbox' });
    const matches = found['matches'] as Record<string, unknown>[];
    const from = matches.find(m => String(m['name'] ?? '').includes('From'))!;

    await s.dispatch({
      verb: 'act', action: 'fill', ref: String(from['ref']), value: 'University of Pittsburgh',
    });
    await s.dispatch({
      verb: 'act', action: 'fill', ref: String(from['ref']), value: 'Chatham University',
    });
    const next = await s.dispatch({ verb: 'read' });

    const resolved = next['resolvedDifferently'] as
      { youTyped: string; nowReads: string }[] | undefined;
    const forFrom = (resolved ?? []).filter(r => r.nowReads.includes('Chatham'));
    assert.ok(forFrom.length > 0, `the rewritten field must still report: ${JSON.stringify(resolved)}`);
    assert.equal(forFrom[0]!.youTyped, 'Chatham University',
      'the field now holds a resolution of the LAST thing written to it, not the '
      + `first: ${JSON.stringify(resolved)}`);
  } finally {
    await s.close();
    site.close();
  }
});

// A field whose current value EXACTLY echoes the last thing typed into it has
// resolved nothing, and must not fall back to reporting an older query.
//
// This is what a settled geocode looks like: you paste the full display name, the
// site accepts it verbatim, and nv === nt. The first newest-first fix continued
// past that case and reported an older typed value instead. Measured on map 767:
// it named "Giant Eagle, Shakespeare" — which had raised a not-found alert and
// bound nothing two turns earlier — as having resolved to the Centre Avenue
// address. An agent reading that concludes a query succeeded that in fact failed.
test('a field that echoes what you last typed reports nothing at all', async () => {
  const site = await serve();
  const s = await session();
  try {
    await s.goto(site.url);
    const found = await s.dispatch({ verb: 'find', role: 'textbox' });
    const matches = found['matches'] as Record<string, unknown>[];
    const from = matches.find(m => String(m['name'] ?? '').includes('From'))!;
    const ref = String(from['ref']);

    // An earlier query that WOULD qualify against the final value — the stale
    // candidate the fall-through used to reach for.
    await s.dispatch({ verb: 'act', action: 'fill', ref, value: 'Carnegie Mellon' });
    // Then the real one, typed in full, which the page echoes unchanged.
    await s.dispatch({
      verb: 'act', action: 'fill', ref,
      value: 'Carnegie Mellon University, Forbes Avenue, Pittsburgh',
    });
    const next = await s.dispatch({ verb: 'read' });

    const resolved = (next['resolvedDifferently'] as
      { youTyped: string; nowReads: string }[] | undefined) ?? [];
    const stale = resolved.filter(r => r.youTyped === 'Carnegie Mellon');
    assert.equal(stale.length, 0,
      'the last thing written to the field is the only thing its value can be a '
      + `resolution of; an earlier query must not be quoted: ${JSON.stringify(resolved)}`);
  } finally {
    await s.close();
    site.close();
  }
});
