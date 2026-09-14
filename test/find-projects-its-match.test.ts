// `find` shows what it matched ON.
//
// The haystack is name + own text (core/find.ts), so a match can be decided
// entirely by text the projection then discarded. Measured over the recorded
// corpus: 1,247 of 4,666 matches (26.7%) came back with `name: ""`, and 522 of
// those carried neither a name nor an item label — a ref, a role, and nothing
// readable. 196 of 1,481 productive finds returned matches that were ALL nameless.
// That is the recall class stated plainly: the runtime saw it, used it to decide,
// and did not show you.
//
// This is the opposite of a matcher. It shows the caller the string the
// deterministic substring rule already used.
//
// Verified on real pages before this was written: 21 of 21 nameless matches now
// carry their text (quotes.toscrape, books.toscrape), and 101 of 101 link matches
// now carry an href across six random sites — up from zero, because href was
// compiled and projected by nothing anywhere in the runtime.
//
// THREE GUARDS, each with a scar, and the last two tests are the controls:
//   - spliced text is withheld, reusing nodeDetail's rule verbatim. Own text is
//     runs CONCATENATED, so a child between them yields "invite a member to or
//     invite a group" — fluent, grammatical, missing a word. A garbled string gets
//     caught; a plausible one gets quoted, and find results are what `finish` cites.
//   - the bound is boundedLabel at the SAME width buildItemIndex uses. Two widths
//     over one node mint two continuation chains: six ledger entries for three
//     nodes, and a confrontation still claiming withheld content after every
//     character had been read.
//   - href is whole or absent. A truncated URL is byte-prefix truncation presented
//     as complete, and the model will navigate it into invalid_args.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const LONG =
  'the quick brown fox jumps over the lazy dog and keeps going well past ' +
  'any reasonable bound so the cut is forced to happen somewhere';
const PAGE =
  '<!doctype html><title>match</title><h1>Match</h1>' +
  // nameless, matched purely on its own text
  '<p>plain paragraph carrying findable words</p>' +
  // spliced: a child sits between the runs, so the concatenation reads wrong
  '<p>invite a member to <strong>empathy-prompts</strong> or invite another group.</p>' +
  // long own text, to force the bound
  `<p>${LONG}</p>` +
  '<a href="/somewhere/deep?x=1">a link</a>' +
  '<input type="text" aria-label="Field" value="typed value">';

test('a match carries the text it was matched on, its href, and its value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-match-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });

    // 1. A nameless node matched on its own text now shows that text.
    const plain = (await session.dispatch({ verb: 'find', name: 'findable words' })) as Record<
      string,
      any
    >;
    const m = (plain['matches'] ?? []).find((x: any) => !x.name || !String(x.name).trim());
    assert.ok(m, `precondition: a nameless match: ${JSON.stringify(plain['matches'])}`);
    assert.match(
      String(m.text),
      /findable words/,
      'the string the substring rule used must be visible to the caller',
    );

    // 2. href travels, whole.
    const link = (await session.dispatch({ verb: 'find', role: 'link', name: 'a link' })) as Record<
      string,
      any
    >;
    const l = link['matches'][0];
    assert.ok(l.href, 'a link match carries its destination');
    assert.match(
      String(l.href),
      /\/somewhere\/deep\?x=1$/,
      'and carries it WHOLE — a cut URL is truncation presented as complete',
    );

    // 3. value travels, so `find role=textbox` can say what is in the box.
    const field = (await session.dispatch({ verb: 'find', role: 'textbox' })) as Record<
      string,
      any
    >;
    assert.equal(field['matches'][0]?.value, 'typed value');
  } finally {
    await session.close();
  }
});

test('spliced own text is withheld, exactly as nodeDetail withholds it', async () => {
  // CONTROL 1. "invite a member to <strong>X</strong> or invite another group"
  // concatenates to "invite a member to or invite another group" — plausible enough
  // to be quoted as evidence, and wrong. Saying nothing beats saying it wrongly.
  const dir = mkdtempSync(join(tmpdir(), 'wir-splice-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });
    const r = (await session.dispatch({ verb: 'find', name: 'invite a member' })) as Record<
      string,
      any
    >;
    const spliced = (r['matches'] ?? []).find((x: any) => String(x.role) === 'paragraph');
    assert.ok(
      spliced,
      `precondition: the spliced paragraph matched: ${JSON.stringify(r['matches'])}`,
    );
    assert.equal(
      spliced.text,
      undefined,
      'a concatenation that reads as fluent prose with a word missing is not shown',
    );
  } finally {
    await session.close();
  }
});

test('a long match text is cut at the shared bound and offers the same continuation', async () => {
  // CONTROL 2. The width must equal buildItemIndex's, or one node mints two
  // independent chains and the ledger double-counts what it withheld.
  const dir = mkdtempSync(join(tmpdir(), 'wir-bound-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true,
    expectedAction: 'RETRIEVE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });
    const r = (await session.dispatch({ verb: 'find', name: 'quick brown fox' })) as Record<
      string,
      any
    >;
    const long = (r['matches'] ?? []).find((x: any) => x.text);
    assert.ok(long, 'precondition: the long paragraph matched with text');
    // NOT a length comparison against the original: the marker adds characters,
    // so a string cut at 80 can be LONGER than a 131-char original. The property
    // that matters is that content was withheld and is reachable.
    assert.ok(
      !String(long.text).includes('happen somewhere'),
      `the tail is withheld: ${JSON.stringify(long.text)}`,
    );
    assert.match(
      String(long.text),
      /\[\+\d+ chars: /,
      'the cut is marked with an EXACT residual, never a bare ellipsis',
    );
    const call = /\{"verb":"read","target":"(n_[0-9a-f]+)"\}/.exec(String(long.text));
    assert.ok(call, `and names the literal call that reaches the rest: ${long.text}`);
    // The promise must be honourable — a computable continuation that rejects is
    // the C4 class this codebase has paid for before.
    const rest = (await session.dispatch({ verb: 'read', target: call[1]! })) as Record<
      string,
      any
    >;
    assert.equal(
      rest['rejected'],
      undefined,
      `the offered call must work: ${JSON.stringify(rest['rejected'])}`,
    );
  } finally {
    await session.close();
  }
});
