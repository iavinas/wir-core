// Regressions for `act key` and for `type`'s chord refusal, earned by failing
// task 442 (stack-n3 attempt 1, docs/research-notes/key-action-earned-2026-08-08.md):
// with no way to press a key, the model aimed `Control+f`, `Control+z`,
// `Control+h` and `Control+a` at `type`, which means "replace the content" — so
// those literal characters were written into a source file across nine calls,
// each answered `verified/text_typed`.
//
// Verification of record is the LIVE probe against GitLab's Monaco editor,
// debug/probe_key_monaco.mjs, run debug/runs/probe/2026-08-08T09-30-52-255Z-key-monaco:
// a 383-char accessibility window over a 2214-char document; `key Meta+a` +
// `key Backspace` ALONE (no text verb) emptied it, and after the commit the
// SERVER held exactly the 87-byte payload and none of the original bytes.
// `key Control+a` moved nothing on that platform and read `unknown` — the
// negative result these fixtures also pin.
//
// ONE fixture page, for the one condition the real site cannot be asked to hold
// still for: a keyboard layer that answers the select-all chord, plus ambient
// DOM churn of the kind Monaco's rendering produces.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { looksLikeChord } from '../src/keys.js';
import { WirSession } from '../src/session.js';

const PAGE = `<!doctype html><title>keys</title><h1>Host</h1>
  <textarea id="ed" aria-label="Editor content">original content</textarea>
  <p id="churn">0</p>
  <script>
    // Every key event the page actually receives, in full — the only way to
    // tell a real key press from inserted text.
    window.seen = [];
    const ed = document.getElementById('ed');
    ed.addEventListener('keydown', (e) => {
      window.seen.push({ key: e.key, code: e.code, keyCode: e.keyCode,
        ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
      // The page's own keyboard layer, Monaco's shape: the platform select-all
      // chord selects the whole content and nothing else does.
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); ed.select(); }
    });
    // Ambient DOM churn, the Monaco-rendering shape: mutation records accrue
    // whether or not any key was handled.
    setInterval(() => { document.getElementById('churn').textContent = String(Date.now()); }, 20);
  </script>`;

async function startOn(
  html: string,
  expectedAction: 'RETRIEVE' | 'MUTATE' = 'RETRIEVE',
): Promise<WirSession> {
  const dir = mkdtempSync(join(tmpdir(), 'wir-key-'));
  writeFileSync(join(dir, 'a.html'), html);
  const session = await WirSession.start({
    headless: true,
    expectedAction,
    storageStatePath: null,
    debugScreenshots: false,
  });
  await session.goto(`file://${dir}/a.html`);
  return session;
}

async function editorRef(session: WirSession): Promise<string> {
  const found = await session.dispatch({ verb: 'find', role: 'textbox', name: 'Editor content' });
  const ref = (found['matches'] as { ref: string }[])[0]?.ref;
  assert.ok(ref, `editor not found: ${JSON.stringify(found)}`);
  return ref;
}

const effectOf = (r: Record<string, unknown>): { verdict: string; evidence: string } =>
  r['effect'] as { verdict: string; evidence: string };

test('type refuses a chord-shaped value instead of replacing the content with it', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'type', value: 'Control+a' });
    const rejected = acted['rejected'] as { kind: string; repair: string } | undefined;
    assert.equal(rejected?.kind, 'invalid_args', JSON.stringify(acted));
    assert.match(rejected?.repair ?? '', /"action":"key"/, 'the repair must point at key');
    assert.equal(acted['effect'], undefined, 'a refusal dispatches nothing');
    // The 442 defect itself: the document must be exactly as it was.
    const value = await session.host.page.evaluate(
      () => (document.getElementById('ed') as HTMLTextAreaElement).value,
    );
    assert.equal(value, 'original content');
  } finally {
    await session.close();
  }
});

test('type still writes ordinary text that merely contains a plus sign', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    // The refusal keys on the WHOLE value's shape, never on page content, and
    // it must not cost the caller any text a page might legitimately ask for.
    const acted = await session.dispatch({
      verb: 'act',
      ref,
      action: 'type',
      value: 'C++ and a+b',
    });
    assert.equal(effectOf(acted).verdict, 'verified', JSON.stringify(acted));
    const value = await session.host.page.evaluate(
      () => (document.getElementById('ed') as HTMLTextAreaElement).value,
    );
    assert.equal(value, 'C++ and a+b');
  } finally {
    await session.close();
  }
});

test('looksLikeChord is narrow in both directions', () => {
  for (const chord of ['Control+a', 'Meta+a', 'Shift+Tab', 'Control+Shift+p', 'Alt+ArrowDown']) {
    assert.equal(looksLikeChord(chord), true, chord);
  }
  // Bare key names stay typeable: Enter, Tab, Delete, Home, Clear, Select and
  // Help are ordinary English words a page may ask for.
  for (const text of [
    'Escape',
    'Enter',
    'Delete',
    'Select',
    'C++ tutorial',
    'a+b',
    '1+1=2',
    'rock+roll',
    '',
  ]) {
    assert.equal(looksLikeChord(text), false, text);
  }
});

