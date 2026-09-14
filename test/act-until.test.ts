// Regression for `until` on act — the condition an act's settle extends to.
//
// Earned by shopping_admin 464 arm 2 (/home/opc/wir-run-final-v2-arm2/run-write-
// shopping_admin/task-464/attempt-1, trajectory rows 30-60): twenty `act scroll
// value:"end"` calls in a row, each answered `verified/scrolled_no_new_content`,
// while the model waited for Magento's Page Builder stage to finish rendering.
// It had no way to say "until X is there". Reproduced live through the agent's
// own path (debug/probe_act_until.mjs, BEFORE arm): the click on "Edit with Page
// Builder" returned and an immediate `find "Apply Template"` answered matched 0;
// the words arrived seconds later. The AFTER arm's click with
// until {text:"Apply Template"} returned condition_met with the matched ref.
//
// What this pins, on a fixture whose timings are known exactly: the button
// reveals text after 800 ms and starts a fetch the server answers after 600 ms.
//   - until.text is met at ≈800 ms from dispatch (never before the text exists);
//   - until.network "idle" is met, and the request answered during the
//     extension is IN the receipt — one ledger for both;
//   - until.gone on a spinner label is met when the label is removed;
//   - until.text that never holds reads timed_out at withinMs with `observed`
//     naming what the last check saw, and the act's own verdict is untouched;
//   - until.state on a ref the act's target changes later is met;
//   - scroll to the end with until.text keeps scrolling a feed that grows;
//   - a malformed until is refused BEFORE dispatch with the corrected call, and
//     an act without until carries no `effect.until` at all.
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { WirSession } from '../src/session.js';

const REVEAL_MS = 800;
const FETCH_MS = 600;
const CHECK_MS = 500;
const FEED_MS = 300;

