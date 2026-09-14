// Regression for act's `expect` (core/expect.ts), reproduced on the live sites
// first (debug/probe_act_expect.mjs, artifacts under
// debug/runs/probe/2026-09-02T*-act-expect-{reddit,gitlab}):
//   reddit — a comment posted with expect {sent:{method:POST, fields:{<the
//     page's field>: s}}, text: s} read `held: true`; the same submit declared
//     with a wrong field value read `held: false` and the failure carried the
//     receipt's actual value verbatim; a Delete behind a native confirm the
//     policy dismisses read "no request of any kind was sent".
//   gitlab — a checkbox click declared {state:{checked:true}} held once and
//     failed on the second click with `checked=false`; a sidebar link declared
//     with the served path held, and declared with another path failed with
//     the served address.
// The class this closes (roadmap 0.10, arm 2's tasks 660 and 521): the runtime
// could verify that SOMETHING happened and nothing let the model say what it
// MEANT, so a fill's value_set and a click's dom_mutated stayed local-only
// forever. An http fixture is justified as act-receipt.test.ts justifies its
// own: the live pages prove the class but cannot hold their bodies still.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>expect</title><h1>Profile</h1>
  <form id="f"><label>Name <input id="nameBox" name="user[name]" value=""></label>
    <label><input type="checkbox" id="notify" name="user[notify]"> Notify me</label>
    <button id="save" type="button">Save</button></form>
  <a href="/settings">Settings</a>
  <div id="out"></div>
  <script>
    save.addEventListener('click', () => {
      fetch('/api/profile', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'user[name]': nameBox.value, 'user[notify]': notify.checked ? '1' : '0' }) })
        .then(() => { out.textContent = 'Profile saved'; });
    });
    // A fill that submits on input — the value_set-only shape whose only proof
    // of a site change is the request it caused.
    nameBox.addEventListener('input', () => {
      fetch('/api/draft', { method: 'PUT', body: JSON.stringify({ name: nameBox.value }),
        headers: { 'content-type': 'application/json' } });
    });
  </script>`;

function serve(): Promise<{ server: Server; url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/profile') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/draft') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        req.url === '/settings' ? '<!doctype html><title>s</title><h1>Settings page</h1>' : PAGE,
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => {
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

type Expectation = { held: boolean; failed?: { key: string; wanted: unknown; observed: string }[] };
const expectation = (r: Record<string, unknown>): Expectation =>
  (r['effect'] as { expectation: Expectation }).expectation;
const evidence = (r: Record<string, unknown>): string =>
  (r['effect'] as { evidence: string }).evidence;

async function refOf(session: WirSession, q: { role?: string; name?: string }): Promise<string> {
  const found = await session.dispatch({ verb: 'find', ...q });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `not found ${JSON.stringify(q)}: ${JSON.stringify(found)}`);
  return ref;
}

test('expect.sent, .text, .state and .navigation hold and fail with the observation verbatim', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    // A stray key is named, never silently held.
    const stray = await session.dispatch({
      verb: 'act',
      ref: 'n_x',
      action: 'click',
      expect: { bogus: 1 } as unknown as { text: string },
    });
    assert.equal(
      (stray['rejected'] as { kind: string }).kind,
      'invalid_args',
      JSON.stringify(stray),
    );

    await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { role: 'textbox' }),
      action: 'fill',
      value: 'Ada',
    });
    // state: the checkbox, held then failed with the real state.
    const on = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { role: 'checkbox' }),
      action: 'click',
      expect: { state: { checked: true } },
    });
    assert.equal(expectation(on).held, true, JSON.stringify(on));
    const off = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { role: 'checkbox' }),
      action: 'click',
      expect: { state: { checked: true } },
    });
    assert.equal(expectation(off).held, false, JSON.stringify(off));
    assert.deepEqual(expectation(off).failed, [
      { key: 'state.checked', wanted: true, observed: 'checked=false' },
    ]);
    await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { role: 'checkbox' }),
      action: 'click',
    });

    // sent + text: the AJAX save, declared right.
    const held = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { name: 'Save' }),
      action: 'click',
      expect: {
        sent: {
          method: 'POST',
          path: '/api/profile/',
          fields: { 'user[name]': 'Ada', 'user[notify]': '1' },
        },
        text: 'Profile saved',
      },
    });
    assert.equal(evidence(held), 'request_committed', JSON.stringify(held));
    assert.deepEqual(expectation(held), {
      declared: {
        sent: {
          method: 'POST',
          path: '/api/profile/',
          fields: { 'user[name]': 'Ada', 'user[notify]': '1' },
        },
        text: 'Profile saved',
      },
      held: true,
    });

    // Declared wrong: the failure carries the receipt's own value and the
    // text's own count. The verdict does not move.
    const wrong = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { name: 'Save' }),
      action: 'click',
      expect: { sent: { fields: { 'user[name]': 'Grace' } }, text: 'Profile saved' },
    });
    assert.equal((wrong['effect'] as { verdict: string }).verdict, 'verified');
    assert.equal(expectation(wrong).held, false, JSON.stringify(wrong));
    const failed = expectation(wrong).failed ?? [];
    assert.deepEqual(
      failed.map((f) => f.key),
      ['text', 'sent'],
    );
    assert.match(
      failed[1]!.observed,
      /^POST http:\/\/127\.0\.0\.1:\d+\/api\/profile \(answered 200\); fields: user\[name\]=Ada$/,
    );
    assert.equal(
      failed[0]!.observed,
      'present 1 time before dispatch and 1 after — not new to this act',
    );

    // navigation: the served address, right then wrong.
    const nav = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { name: 'Settings' }),
      action: 'click',
      expect: { navigation: '/settings/', text: 'Settings page' },
    });
    assert.equal(expectation(nav).held, true, JSON.stringify(nav));
    await session.goto(srv.url);
    const elsewhere = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { name: 'Settings' }),
      action: 'click',
      expect: { navigation: '/account' },
    });
    assert.deepEqual(expectation(elsewhere).failed, [
      { key: 'navigation', wanted: '/account', observed: `served ${srv.url}settings` },
    ]);
  } finally {
    await session.close();
    srv.close();
  }
});

test('the MUTATE gate: a value_set act is rejected bare and accepted with a held expect.sent', async () => {
  const srv = await serve();
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(srv.url);
    const bare = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { role: 'textbox' }),
      action: 'fill',
      value: 'Ada',
    });
    assert.equal(evidence(bare), 'value_set', JSON.stringify(bare));
    const rejected = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [bare['actRef'] as string],
    });
    assert.equal(
      (rejected['rejected'] as { kind: string } | undefined)?.kind,
      'finish_rejected',
      `a fill alone proves local state: ${JSON.stringify(rejected)}`,
    );

    const declared = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { role: 'textbox' }),
      action: 'fill',
      value: 'Grace',
      expect: { sent: { method: 'PUT', path: '/api/draft', fields: { name: 'Grace' } } },
    });
    assert.equal(evidence(declared), 'value_set', JSON.stringify(declared));
    assert.equal(expectation(declared).held, true, JSON.stringify(declared));
    const ledger = session.gateEligibleActs();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.actRef, declared['actRef']);
    assert.match(ledger[0]!.expectation ?? '', /held$/);
    const accepted = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [declared['actRef'] as string],
    });
    assert.equal(
      accepted['accepted'],
      true,
      `the declared request was on the wire: ${JSON.stringify(accepted)}`,
    );

    // A held state (or text) alone never admits: local facts stay local.
    const local = await session.dispatch({
      verb: 'act',
      ref: await refOf(session, { role: 'textbox' }),
      action: 'fill',
      value: 'Linus',
      expect: { state: { value: 'Linus' } },
    });
    assert.equal(evidence(local), 'value_set', JSON.stringify(local));
    assert.equal(expectation(local).held, true, JSON.stringify(local));
    assert.equal(
      session.gateEligibleActs().some((a) => a.actRef === local['actRef']),
      false,
      'a held expect.state on a value_set act must not enter the gate ledger',
    );
  } finally {
    await session.close();
    srv.close();
  }
});
