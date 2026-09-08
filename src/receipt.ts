// The act receipt: the requests the browser sent inside one act's window, as
// data the caller can read — method, URL, status, body fields — never a verdict.
//
// Why it exists. An act's effect verdict answers "did SOMETHING happen on the
// site"; it cannot answer "did the request I meant go where I meant, carrying
// what I meant". Measured over the 812-request corpus: 86 of 104 failed mutations
// DID mutate — on the wrong route or with the wrong fields — while `act`
// reported `verified`, because a site-side effect had occurred. The request that
// carried the mutation was on the wire the whole time and reached the model
// never. Reproduced before this file existed on both sites it was built against

//     answered 200]` and nothing about the POST /api/v4/projects/183/invitations
//     {access_level: 30, user_id: "2264"} that added the member.

//     while the browser sent POST /admin/catalog/product/save/... (302) and the
//     redirected GET (200), inside the act's own window.
//
// What it is NOT. No comparison against any expectation, no vocabulary from any

// model owns meaning (docs/vision.md) — and whether the route was the right one
// is meaning.
//
// Bounded per the pagination invariant (docs/vision.md §Limits are pagination,
// never loss): the act result shows a capped slice, states exactly how many
// requests and fields were withheld, and offers `read {target: actRef}`, which
// pages through the whole ledger with full values.

import { boundedLabel } from './text.js';
import type { ActReceipt, ReceiptBody, ReceiptRequest } from './types.js';
export type { ActReceipt, ReceiptBody, ReceiptRequest } from './types.js';

/** One request hop as the CDP Network domain reported it. A redirect chain is
 *  several entries under one requestId, each with its own status. */
export interface WireEntry {
  requestId: string;
  /** ms after this act's dispatch. */
  atMs: number;
  /** CDP ResourceType, lower-cased: document, xhr, fetch, script, image… */
  type: string;
  method: string;
  url: string;
  frame: 'main' | 'child' | 'unknown';
  /** CDP initiator type: parser, script, preload, other… */
  initiator: string;
  contentType: string | null;
  postData: string | null;
  /** True when the request carried a body the observer did not receive (over
   *  the capture bound). */
  postDataWithheld: boolean;
  status: number | null;
  mimeType: string | null;
  failed: string | null;
}

/** Requests shown in the act result itself. The rest are one read away. */
export const RECEIPT_REQUESTS_SHOWN = 6;
/** Fields shown per body in the act result. */
export const RECEIPT_FIELDS_SHOWN = 20;
/** Characters of a field value shown in the act result. */
export const RECEIPT_VALUE_WIDTH = 200;
/** Requests per page of `read {target: actRef}`. */
export const RECEIPT_PAGE = 10;
/** The largest body the observer asks the browser to hand over. */
export const RECEIPT_POST_DATA_BOUND = 262_144;

const REDACTED = '[redacted]';

// Types the act result lists first. Ranking may ORDER, never remove: a
// mutation travels as a non-GET, a form submit as a Document, and an asset load
// (script, image, stylesheet, font) is the rendering's own traffic — it still
// counts, it still pages, it just goes last.
const ASSET_TYPES = new Set([
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'texttrack',
  'manifest',
  'signedexchange',
  'cspviolationreport',
  'prefetch',
]);

function rank(e: WireEntry): number {
  if (e.method !== 'GET' && e.method !== 'HEAD' && e.method !== 'OPTIONS') return 0;
  if (e.type === 'document') return 1;
  if (ASSET_TYPES.has(e.type)) return 3;
  return 2;
}

/** Stable order: mutations, then documents, then other application requests,
 *  then assets — and inside each band, the wire's own order. */
export function rankedEntries(entries: readonly WireEntry[]): WireEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map((x) => x.e);
}

function stripFragment(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

// Is this a password field? Two sources, both mechanical: the page's own
// `<input type=password>` names read before dispatch, and the field name itself.
// The name heuristic catches a password posted by a form whose input the
// pre-dispatch read never saw (a form inside a child frame, a JSON login). It
// redacts a little too much rather than a little too little; the field NAME is
// always kept, so nothing about the request's shape is lost.
function isPasswordField(name: string, passwordFields: ReadonlySet<string>): boolean {
  if (passwordFields.has(name)) return true;
  const leaf = /\[([^\]]*)\]\s*$/.exec(name)?.[1] ?? name;
  return /pass(word|wd|phrase)?$|^pwd$|password/i.test(leaf);
}