test('key dispatches a real key event, virtual key code and modifier bitmask included', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'key', value: 'Control+a' });
    assert.equal(effectOf(acted).verdict, 'verified', JSON.stringify(acted));
    assert.equal(effectOf(acted).evidence, 'selection_changed');
    // Ground truth: what the PAGE received. A press, never text.
    const seen = await session.host.page.evaluate(
      () => (globalThis as unknown as { seen: Record<string, unknown>[] }).seen,
    );
    const main = seen.find((e) => e['key'] === 'a');
    assert.ok(main, `the page never saw the main key: ${JSON.stringify(seen)}`);
    assert.equal(main['code'], 'KeyA');
    assert.equal(main['keyCode'], 65, 'windowsVirtualKeyCode must travel (browser-use port)');
    assert.equal(main['ctrl'], true, 'the modifier bitmask must reach the page');
    // The modifier is pressed in its own right, before the main key.
    assert.equal(seen[0]?.['key'], 'Control');
    assert.equal(seen[0]?.['code'], 'ControlLeft');
    // …and the page's keyboard layer selected the whole content because of it.
    const sel = await session.host.page.evaluate(() => {
      const ed = document.getElementById('ed') as HTMLTextAreaElement;
      return { start: ed.selectionStart, end: ed.selectionEnd, len: ed.value.length };
    });
    assert.deepEqual(sel, { start: 0, end: 16, len: 16 });
  } finally {
    await session.close();
  }
});

test('key never types: the target keeps its content byte for byte', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    await session.dispatch({ verb: 'act', ref, action: 'key', value: 'Control+a' });
    const value = await session.host.page.evaluate(
      () => (document.getElementById('ed') as HTMLTextAreaElement).value,
    );
    assert.equal(value, 'original content', 'act key must dispatch keys, never insert text');
  } finally {
    await session.close();
  }
});

test('a key the page ignores reads unknown, never verified off ambient mutations', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    // F7 has a virtual key code and dispatches cleanly; nothing on this page
    // handles it, and the churn interval is producing mutation records the
    // whole time. Reproduced live before it was fixed: `key Control+a` on
    // GitLab's Monaco (macOS, where the chord is Meta+a) moved no selection at
    // all and still read verified/dom_mutated off the editor's own rendering.
    const acted = await session.dispatch({ verb: 'act', ref, action: 'key', value: 'F7' });
    const effect = effectOf(acted);
    assert.equal(effect.verdict, 'unknown', JSON.stringify(acted));
    assert.equal(effect.evidence, 'no_observable_change_yet');
    // The records are still REPORTED — withheld from the verdict, not from the caller.
    const delta = (acted['effect'] as { delta: { after: string } }).delta;
    assert.match(delta.after, /mutationRecords=[1-9]/, JSON.stringify(delta));
  } finally {
    await session.close();
  }
});

test('key refuses a name it cannot press rather than dispatching a dead event', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    // browser-use returns (key, None) here and presses on; that is the silent
    // no-op this action exists to remove, so it is a refusal (core/keys.ts).
    for (const bad of ['flurb', 'Ctrl+a', 'toString', 'Control+flurb']) {
      const acted = await session.dispatch({ verb: 'act', ref, action: 'key', value: bad });
      assert.equal(
        (acted['rejected'] as { kind: string } | undefined)?.kind,
        'invalid_args',
        `${bad}: ${JSON.stringify(acted)}`,
      );
    }
    const seen = await session.host.page.evaluate(
      () => (globalThis as unknown as { seen: unknown[] }).seen,
    );
    assert.equal(seen.length, 0, 'a refused key must dispatch nothing at all');
  } finally {
    await session.close();
  }
});

// Earned in the FIELD, not by review: task 442 on the key build (n=3,
// benchmark-results/key-n3, docs/research-notes/platform-keybindings-2026-08-08.md).
// macOS honours emacs bindings in text controls, so `Control+h` is
// delete-backward — the model pressed what it believed was Monaco's
// find-and-replace and ate the leading `<` of index.html. The window went
// 383 -> 382 characters and the runtime answered `verified/selection_changed`:
// true of the field it inspected, a lie about what happened, and the identical
// shape to `type "Control+a"` reporting `verified/text_typed`.
//
// A deletion must be reported as a deletion. Both arms stay LOCAL — a keypress
// that edits a buffer proves the browser holds text, never that the site took it.
test('a keypress that deletes content says so, and is not called a selection change', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    // Put the caret at the end so Backspace removes a character. Backspace is
    // platform-neutral, which is the point: the defect is in the VERDICT, and it
    // must be pinned by a key that behaves the same everywhere.
    await session.dispatch({ verb: 'act', ref, action: 'key', value: 'End' });
    const before = await session.host.page.evaluate(
      () => (document.getElementById('ed') as HTMLTextAreaElement).value,
    );

    const acted = await session.dispatch({ verb: 'act', ref, action: 'key', value: 'Backspace' });
    const effect = effectOf(acted);

    const after = await session.host.page.evaluate(
      () => (document.getElementById('ed') as HTMLTextAreaElement).value,
    );
    assert.equal(after.length, before.length - 1, 'the fixture must actually lose a character');

    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(
      effect.evidence,
      'text_edited',
      `a deletion reported as ${String(effect.evidence)} is the false verified this pins`,
    );
    // The delta reports the OBSERVED quantity and does not claim to know the
    // document. Asserting "content shrank" here would re-pin the false claim
    // this wording replaced: a readable window can resize with no edit at all,
    // measured live when Monaco went 383 -> 438 on a one-character deletion.
    const delta = (acted['effect'] as { delta: { after: string } }).delta;
    assert.match(delta.after, /readable window \d+ -> \d+ characters/, JSON.stringify(delta));
    assert.ok(
      !/content (SHRANK|GREW)/.test(delta.after),
      'the delta must not claim a document-level change it cannot observe',
    );
  } finally {
    await session.close();
  }
});

