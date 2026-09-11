// Regression for V3 (score-program; earned by task 442): the blob viewer's
// code content was projected as syntax tokens joined with ` · ` and ZERO
// newlines — `<!DOCTYPE · html · >` for `<!DOCTYPE html>` — so the model
// rebuilt the file with spaces where its newlines belonged and even a perfect
// write would have committed mangled HTML (442 attempt-2's payload).
// Verification of record is the live probe: debug/runs/probe/
// 2026-08-05T07-39-26-410Z (WIR read vs the oracle's preTextsRaw/bodyTextRaw
// on the live blob page). This fixture pins the projection join rules:
// newline at pre boundaries, space inside a pre line, ` · ` for prose runs
// (unchanged, measured preview behavior).
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

// Live-faithful shape (442 blob page): admitted per-line pre nodes — each owns
// direct text plus token spans, exactly how a highlighter renders a line — under
// one admitted container whose content preview spans the lines.
const PAGE = `<!doctype html><title>code</title>
  <main>
    <div role="group" aria-label="File contents"><pre>line <span>one</span></pre><pre>line <span>two</span></pre><pre>line <span>three</span></pre></div>
    <p>prose part <b>alpha</b> <i>beta</i></p>
    <p id="wrap">lead in <b>middle</b> trailing words</p>
  </main>`;

// V3 extension (earned by failed10-develop-1/task-442/attempt-1): Monaco
// renders each line as a DIV, and the post-type editor read showed tokens
// with ' · ' joins and no line structure — the model could not confirm its
// own correct edit and abstained. Inside a role-code context, line
// boundaries come from the page's own layout rows.
const DIV_LINES_PAGE = `<!doctype html><title>divcode</title>
  <main>
    <div role="code" aria-label="Editor lines"><div>alpha <span>one</span></div><div>beta <span>two</span></div><div>gamma <span>three</span></div></div>
    <p>prose part <b>alpha</b> <i>beta</i></p>
    <p id="wrap">lead in <b>middle</b> trailing words</p>
  </main>`;

test('line-per-div code content reads with newlines between rendered rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-divlines-'));
  writeFileSync(join(dir, 'a.html'), DIV_LINES_PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: null, tracePath: null, debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const main = (overview['regions'] as { ref: string; role: string }[])
      .find(r => r.role === 'main');
    assert.ok(main, JSON.stringify(overview));
    const read = await session.dispatch({ verb: 'read', target: main.ref });
    const children = read['children'] as { name?: string; content?: string }[];
    const code = children.find(c => c.name === 'Editor lines');
    assert.ok(code, `code container not projected: ${JSON.stringify(children)}`);
    assert.equal(code.content, 'alpha one\nbeta two\ngamma three',
      'rendered rows inside a code context are line boundaries; same-row runs join with a space');
    const prose = children.find(c => (c.content ?? '').includes('prose part'));
    assert.ok(prose, JSON.stringify(children));
    assert.equal(prose.content, 'prose part · alpha · beta',
      'prose previews stay byte-identical');
  } finally { await session.close(); }
});

test('per-line pre content reads back with newlines between lines and no invented glyphs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-codelines-'));
  writeFileSync(join(dir, 'a.html'), PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: null, tracePath: null, debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const main = (overview['regions'] as { ref: string; role: string }[])
      .find(r => r.role === 'main');
    assert.ok(main, JSON.stringify(overview));
    const read = await session.dispatch({ verb: 'read', target: main.ref });
    const children = read['children'] as { name?: string; content?: string }[];
    const code = children.find(c => c.name === 'File contents');
    assert.ok(code, `code container not projected: ${JSON.stringify(children)}`);
    assert.equal(code.content, 'line one\nline two\nline three',
      'a pre boundary is a line boundary; runs inside a line join with a space');
    const prose = children.find(c => (c.content ?? '').includes('prose part'));
    assert.ok(prose, JSON.stringify(children));
    assert.equal(prose.content, 'prose part · alpha · beta',
      'prose runs keep the distinct-run separator — measured preview behavior');
  } finally { await session.close(); }
});