function scalar(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined');
}

/** The body as name -> value, in the encoding the wire used. Repeated form keys
 *  become one JSON array so `ids[]=1&ids[]=2` stays one field. */
export function parseBody(
  contentType: string | null,
  postData: string,
  passwordFields: ReadonlySet<string>,
): ReceiptBody {
  const ct = (contentType ?? '').toLowerCase();
  // The boundary is read from the header AS SENT — lower-casing it made the
  // split miss every part, and the whole body arrived as the first field's

  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType ?? '')?.[2];
  const redact = (fields: Record<string, string>): Record<string, string> => {
    for (const k of Object.keys(fields)) {
      if (isPasswordField(k, passwordFields)) fields[k] = REDACTED;
    }
    return fields;
  };
  if (ct.includes('multipart/form-data')) {
    if (boundary !== undefined) {
      const fields: Record<string, string> = {};
      for (const part of postData.split(`--${boundary}`)) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd < 0) continue;
        const headers = part.slice(0, headerEnd);
        const name = /name="([^"]*)"/.exec(headers)?.[1];
        if (name === undefined) continue;
        const filename = /filename="([^"]*)"/.exec(headers)?.[1];
        const value = part.slice(headerEnd + 4).replace(/\r\n$/, '');
        fields[name] =
          filename !== undefined
            ? `[file ${JSON.stringify(filename)}, ${value.length} bytes]`
            : value;
      }
      return { encoding: 'multipart', fields: redact(fields) };
    }
  }
  if (ct.includes('json') || /^\s*[[{]/.test(postData)) {
    try {
      const parsed: unknown = JSON.parse(postData);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
          fields[k] = scalar(v);
        return { encoding: 'json', fields: redact(fields) };
      }
      return { encoding: 'json', fields: { '(body)': postData } };
    } catch {
      /* not JSON after all: fall through */
    }
  }
  if (
    ct.includes('application/x-www-form-urlencoded') ||
    (ct === '' && /^[^=&\s]+=[^&]*(&|$)/.test(postData))
  ) {
    const grouped = new Map<string, string[]>();
    for (const [k, v] of new URLSearchParams(postData)) {
      const list = grouped.get(k) ?? [];
      list.push(v);
      grouped.set(k, list);
    }
    const fields: Record<string, string> = {};
    for (const [k, list] of grouped)
      fields[k] = list.length === 1 ? (list[0] as string) : JSON.stringify(list);
    return { encoding: 'form', fields: redact(fields) };
  }
  return { encoding: 'text', fields: { '(body)': postData } };
}

/** The full, unbounded projection of one entry — what a receipt page serves. */
export function projectEntry(e: WireEntry, passwordFields: ReadonlySet<string>): ReceiptRequest {
  const out: ReceiptRequest = {
    atMs: e.atMs,
    type: e.type,
    method: e.method,
    url: stripFragment(e.url),
    status: e.status,
    initiator: e.initiator,
  };
  if (e.failed !== null) out.failed = e.failed;
  if (e.frame === 'child') out.frame = 'child';
  if (e.postData !== null && e.postData !== '') {
    out.body = parseBody(e.contentType, e.postData, passwordFields);
  } else if (e.postDataWithheld) {
    out.body = {
      encoding: 'text',
      fields: {},
      note: `the request carried a body larger than the ${RECEIPT_POST_DATA_BOUND} byte capture bound; its fields were not observed`,
    };
  }
  return out;
}

/** The bounded projection for the act result: capped fields, capped values,
 *  every cut accounted with the read that reaches the rest. */