test('a caret move with no content change is still selection_changed', async () => {
  const session = await startOn(PAGE);
  try {
    const ref = await editorRef(session);
    const acted = await session.dispatch({ verb: 'act', ref, action: 'key', value: 'End' });
    const effect = effectOf(acted);
    assert.equal(effect.verdict, 'verified', JSON.stringify(acted));
    assert.equal(
      effect.evidence,
      'selection_changed',
      'splitting out text_edited must not swallow the arm it was split from',
    );
    const value = await session.host.page.evaluate(
      () => (document.getElementById('ed') as HTMLTextAreaElement).value,
    );
    assert.equal(value, 'original content', 'moving the caret must not touch content');
  } finally {
    await session.close();
  }
});

test('text_edited can never satisfy the MUTATE gate', async () => {
  const session = await startOn(PAGE, 'MUTATE');
  try {
    const ref = await editorRef(session);
    await session.dispatch({ verb: 'act', ref, action: 'key', value: 'End' });
    const acted = await session.dispatch({ verb: 'act', ref, action: 'key', value: 'Backspace' });
    assert.equal(effectOf(acted).evidence, 'text_edited');
    // Editing a buffer is not a site change. The finish gate must still refuse.
    const finish = await session.dispatch({
      verb: 'finish',
      answer: '',
      evidenceRefs: [(acted as { actRef: string }).actRef],
    });
    // The gate answers with a TYPED REJECTION, not accepted:false — asserting the
    // wrong shape here would pass on a gate that had silently stopped running.
    assert.equal(finish['accepted'], undefined, JSON.stringify(finish));
    const rejected = finish['rejected'] as { kind: string; reason: string };
    assert.equal(rejected.kind, 'finish_rejected', JSON.stringify(finish));
    assert.match(rejected.reason, /verdict verified/, JSON.stringify(finish));
  } finally {
    await session.close();
  }
});

// Repairs that cannot succeed, from a review that inventoried all 25 repair
// sites in act.ts. A repair naming a rejected call is worse than none: it looks
// like guidance and closes off the alternative.
//
// The runtime mints nameless refs routinely — a clickable div with no accname —
// and 97 of 107 recorded act targets had an empty name. The old repair built
// `find {"name": ""}` from those, which find rejects on arrival.
const NAMELESS = `<!doctype html><title>nameless</title><h1>Host</h1>
  <div id="hit" onclick="void 0" style="width:60px;height:20px">.</div>`;

test('a stale nameless ref is repaired by read, never by find with an empty name', async () => {
  const session = await startOn(NAMELESS);
  try {
    const found = await session.dispatch({ verb: 'find', role: 'generic', name: '.' });
    const ref = ((found['matches'] as { ref: string; name: string }[]) ?? [])[0]?.ref;
    assert.ok(ref, `needed a clickable ref: ${JSON.stringify(found)}`);

    // Delete the node behind the ref so revalidation fails and the stale_ref
    // path — the one that builds the repair — is the branch taken.
    await session.host.page.evaluate(() => document.getElementById('hit')?.remove());

    const acted = await session.dispatch({ verb: 'act', ref, action: 'click' });
    const rejected = acted['rejected'] as { kind: string; repair?: string } | undefined;
    assert.equal(rejected?.kind, 'stale_ref', JSON.stringify(acted));
    const repair = String(rejected?.repair ?? '');
    assert.ok(
      !/"name"\s*:\s*""/.test(repair),
      `the repair must not mint an empty-name find: ${repair}`,
    );
    assert.match(repair, /"verb"\s*:\s*"read"/, repair);

    // And the contract that makes the old form a dead end must still hold.
    const empty = await session.dispatch({ verb: 'find', name: '' });
    assert.equal(
      (empty['rejected'] as { kind: string } | undefined)?.kind,
      'invalid_args',
      'find must still reject an empty name, or this regression pins nothing',
    );
  } finally {
    await session.close();
  }
});