// The fixture above pins this projection with a shape whose parent text precedes
// ALL of its children — so it passed unchanged while an element's own text was
// being emitted before its children, re-ordering every paragraph that wraps one.
// Measured at 509 instances across 32 URLs, live on two of three benchmark sites.
//
// The residue is what makes it dangerous: "You can invite a new member to or
// invite another group." is grammatical and missing a word. A garbled string
// gets caught; a fluent one gets quoted into an answer.
test('own text keeps its position among the children it wraps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-order-'));
  writeFileSync(join(dir, 'a.html'), DIV_LINES_PAGE);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
    harPath: null, tracePath: null, debugScreenshots: false,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const main = (overview['regions'] as { ref: string; role: string }[])
      .find(x => x.role === 'main');
    assert.ok(main, JSON.stringify(overview));
    const r = await session.dispatch({ verb: 'read', target: main.ref });
    const kids = (r['children'] ?? []) as { content?: string; text?: string }[];
    const wrap = kids.find(c => (c.content ?? '').includes('lead in'));
    assert.ok(wrap, `needed the wrapping paragraph: ${JSON.stringify(kids)}`);

    assert.equal(wrap.content, 'lead in · middle · trailing words',
      'text that sits after a child must be projected after it');

    // And the own-text field must not offer the spliced concatenation as a
    // reading: "lead in trailing words" is a sentence the page never contains.
    assert.ok(!/lead in trailing/.test(JSON.stringify(wrap)),
      `the spliced concatenation must not be emitted: ${JSON.stringify(wrap)}`);
  } finally { await session.close(); }
});

// A syntax highlighter wraps every token in its own span, so a source line
// arrives as separate runs. The compiler normalised each one (correct: accname
// requires it, prose needs it) and DROPPED the whitespace-only nodes between
// them entirely — so neither join could rebuild the line. A space join invents
// spaces around punctuation, an empty join fuses attributes, and the
// information needed to choose was gone before any projection saw it. That made
// a highlighted file unreconstructable at all rather than merely awkward, and
// both text verbs REPLACE, so an edit needs the whole file back.
//
// The fixture is the shape real highlighters emit — Rouge (GitLab), Prism and
// highlight.js all leave inter-token whitespace as a BARE text node between
// spans, not wrapped in one.
//
// KNOWN LIMIT, stated rather than hidden: a space wrapped in its own inline
// element (`<span> </span>`) is still lost. Chromium gives that node no entry in
// the DOMSnapshot layout tree, so it never reaches the compiler and no join can
// recover it. No highlighter surveyed emits that shape; if one is ever found,
// this is the note that says where to look.
//
// Verified live after this fix: GitLab's blob view assembles a file containing
// <!DOCTYPE, <title>, twitter:card, og:image:height and </html> — the last two
// of which were unreachable at any depth before.
const HIGHLIGHTED = `<!doctype html><title>hl</title>
  <main>
    <div role="code" id="ln1"><span>&lt;</span><span>html</span> <span>lang</span><span>=</span><span>"en"</span><span>&gt;</span></div>
    <div role="code" id="ln2"><span>&lt;</span><span>head</span><span>&gt;</span></div>
  </main>`;

test('a highlighted line rejoins into the source it came from', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-hl-'));
  writeFileSync(join(dir, 'a.html'), HIGHLIGHTED);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const main = (overview['regions'] as { ref: string; role: string }[])
      .find(x => x.role === 'main');
    assert.ok(main, JSON.stringify(overview));
    const r = await session.dispatch({ verb: 'read', target: main.ref });
    const kids = (r['children'] ?? []) as { content?: string }[];
    const joined = kids.map(k => k.content ?? '').join('\n');

    assert.match(joined, /<html lang="en">/,
      `tokens must rejoin into the source line: ${JSON.stringify(joined)}`);
    assert.match(joined, /<head>/, JSON.stringify(joined));
    // The two failure modes this replaces, named so a regression cannot pass by
    // trading one for the other.
    assert.ok(!/< html/.test(joined), `spaces invented around punctuation: ${joined}`);
    assert.ok(!/htmllang/.test(joined), `attributes fused together: ${joined}`);
  } finally { await session.close(); }
});

