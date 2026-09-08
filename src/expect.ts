// The declared expectation of an act: what the caller MEANT to happen, checked
// after the settle against what the runtime observed, and reported beside the
// mechanical verdict — never folded into it.
//

// created an issue whose receipt showed `issue[assignee_ids][]=0`, then
// assigned the user through the sidebar (PUT …/issues/1.json

// submit whose receipt carried an e-mail the model had invented. In both the
// runtime verified that SOMETHING happened — dom_mutated, value_set,
// request_committed — and nothing let the model say what it INTENDED, so the
// MUTATE gate could demand "a request was sent" and never "the request I meant
// was sent". The receipt made the request visible; this makes it confrontable.
//
// What it is NOT. No comparison of an answer to page text: `text` is a
// normalized substring over the page's own rendered words, the same rule
// `find` uses; `sent` is string equality over the receipt's own fields;
// `state` is the AX vocabulary the graph already exposes; `navigation` is the

// The model owns meaning; this checks that the world matches what it declared.

import { normalize } from './find.js';
import { parseBody, type ReceiptLedger, type WireEntry } from './receipt.js';
import type { ActExpect, ActExpectation } from './types.js';

export type ExpectationFailure = NonNullable<ActExpectation['failed']>[number];

const EXPECT_KEYS = ['text', 'state', 'navigation', 'sent'] as const;
const STATE_KEYS = ['checked', 'selected', 'expanded', 'disabled', 'value'] as const;
const SENT_KEYS = ['method', 'path', 'fields'] as const;
/** Characters of an observed receipt value shown in a failure before the
 *  accounted cut; `read {target: actRef}` reaches the whole value. */
const OBSERVED_VALUE_WIDTH = 500;
/** Requests named in a "no such request" failure before the count takes over. */
const OBSERVED_REQUESTS_SHOWN = 8;

/** Shape validation at the one dispatch path: closed keys, typed values. The
 *  reason names the offending key so the repair is obvious. null when valid. */
export function validateExpect(x: unknown): string | null {
  if (x === undefined || x === null) return null;
  if (typeof x !== 'object' || Array.isArray(x)) return 'act: expect must be an object';
  const e = x as Record<string, unknown>;
  const stray = Object.keys(e).filter((k) => !(EXPECT_KEYS as readonly string[]).includes(k));
  if (stray.length > 0)
    return `act: expect has unknown key${stray.length > 1 ? 's' : ''} ${stray.join(', ')} — accepted: ${EXPECT_KEYS.join(', ')}`;
  const optStr = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string';
  const optBool = (v: unknown): boolean => v === undefined || v === null || typeof v === 'boolean';
  if (!optStr(e['text'])) return 'act: expect.text must be a string';
  if (typeof e['text'] === 'string' && normalize(e['text']) === '')
    return 'act: expect.text must not be empty';
  if (!optStr(e['navigation']))
    return 'act: expect.navigation must be a string (origin+path, or a path)';
  if (typeof e['navigation'] === 'string' && e['navigation'].trim() === '')
    return 'act: expect.navigation must not be empty';
  const state = e['state'];
  if (state !== undefined && state !== null) {
    if (typeof state !== 'object' || Array.isArray(state))
      return 'act: expect.state must be an object';
    const s = state as Record<string, unknown>;
    const bad = Object.keys(s).filter((k) => !(STATE_KEYS as readonly string[]).includes(k));
    if (bad.length > 0)
      return `act: expect.state has unknown key${bad.length > 1 ? 's' : ''} ${bad.join(', ')} — accepted: ${STATE_KEYS.join(', ')}`;
    for (const k of ['checked', 'selected', 'expanded', 'disabled']) {
      if (!optBool(s[k])) return `act: expect.state.${k} must be a boolean`;
    }
    if (!optStr(s['value'])) return 'act: expect.state.value must be a string';
    if (STATE_KEYS.every((k) => s[k] === undefined || s[k] === null))
      return 'act: expect.state names no state';
  }
  const sent = e['sent'];
  if (sent !== undefined && sent !== null) {
    if (typeof sent !== 'object' || Array.isArray(sent))
      return 'act: expect.sent must be an object';
    const s = sent as Record<string, unknown>;
    const bad = Object.keys(s).filter((k) => !(SENT_KEYS as readonly string[]).includes(k));
    if (bad.length > 0)
      return `act: expect.sent has unknown key${bad.length > 1 ? 's' : ''} ${bad.join(', ')} — accepted: ${SENT_KEYS.join(', ')}`;
    if (!optStr(s['method'])) return 'act: expect.sent.method must be a string';
    if (!optStr(s['path'])) return 'act: expect.sent.path must be a string';
    const fields = s['fields'];
    if (fields !== undefined && fields !== null) {
      if (typeof fields !== 'object' || Array.isArray(fields))
        return 'act: expect.sent.fields must be an object of name: value strings';
      const nonString = Object.entries(fields as Record<string, unknown>).find(
        ([, v]) => typeof v !== 'string',
      );
      if (nonString !== undefined)
        return `act: expect.sent.fields.${nonString[0]} must be a string`;
    }
  }
  if (EXPECT_KEYS.every((k) => e[k] === undefined || e[k] === null))
    return 'act: expect declares nothing';
  return null;
}