function boundEntry(full: ReceiptRequest, actRef: string): ReceiptRequest {
  if (full.body === undefined) return full;
  const continuation = `{"verb":"read","target":"${actRef}"}`;
  const names = Object.keys(full.body.fields);
  const fields: Record<string, string> = {};
  for (const k of names.slice(0, RECEIPT_FIELDS_SHOWN)) {
    fields[k] = boundedLabel(full.body.fields[k] as string, actRef, RECEIPT_VALUE_WIDTH);
  }
  const body: ReceiptBody = { encoding: full.body.encoding, fields };
  if (names.length > RECEIPT_FIELDS_SHOWN) {
    body.withheld = {
      count: names.length - RECEIPT_FIELDS_SHOWN,
      estimated: false,
      unit: 'fields',
      continuation,
    };
  }
  if (full.body.note !== undefined) body.note = full.body.note;
  return { ...full, body };
}

export interface ReceiptLedger {
  actRef: string;
  windowMs: number;
  entries: WireEntry[];
  passwordFields: Set<string>;
  /** The URL of the document the act was dispatched on — the page that made
   *  these requests. The session's `navigate` closure admits a receipt's
   *  addresses on that document's origin: the runtime showed them. */
  documentUrl: string;
}

/** The receipt that travels in the act result. */
export function receiptFor(ledger: ReceiptLedger): ActReceipt {
  const ranked = rankedEntries(ledger.entries);
  const shown = ranked
    .slice(0, RECEIPT_REQUESTS_SHOWN)
    .map((e) => boundEntry(projectEntry(e, ledger.passwordFields), ledger.actRef));
  const out: ActReceipt = {
    attribution: 'window',
    windowMs: ledger.windowMs,
    total: ranked.length,
    requests: shown,
  };
  // A request the window closed on before its answer arrived shows status
  // null. Say so once, in words: a null beside a POST is the difference between
  // "refused" and "not yet answered", and the model must not read it as either.
  const unanswered = ranked.filter((e) => e.status === null && e.failed === null).length;
  if (unanswered > 0) {
    out.note =
      `${unanswered} of ${ranked.length} request${ranked.length === 1 ? '' : 's'} had no ` +
      'response yet when the window closed (status null): not answered inside this act, not refused';
  }
  if (ranked.length > shown.length) {
    out.withheld = {
      count: ranked.length - shown.length,
      estimated: false,
      unit: 'requests',
      continuation: `{"verb":"read","target":"${ledger.actRef}"}`,
    };
  }
  return out;
}

/** The receipt an action that arms no observers reports. Says so. */
export function unarmedReceipt(action: string): ActReceipt {
  return {
    attribution: 'unarmed',
    windowMs: 0,
    total: 0,
    requests: [],
    note:
      `${action} acts on the browser alone and arms no network observers; ` +
      'requests it may have triggered were not watched',
  };
}

/** One page of `read {target: actRef}`: full values, every field, RECEIPT_PAGE
 *  requests per page in the same rank order the act result used. */
export function receiptPage(
  ledger: ReceiptLedger,
  cursor: string | null,
):
  | {
      payload: Record<string, unknown>;
      withheld: { count: number; unit: string; estimated: boolean; continuation: string } | null;
    }
  | { rejected: { reason: string; repair: string } } {
  const ranked = rankedEntries(ledger.entries);
  let from = 0;
  if (cursor !== null) {
    const m = /^receipt:(\d+)$/.exec(cursor);
    if (m === null || (Number(m[1]) >= ranked.length && ranked.length > 0)) {
      return {
        rejected: {
          reason: `cursor ${JSON.stringify(cursor)} is not one this receipt minted (it holds ${ranked.length} requests)`,
          repair: `{"verb":"read","target":"${ledger.actRef}"} for the first page`,
        },
      };
    }
    from = Number(m[1]);
  }
  const slice = ranked.slice(from, from + RECEIPT_PAGE);
  const rest = ranked.length - from - slice.length;
  const withheld =
    rest > 0
      ? {
          unit: 'requests',
          count: rest,
          estimated: false,
          continuation: `{"verb":"read","target":"${ledger.actRef}","cursor":"receipt:${from + RECEIPT_PAGE}"}`,
        }
      : null;
  return {
    payload: {
      actRef: ledger.actRef,
      receipt: {
        attribution: 'window',
        windowMs: ledger.windowMs,
        total: ranked.length,
        from,
        requests: slice.map((e) => projectEntry(e, ledger.passwordFields)),
        ...(withheld === null ? {} : { withheld }),
      },
    },
    withheld,
  };
}
