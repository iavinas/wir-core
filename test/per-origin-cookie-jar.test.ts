// Regression for the PHPSESSID rivalry (benchmark/AUTH-AND-COOKIES.md,
// "Multi-site"): two origins on ONE host that both name their session cookie
// the same way cannot share a cookie jar — cookies key on domain+path+name and
// carry no port, so the second seed overwrites the first and one site runs
// logged out. Reproduced on the live sites through the verbs
// (debug/probe_cookie_rivalry.mjs --mode before: reddit in, shopping OUT), fixed
// by one browser context per declared origin (core/host.ts, Tab; --mode after:
// both in, both acts verified).
//
// Two fixture servers, not the sites: the proven condition is "same host, same
// cookie name, different ports", which a unit test cannot produce against the
// WebArena containers without their sessions. Each server answers with the
// session it was SENT and, like Postmill and Magento, re-issues the cookie when
// it does not recognise the value — the mechanism that carried reddit's fresh
// id into Magento's jar on the live run.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

interface Site { name: string; token: string; url: string; other: () => Site; close: () => void }

function serve(name: string, token: string, other: () => Site): Promise<Site> {
  return new Promise(resolve => {
    const s: Server = createServer((q, r) => {
      const sent = /(?:^|;\s*)PHPSESSID=([^;]+)/.exec(q.headers.cookie ?? '')?.[1] ?? 'none';
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (sent !== token) headers['set-cookie'] = `PHPSESSID=issued-by-${name}; Path=/`;
      r.writeHead(200, headers);
      r.end(`<!doctype html><title>${name}</title><h1>${name} session ${sent}</h1>
        <a href="${other().url}/">go to ${other().name}</a>`);
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ name, token, url: `http://127.0.0.1:${port}`, other, close: () => s.close() });
    });
  });
}

function stateFile(dir: string, name: string, token: string): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ cookies: [{ name: 'PHPSESSID', value: token, domain: '127.0.0.1',
    path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  return path;
}

async function sessionSeen(session: WirSession, site: Site): Promise<{ verb: number; oracle: string }> {
  const found = await session.dispatch({ verb: 'find', name: `${site.name} session ${site.token}` });
  const oracle = await session.host.page.evaluate(() => document.body.innerText);
  return { verb: (found['matches'] as unknown[] | undefined)?.length ?? 0, oracle };
}

test('two same-host origins sharing a cookie name each keep their own session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-jars-'));
  let a!: Site; let b!: Site;
  a = await serve('A', 'sess-A', () => b);
  b = await serve('B', 'sess-B', () => a);
  const stateA = stateFile(dir, 'A', 'sess-A');
  const stateB = stateFile(dir, 'B', 'sess-B');
  try {
    // CONTROL — one jar, both states concatenated (what WebArena upstream's
    // auto_login does): the fixture must actually collide, or the assertion
    // below proves nothing.
    const merged = join(dir, 'merged.json');
    writeFileSync(merged, JSON.stringify({ cookies: [
      ...JSON.parse(readFileSync(stateA, 'utf8')).cookies,
      ...JSON.parse(readFileSync(stateB, 'utf8')).cookies], origins: [] }));
    const one = await WirSession.start({ headless: true, expectedAction: 'RETRIEVE',
      storageStatePath: merged, knownUrls: [a.url, b.url] });
    try {
      await one.goto(`${a.url}/`);
      const seenA = await sessionSeen(one, a);
      await one.goto(`${b.url}/`);
      const seenB = await sessionSeen(one, b);
      assert.ok(seenA.verb === 0 || seenB.verb === 0,
        `control did not collide: A=${JSON.stringify(seenA)} B=${JSON.stringify(seenB)}`);
    } finally { await one.close(); }

    // THE FIX — a context per declared origin.
    const harPath = join(dir, 'network.har');
    const session = await WirSession.start({ headless: true, expectedAction: 'RETRIEVE',
      storageStatePath: null, storageStates: { [a.url]: stateA, [b.url]: stateB },
      harPath, tracePath: join(dir, 'trace.zip'), knownUrls: [a.url, b.url] });
    try {
      await session.goto(`${a.url}/`);
      const seenA = await sessionSeen(session, a);
      assert.equal(seenA.verb, 1, `A through the verbs: ${seenA.oracle}`);
      assert.match(seenA.oracle, /A session sess-A/);

      await session.goto(`${b.url}/`);
      const seenB = await sessionSeen(session, b);
      assert.equal(seenB.verb, 1, `B through the verbs: ${seenB.oracle}`);
      assert.match(seenB.oracle, /B session sess-B/);

      // A cross-origin CLICK lands in the other origin's context, and the act
      // reports the navigation it actually caused there.
      const link = await session.dispatch({ verb: 'find', name: 'go to A' });
      const ref = (link['matches'] as { ref: string }[])[0]?.ref;
      assert.ok(ref, 'link to A not found on B');
      const acted = await session.dispatch({ verb: 'act', ref, action: 'click' });
      const effect = acted['effect'] as { verdict: string; evidence: string };
      assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
      assert.equal(effect.evidence, 'navigated_to_destination', JSON.stringify(acted));
      assert.equal(session.host.page.url(), `${a.url}/`);
      const seenAgain = await sessionSeen(session, a);
      assert.equal(seenAgain.verb, 1, `A after the click from B: ${seenAgain.oracle}`);
      assert.equal(session.host.divertedNavigations.length, 1, JSON.stringify(session.host.divertedNavigations));

      // And B's own session survived A's visit — the exact thing one jar lost.
      await session.dispatch({ verb: 'navigate', url: `${b.url}/` });
      const seenBAgain = await sessionSeen(session, b);
      assert.equal(seenBAgain.verb, 1, `B after A: ${seenBAgain.oracle}`);
    } finally { await session.close(); }

    // One HAR, every entry saying which context carried it — the harness reads
    // exactly one file, and the debug plane needs to see two jars in it.
    assert.ok(existsSync(harPath), 'merged HAR missing');
    const har = JSON.parse(readFileSync(harPath, 'utf8')) as
      { log: { entries: { request: { url: string; headers: { name: string; value: string }[] }; _wirContext?: string }[] } };
    const byContext = new Map<string, Set<string>>();
    for (const e of har.log.entries) {
      const cookie = e.request.headers.find(h => h.name.toLowerCase() === 'cookie')?.value ?? '';
      const sess = /PHPSESSID=([^;]+)/.exec(cookie)?.[1];
      if (sess === undefined) continue;
      const set = byContext.get(e._wirContext ?? '?') ?? new Set<string>();
      set.add(sess); byContext.set(e._wirContext ?? '?', set);
    }
    assert.deepEqual([...byContext.get(a.url) ?? []], ['sess-A'], JSON.stringify([...byContext]));
    assert.deepEqual([...byContext.get(b.url) ?? []], ['sess-B'], JSON.stringify([...byContext]));
    assert.ok(!existsSync(`${harPath}.0.part`), 'HAR part file left behind');
  } finally { a.close(); b.close(); }
});