/** A path with its trailing slashes trimmed; the bare root stays "/". */
export function trimSlashes(p: string): string {
  const t = p.replace(/\/+$/, '');
  return t === '' ? '/' : t;
}

function originPath(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin + trimSlashes(u.pathname);
  } catch {
    return null;
  }
}

// ---- navigation ------------------------------------------------------------

/** The document must be SERVED at the declared origin+path after the act. A
 *  path-only declaration resolves against the origin of the document acted on.
 *  Compared on origin + path with trailing slashes trimmed; the query is not
 *  part of the claim (a server adds parameters of its own — the false
 *  `contradicted` scar). `servedUrl` is the address behind documentEpoch, so a
 *  client-side route that only moved the address bar does not hold. */
export function checkNavigation(
  declared: string,
  servedUrl: string,
  shownUrl: string,
  baseUrl: string,
): ExpectationFailure | null {
  let wanted: string | null;
  try {
    wanted = originPath(new URL(declared, baseUrl).toString());
  } catch {
    wanted = null;
  }
  if (wanted === null) {
    return {
      key: 'navigation',
      wanted: declared,
      observed: `${JSON.stringify(declared)} is not a URL or a path this runtime can resolve against ${baseUrl}`,
    };
  }
  const served = originPath(servedUrl);
  if (served === wanted) return null;
  const shownNote =
    shownUrl !== servedUrl
      ? ` (address bar shows ${shownUrl} — a client-side route; the site served no document there)`
      : '';
  return { key: 'navigation', wanted: declared, observed: `served ${servedUrl}${shownNote}` };
}

// ---- text ------------------------------------------------------------------

/** Non-overlapping occurrences of a normalized needle in a normalized haystack. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length))
    n += 1;
  return n;
}

export function checkText(
  declared: string,
  before: string | null,
  after: string | null,
  documentReplaced: boolean,
): ExpectationFailure | null {
  const needle = normalize(declared);
  if (after === null) {
    return {
      key: 'text',
      wanted: declared,
      observed: "the document's rendered text could not be read after settle",
    };
  }
  const afterNorm = normalize(after);
  const afterCount = countOccurrences(afterNorm, needle);
  if (afterCount === 0) {
    return {
      key: 'text',
      wanted: declared,
      observed: `text not found in the document after settle (${afterNorm.length} characters of rendered text searched)`,
    };
  }
  if (documentReplaced) return null;
  const beforeCount = before === null ? 0 : countOccurrences(normalize(before), needle);
  if (afterCount > beforeCount) return null;
  return {
    key: 'text',
    wanted: declared,
    observed: `present ${beforeCount} time${beforeCount === 1 ? '' : 's'} before dispatch and ${afterCount} after — not new to this act`,
  };
}

// ---- state -----------------------------------------------------------------

/** What the executor observed on the target after the act. `gone` names why
 *  nothing could be probed (the document was replaced; the node left the
 *  accessibility tree); the rest are the browser's own readings. */