const PAGE = `<!doctype html><title>until</title><h1>Fixture</h1>
  <button id="reveal">Reveal the answer</button>
  <span id="spinner" hidden>Loading the answer…</span>
  <div id="out"></div>
  <button id="enable">Enable the option</button>
  <label><input id="opt" type="checkbox"> Optional extra</label>
  <div id="feed" style="height:120px;overflow:auto;border:1px solid #888">
    <p>Row one</p><p>Row two</p><p>Row three</p><p>Row four</p><p>Row five</p>
    <p>Row six</p><p>Row seven</p><p>Row eight</p><p>Row nine</p><p>Row ten</p>
  </div>
  <script>
    document.getElementById('reveal').addEventListener('click', () => {
      const spin = document.getElementById('spinner');
      spin.hidden = false;
      // A GET, deliberately: a same-origin POST answered 2xx is the click's
      // own request_committed arm, decided inside its pre-existing 1.5 s
      // candidate window before any until begins — a different fact.
      fetch('/slow').catch(() => {});
      setTimeout(() => {
        spin.remove();
        const p = document.createElement('p');
        p.textContent = 'The answer is forty-two';
        document.getElementById('out').appendChild(p);
      }, ${REVEAL_MS});
    });
    document.getElementById('enable').addEventListener('click', () => {
      setTimeout(() => { document.getElementById('opt').checked = true; }, ${CHECK_MS});
    });
    // A feed that grows as you reach its end — ten rows a time, four times.
    const feed = document.getElementById('feed');
    let batches = 0;
    feed.addEventListener('scroll', () => {
      if (batches >= 3) return;
      if (feed.scrollTop + feed.clientHeight < feed.scrollHeight - 8) return;
      batches += 1;
      const mine = batches;
      setTimeout(() => {
        for (let i = 1; i <= 10; i += 1) {
          const p = document.createElement('p');
          p.textContent = mine === 3 && i === 10 ? 'Row forty zebra' : 'Row ' + (mine * 10 + i);
          feed.appendChild(p);
        }
      }, ${FEED_MS});
    });
  </script>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, FETCH_MS);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    }),
  );
}

type Until = {
  declared: Record<string, unknown>;
  verdict: string;
  afterMs: number;
  observed: string;
};
type Effect = { verdict: string; evidence: string; delta: { after: string }; until?: Until };
type Receipt = { requests: { url: string; status: number | null }[] };

describe('until — the condition an act settles to', () => {
  let server: Server;
  let base: string;
  let session: WirSession;
  before(async () => {
    ({ server, base } = await serve());
    session = await WirSession.start({
      headless: true,
      expectedAction: 'RETRIEVE',
      storageStatePath: null,
      harPath: null,
      tracePath: null,
      debugScreenshots: false,
    });
  });
  after(async () => {
    await session.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function refOf(name: string, role?: string): Promise<string> {
    const found = await session.dispatch({ verb: 'find', name, ...(role ? { role } : {}) });
    const ref = (found['matches'] as { ref: string }[] | undefined)?.[0]?.ref;
    assert.ok(ref, `not found: ${name} ${JSON.stringify(found).slice(0, 300)}`);
    return ref;
  }

  test('until.text is met when the words render, at about the moment they do', async () => {
    await session.goto(`${base}/`);
    const ref = await refOf('Reveal the answer', 'button');
    const t0 = Date.now();
    const acted = await session.dispatch({
      verb: 'act',
      ref,
      action: 'click',
      until: { text: 'forty-two' },
    });
    const wall = Date.now() - t0;
    const effect = acted['effect'] as Effect;
    assert.ok(effect.until, `no until block: ${JSON.stringify(acted)}`);
    assert.equal(effect.until.verdict, 'condition_met', JSON.stringify(effect.until));
    assert.deepEqual(effect.until.declared, { text: 'forty-two' });
    // Never before the words exist; not long after (one compile after the token moved).
    assert.ok(
      effect.until.afterMs >= REVEAL_MS,
      `met before the text existed: ${effect.until.afterMs} ms`,
    );
    assert.ok(effect.until.afterMs < REVEAL_MS + 2_500, `met late: ${effect.until.afterMs} ms`);
    assert.ok(wall < REVEAL_MS + 4_000, `act wall ${wall} ms`);
    assert.match(effect.until.observed, /matched n_[0-9a-f]+ \(/);
    assert.match(effect.until.observed, /forty-two/);
    assert.match(effect.until.observed, /\d+ recompiles? of at most 30/);
    // The verdict was classified from the page as it stood when the condition
    // held: the revealed paragraph is the act's own observed effect.
    assert.equal(effect.verdict, 'verified', JSON.stringify(effect));
    assert.equal(effect.evidence, 'dom_mutated');
  });

  test('until.network "idle" is met after the fetch answers, and that answer is in the receipt', async () => {
    await session.goto(`${base}/`);
    const ref = await refOf('Reveal the answer', 'button');
    const acted = await session.dispatch({
      verb: 'act',
      ref,
      action: 'click',
      until: { network: 'idle' },
    });
    const effect = acted['effect'] as Effect;
    assert.ok(effect.until, JSON.stringify(acted));
    assert.equal(effect.until.verdict, 'condition_met', JSON.stringify(effect.until));
    assert.ok(
      effect.until.afterMs >= FETCH_MS + 500,
      `idle declared before the fetch could have answered: ${effect.until.afterMs} ms`,
    );
    assert.match(
      effect.until.observed,
      /no request of this act's window in flight, quiet since \+\d+ ms \(\d+ requests? recorded since dispatch\)/,
    );
    const receipt = acted['receipt'] as Receipt;
    const slow = receipt.requests.find((r) => r.url.endsWith('/slow'));
    assert.ok(slow, `the fetch is not in the receipt: ${JSON.stringify(receipt)}`);
    assert.equal(slow.status, 200, 'the ledger stayed armed through the extension');
  });

  test('until.gone is met when the spinner label is removed', async () => {
    await session.goto(`${base}/`);
    const ref = await refOf('Reveal the answer', 'button');
    const acted = await session.dispatch({
      verb: 'act',
      ref,
      action: 'click',
      until: { gone: 'Loading the answer' },
    });
    const effect = acted['effect'] as Effect;
    assert.ok(effect.until, JSON.stringify(acted));
    assert.equal(effect.until.verdict, 'condition_met', JSON.stringify(effect.until));
    assert.ok(
      effect.until.afterMs >= REVEAL_MS,
      `gone before it was removed: ${effect.until.afterMs} ms`,
    );
    assert.match(effect.until.observed, /no rendered node carries "Loading the answer"/);
  });

  test('until.text that never holds reads timed_out at withinMs, says what it saw, and leaves the verdict alone', async () => {
    await session.goto(`${base}/`);
    const ref = await refOf('Reveal the answer', 'button');
    const t0 = Date.now();
    const acted = await session.dispatch({
      verb: 'act',
      ref,
      action: 'click',
      until: { text: 'this text is not on the page zzqx', withinMs: 1_500 },
    });
    const wall = Date.now() - t0;
    const effect = acted['effect'] as Effect;
    assert.ok(effect.until, JSON.stringify(acted));
    assert.equal(effect.until.verdict, 'timed_out', JSON.stringify(effect.until));
    assert.ok(effect.until.afterMs >= 1_500, `gave up early: ${effect.until.afterMs} ms`);
    assert.ok(wall < 1_500 + 4_000, `held far past the bound: ${wall} ms`);
    assert.match(
      effect.until.observed,
      /"this text is not on the page zzqx" in none of \d+ rendered nodes/,
    );
    assert.match(effect.until.observed, /at the bound; \d+ recompiles? of at most 30/);
    // A fact beside the verdict, never a contradiction of the act: the click
    // still did what it did.
    assert.equal(effect.verdict, 'verified', JSON.stringify(effect));
    assert.equal(effect.evidence, 'dom_mutated');
  });

  test('until.state on another ref is met when the page flips it', async () => {
    await session.goto(`${base}/`);
    const button = await refOf('Enable the option', 'button');
    const box = await refOf('Optional extra', 'checkbox');
    const acted = await session.dispatch({
      verb: 'act',
      ref: button,
      action: 'click',
      until: { state: { ref: box, checked: true } },
    });
    const effect = acted['effect'] as Effect;
    assert.ok(effect.until, JSON.stringify(acted));
    assert.equal(effect.until.verdict, 'condition_met', JSON.stringify(effect.until));
    assert.ok(
      effect.until.afterMs >= CHECK_MS,
      `checked before the page flipped it: ${effect.until.afterMs} ms`,
    );
    assert.match(effect.until.observed, new RegExp(`^${box} now reads checked=true$`));
  });

  test('scroll to the end with until.text keeps scrolling a feed that grows until the words appear', async () => {
    await session.goto(`${base}/`);
    const row = await refOf('Row one');
    const acted = await session.dispatch({
      verb: 'act',
      ref: row,
      action: 'scroll',
      value: 'end',
      until: { text: 'zebra', withinMs: 8_000 },
    });
    const effect = acted['effect'] as Effect;
    assert.ok(effect.until, JSON.stringify(acted));
    assert.equal(effect.until.verdict, 'condition_met', JSON.stringify(effect.until));
    assert.match(effect.until.observed, /matched n_[0-9a-f]+ \(paragraph "Row forty zebra"\)/);
    // The scroll's own verdict is read AFTER the extension: the container grew.
    assert.equal(effect.evidence, 'scrolled', JSON.stringify(effect));
    // All forty rows rendered — three lazy batches, each appended only after the
    // scroller reached its then-end — so the nudge kept scrolling while the
    // condition was polled. Not "at the end": the words appeared mid-batch and
    // the extension stops the moment they do.
    assert.match(effect.delta.after, /rendered=40 /);
    assert.ok(
      effect.until.afterMs >= 3 * FEED_MS,
      `three batches cannot have landed by ${effect.until.afterMs} ms`,
    );
  });

  test('a malformed until is refused before dispatch, with the corrected call; no until, no block', async () => {
    await session.goto(`${base}/`);
    const ref = await refOf('Reveal the answer', 'button');
    // The garble a model produces: withinMs beside until instead of inside it.
    const stray = await session.dispatch({
      verb: 'act',
      ref,
      action: 'click',
      until: { text: 'x' },
      withinMs: 2000,
    } as unknown as Parameters<WirSession['dispatch']>[0]);
    assert.equal(
      (stray['rejected'] as { kind: string }).kind,
      'invalid_args',
      JSON.stringify(stray),
    );
    assert.match((stray['rejected'] as { reason: string }).reason, /unknown key withinMs/);
    const two = await session.dispatch({
      verb: 'act',
      ref,
      action: 'click',
      until: { text: 'x', gone: 'y' },
    });
    assert.equal((two['rejected'] as { kind: string }).kind, 'invalid_args', JSON.stringify(two));
    assert.match((two['rejected'] as { reason: string }).reason, /2 conditions \(text, gone\)/);
    assert.equal(
      (two['rejected'] as { repair: string }).repair,
      JSON.stringify({ verb: 'act', ref, action: 'click', until: { text: 'x' } }),
    );
    const tooLong = await session.dispatch({
      verb: 'act',
      ref,
      action: 'click',
      until: { text: 'x', withinMs: 60_000 },
    });
    assert.match((tooLong['rejected'] as { reason: string }).reason, /from 1 to 15000/);
    assert.match((tooLong['rejected'] as { repair: string }).repair, /"withinMs":15000/);
    const scrollNet = await session.dispatch({
      verb: 'act',
      ref,
      action: 'scroll',
      until: { network: 'idle' },
    });
    assert.match(
      (scrollNet['rejected'] as { reason: string }).reason,
      /scroll installs no network observers/,
    );
    // Nothing was dispatched by any of those: the answer is still unrevealed.
    const still = await session.dispatch({ verb: 'find', name: 'forty-two' });
    assert.equal(
      (still['population'] as { matched: number }).matched,
      0,
      JSON.stringify(still).slice(0, 200),
    );
    // And an act with no until carries no until block.
    const plain = await session.dispatch({ verb: 'act', ref, action: 'click' });
    assert.equal((plain['effect'] as Effect).until, undefined, JSON.stringify(plain['effect']));
  });
});