test('prose is unaffected by the raw-run path', async () => {
  // The raw form is used ONLY between code runs. If it leaked into prose, a
  // paragraph would start carrying the page's source indentation — so pin the
  // normalised path with the shape that exposed B1.
  const dir = mkdtempSync(join(tmpdir(), 'wir-prose-'));
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>p</title>
    <main><p>You can invite a new member to
      <strong>empathy-prompts</strong>   or invite another group.</p></main>`);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const main = (overview['regions'] as { ref: string; role: string }[])
      .find(x => x.role === 'main');
    assert.ok(main, JSON.stringify(overview));
    const text = JSON.stringify(await session.dispatch({ verb: 'read', target: main.ref }));
    assert.match(text, /empathy-prompts/, text);
    assert.ok(!/ {3}/.test(text), `source indentation leaked into prose: ${text}`);
  } finally { await session.close(); }
});

// Both halves of the raw-run rule, each found by adversarial review of the fix
// that introduced them — the suite was 106 green with both live.
//
// 1. FUSION. `<code>` maps to the ARIA `code` role (HTML-AAM 3.5.24), so two
//    inline `<code>`s each open a code context. The space between them belongs
//    to the enclosing `<p>`, whose context is prose — so the first version of
//    this fix dropped that space as "prose glue" and then joined the two code
//    runs with '', giving `npminstall`. Fluent, wrong, and exactly the class
//    the projection exists to prevent: a model quotes it instead of catching it.
//
// 2. ISOLATION. A plain `<pre>` block is ONE run with no code neighbour. Gating
//    the raw form on having a code neighbour meant its newlines were held by
//    the runtime and never shown — recall class, the zero-tolerance one.
//
// The rule that satisfies both: whitespace-only runs are kept by the compiler
// whatever context owns them, the JOIN decides (they are the spacing between
// two code runs and invisible in prose), and inside code a run's raw form is
// the text whether or not it has neighbours.
test('a space between two inline code elements survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-fuse-'));
  writeFileSync(join(dir, 'a.html'), `<!doctype html><title>fuse</title>
    <main><p>Run <code>npm</code> <code>install</code> now.</p></main>`);
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const main = (overview['regions'] as { ref: string; role: string }[])
      .find(x => x.role === 'main');
    assert.ok(main, JSON.stringify(overview));
    const r = await session.dispatch({ verb: 'read', target: main.ref });
    const text = JSON.stringify(r);
    assert.ok(!/npminstall/.test(text),
      `the page's own words were fused: ${text}`);
    assert.match(text, /npm install/, text);
  } finally { await session.close(); }
});

test("a plain pre block's newlines are shown, not just held", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-lonepre-'));
  writeFileSync(join(dir, 'a.html'),
    '<!doctype html><title>lone</title><main><pre>#!/bin/sh\necho one\necho two\n</pre></main>');
  const session = await WirSession.start({
    headless: true, expectedAction: 'RETRIEVE', storageStatePath: null,
  });
  try {
    await session.goto(`file://${dir}/a.html`);
    const overview = await session.dispatch({ verb: 'read' });
    const main = (overview['regions'] as { ref: string; role: string }[])
      .find(x => x.role === 'main');
    assert.ok(main, JSON.stringify(overview));
    const r = await session.dispatch({ verb: 'read', target: main.ref });
    const kid = ((r['children'] ?? []) as { content?: string; text?: string }[])[0];
    const shown = kid?.content ?? kid?.text ?? '';
    assert.match(shown, /#!\/bin\/sh\necho one\necho two/,
      `the runtime holds these newlines in the raw run and must not flatten them: ${JSON.stringify(shown)}`);
  } finally { await session.close(); }
});