export interface ObservedState {
  gone: string | null;
  checked: string | null;
  selected: string | null;
  expanded: boolean | null;
  disabled: boolean | null;
  value: string | null;
  /** The selected option's label when the target is a <select>: the reading
   *  a caller most likely meant when it declared a value that did not match. */
  selectedLabel: string | null;
}

const axBool = (raw: string | null): boolean | null =>
  raw === 'true' ? true : raw === 'false' ? false : null;

export function checkState(
  declared: NonNullable<ActExpect['state']>,
  obs: ObservedState,
): ExpectationFailure[] {
  const out: ExpectationFailure[] = [];
  const keys = STATE_KEYS.filter((k) => declared[k] !== undefined && declared[k] !== null);
  if (obs.gone !== null) {
    for (const k of keys) out.push({ key: `state.${k}`, wanted: declared[k], observed: obs.gone });
    return out;
  }
  const tri = (k: 'checked' | 'selected', raw: string | null): void => {
    const wanted = declared[k] as boolean;
    if (axBool(raw) === wanted) return;
    out.push({
      key: `state.${k}`,
      wanted,
      observed: raw === null ? `the target reports no ${k} state` : `${k}=${raw}`,
    });
  };
  if (keys.includes('checked')) tri('checked', obs.checked);
  if (keys.includes('selected')) tri('selected', obs.selected);
  if (keys.includes('expanded') && obs.expanded !== declared['expanded']) {
    out.push({
      key: 'state.expanded',
      wanted: declared['expanded'],
      observed:
        obs.expanded === null
          ? 'the target reports no expanded state'
          : `expanded=${String(obs.expanded)}`,
    });
  }
  if (keys.includes('disabled') && obs.disabled !== declared['disabled']) {
    out.push({
      key: 'state.disabled',
      wanted: declared['disabled'],
      observed: `disabled=${String(obs.disabled ?? false)}`,
    });
  }
  if (keys.includes('value')) {
    const wanted = (declared['value'] as string).trim();
    const got = obs.value;
    if (got === null) {
      out.push({
        key: 'state.value',
        wanted: declared['value'],
        observed: 'the target has no readable value',
      });
    } else if (got.trim() !== wanted) {
      const label =
        obs.selectedLabel !== null
          ? ` (selected option's label ${JSON.stringify(obs.selectedLabel)})`
          : '';
      out.push({
        key: 'state.value',
        wanted: declared['value'],
        observed: `value=${JSON.stringify(got)}${label}`,
      });
    }
  }
  return out;
}

// ---- sent ------------------------------------------------------------------

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function pathOf(url: string): string | null {
  try {
    return trimSlashes(new URL(url).pathname);
  } catch {
    return null;
  }
}

