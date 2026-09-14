// `fill` on a value-sanitized input — date, time, month, week, datetime-local,
// color. These hold a structured value behind segmented UI, so there is no text
// field for insertText to reach.
//
// Earned on a public page (browser-use stress-tests, non-latin form) via a
// live-benchmark smoke run: the date input rejected fill, type and key, and the
// episode gave up. Measured mechanisms on that page:
//
//   CDP insertText  (what fill did)      -> ""            nothing happens
//   CDP digit keys  "05151990"           -> "1990-12-05"  ACCEPTED, AND WRONG
//   value = ISO + input/change           -> "1990-05-15"  correct
//
// The middle row is why this test exists as much as the first. Sending digits as
// key events is the browser-authentic-looking route and it SUCCEEDS — at writing a
// different date than the caller asked for, because segment order follows the
// input's locale and the runtime cannot know it. A mechanism that stores something
// nobody asked for, and reports success, is worse than one that fails loudly. So
// the value goes in as ISO yyyy-mm-dd, which is what the HTML spec defines
// `input[type=date].value` to be in every locale, with the input/change pair the UA
// itself fires when a picker commits.
//
// The second assertion is the control: a value in the WRONG format must come back
// `contradicted`, never silently stored.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WirSession } from '../src/session.js';

const PAGE =
  '<!doctype html><title>structured</title>' +
  '<label for="d">Birth date</label><input id="d" type="date">' +
  '<label for="t">Plain text</label><input id="t" type="text">';

test('fill sets a date input, and refuses to fake it when the format is wrong', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wir-struct-'));
  writeFileSync(join(dir, 'a.html'), PAGE);

  const session = await WirSession.start({
    headless: true,
    expectedAction: 'MUTATE',
    storageStatePath: null,
  });
  try {
    await session.goto(`file://${join(dir, 'a.html')}`);
    await session.dispatch({ verb: 'read' });

    const refFor = async (name: string) => {
      const f = (await session.dispatch({ verb: 'find', name })) as Record<string, any>;
      return f['matches']?.[0]?.ref as string;
    };
    const domValue = (id: string) =>
      session.host.page.evaluate((i) => (document.getElementById(i) as HTMLInputElement).value, id);

    // 1. ISO goes in, and the act says so truthfully.
    const dateRef = await refFor('Birth date');
    assert.ok(dateRef, 'the date input is findable by its label');
    const ok = (await session.dispatch({
      verb: 'act',
      ref: dateRef,
      action: 'fill',
      value: '1990-05-15',
    })) as Record<string, any>;
    assert.equal(ok['effect']?.verdict, 'verified', JSON.stringify(ok));
    assert.equal(await domValue('d'), '1990-05-15', 'the value actually landed');

    // 2. THE CONTROL. A format the input cannot accept must be CONTRADICTED —
    //    the digit-key route would have stored a plausible wrong date instead.
    await session.host.page.evaluate(() => {
      (document.getElementById('d') as HTMLInputElement).value = '';
    });
    await session.dispatch({ verb: 'read' });
    const bad = (await session.dispatch({
      verb: 'act',
      ref: await refFor('Birth date'),
      action: 'fill',
      value: '15/05/1990',
    })) as Record<string, any>;
    assert.equal(
      bad['effect']?.verdict,
      'contradicted',
      `a value the input cannot hold must not report success: ${JSON.stringify(bad)}`,
    );
    assert.equal(await domValue('d'), '', 'and nothing is stored');

    // 3. An ordinary text input still goes through the keystroke path untouched.
    await session.dispatch({ verb: 'read' });
    const textOk = (await session.dispatch({
      verb: 'act',
      ref: await refFor('Plain text'),
      action: 'fill',
      value: 'hello',
    })) as Record<string, any>;
    assert.equal(textOk['effect']?.verdict, 'verified', JSON.stringify(textOk));
    assert.equal(await domValue('t'), 'hello');
  } finally {
    await session.close();
  }
});