function pathMatches(declared: string, url: string): boolean {
  // An absolute declaration pins the origin too; a bare path compares paths.
  if (/^https?:\/\//i.test(declared)) return originPath(declared) === originPath(url);
  let want: string;
  try {
    want = trimSlashes(new URL(declared, 'http://x').pathname);
  } catch {
    return false;
  }
  return pathOf(url) === want;
}

function cut(v: string): string {
  return v.length <= OBSERVED_VALUE_WIDTH
    ? v
    : `${v.slice(0, OBSERVED_VALUE_WIDTH)} …(+${v.length - OBSERVED_VALUE_WIDTH} characters; read the actRef for all of it)`;
}

/** THE ANSWER DECIDES, as it does for the spine's submitAccepted: a request the
 *  server answered below 400 was accepted, whatever became of its body
 *  afterwards. Measured on a fetch answered 204: Chrome then reports
 *  loadingFailed net::ERR_ABORTED (canceled) for the bodiless response, and
 *  reading that as a refusal failed a request the server had taken. No
 *  answer at all — unanswered inside the window, or failed before one — is
 *  not accepted: the declared request may have gone out, but nothing says
 *  the site took it. */
function accepted(e: WireEntry): boolean {
  return e.status !== null && e.status < 400;
}

function describeRequest(e: WireEntry): string {
  const answer =
    e.status !== null
      ? `answered ${e.status}`
      : e.failed !== null
        ? `failed ${e.failed}`
        : 'no response inside the window';
  const after = e.status !== null && e.failed !== null ? `, then ${e.failed}` : '';
  return `${e.method} ${e.url} (${answer}${after})`;
}

/** The receipt must hold a request with the declared method (default: any
 *  non-GET), the declared path (trailing slashes trimmed; an absolute
 *  declaration pins the origin), and every declared field name=value (string
 *  compare after trim, on the body as the wire parsed it — form, JSON or
 *  multipart), and the server must have answered it below 400: a request
 *  answered 4xx/5xx, or one with no answer inside the window, is not "sent"
 *  in any sense a MUTATE finish could cite. Each failure reports the
 *  closest request verbatim — its method, address, answer and the actual value
 *  of every declared field. */
export function checkSent(
  declared: NonNullable<ActExpect['sent']>,
  ledger: ReceiptLedger | null,
  action: string,
): ExpectationFailure | null {
  if (ledger === null) {
    return {
      key: 'sent',
      wanted: declared,
      observed: `${action} arms no network observers, so nothing this act sent was watched`,
    };
  }
  const method =
    declared.method === undefined || declared.method === null
      ? null
      : declared.method.trim().toUpperCase();
  const path = declared.path === undefined || declared.path === null ? null : declared.path.trim();
  const fields = declared.fields ?? {};
  const wantedKeys = Object.keys(fields);
  const shape = `${method ?? 'non-GET'} ${path ?? '(any path)'}`;
  const all = ledger.entries;
  const byMethod = all.filter((e) =>
    method === null ? !READ_METHODS.has(e.method.toUpperCase()) : e.method.toUpperCase() === method,
  );
  const byPath = path === null ? byMethod : byMethod.filter((e) => pathMatches(path, e.url));
  if (byPath.length === 0) {
    const listed = all
      .slice(0, OBSERVED_REQUESTS_SHOWN)
      .map((e) => `${e.method} ${e.url}`)
      .join(', ');
    const rest = all.length - Math.min(all.length, OBSERVED_REQUESTS_SHOWN);
    return {
      key: 'sent',
      wanted: declared,
      observed:
        all.length === 0
          ? `no request of any kind was sent inside this act's window (${ledger.windowMs} ms)`
          : `no ${shape} request in the receipt; ${all.length} request${all.length === 1 ? '' : 's'} observed: ${listed}${rest > 0 ? `, +${rest} more` : ''}`,
    };
  }
  // Closest first: the request carrying the most of the declared fields.
  let best: { e: WireEntry; got: Record<string, string>; matched: number } | null = null;
  for (const e of byPath) {
    const body =
      e.postData !== null && e.postData !== ''
        ? parseBody(e.contentType, e.postData, ledger.passwordFields).fields
        : {};
    const got: Record<string, string> = {};
    let matched = 0;
    for (const k of wantedKeys) {
      const v = body[k];
      if (v !== undefined && v.trim() === (fields[k] as string).trim()) matched += 1;
      got[k] = v === undefined ? '(absent)' : cut(v);
    }
    if (matched === wantedKeys.length && accepted(e)) return null;
    if (best === null || matched > best.matched) best = { e, got, matched };
  }
  const b = best as { e: WireEntry; got: Record<string, string>; matched: number };
  const fieldsNote =
    wantedKeys.length === 0
      ? ''
      : `; fields: ${wantedKeys.map((k) => `${k}=${b.got[k]}`).join(', ')}`;
  const bodyNote =
    wantedKeys.length > 0 && b.e.postData === null && b.e.postDataWithheld
      ? ' (the body exceeded the capture bound; its fields were not observed)'
      : '';
  return {
    key: 'sent',
    wanted: declared,
    observed: `${describeRequest(b.e)}${fieldsNote}${bodyNote}`,
  };
}

/** The one line a MUTATE confrontation prints beside `sent:` — the declaration
 *  as the caller wrote it, and that it held. Bounded; nothing judged. */
export function expectationSummary(exp: ActExpectation): string {
  const d = JSON.stringify(exp.declared);
  return `${d.length > 200 ? `${d.slice(0, 200)}…` : d} ${exp.held ? 'held' : `failed (${(exp.failed ?? []).map((f) => f.key).join(', ')})`}`;
}
