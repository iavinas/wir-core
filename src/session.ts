// WirSession — the one dispatch path. The probe and the agent both call dispatch();
// neither gets a private copy (docs/debug.md). Owns: graph freshness, the response
// envelope, the evidence ledger, and the mechanical finish gate
// (docs/adr/003-mechanical-finish-gate.md).
// The v0 `unchanged` marker was deleted after firing 2 times in 4,980 recorded
// calls (0.04%): every act correctly nulls the graph, so the marker's premise —
// repeated queries against an unchanged document — almost never survives an
// episode. The redump disease is cured by dense projection and pagination
// (0.7% byte-identical repeats vs attempt 6's 44%), not by this mechanism.

import { createHash } from 'node:crypto';
import { WirHost, EpochChangedError } from './host.js';
import { compile, ROOT_REF } from './compiler.js';
import { badCursor, readOverview, readTarget } from './read.js';
import type { InlineOffer } from './text.js';
import { collectSubtree, find, normalize } from './find.js';
import { ActExecutor } from './act.js';
import { expectationSummary, validateExpect } from './expect.js';
import type {
  ActReceipt,
  DocumentBlock,
  ReplacedBlock,
  EffectEvidence,
  Envelope,
  Rejection,
  RejectionKind,
  VerbRequest,
  WirGraph,
} from './types.js';

// The finish status vocabulary. `success` and `not_found_error` were the whole

// permission_denied_error, and 9 measured episodes reached the right conclusion
// with no word for it. These describe the WORLD, not the model's own failure —
// that remains give_up, which is an agent-local tool and never a finish.
const OBSERVATION_BAR_STATUSES = new Set([
  'not_found_error',
  'action_not_allowed_error',
  'permission_denied_error',
]);
const FINISH_STATUSES = new Set(['success', ...OBSERVATION_BAR_STATUSES]);

export type ExpectedAction = 'RETRIEVE' | 'NAVIGATE' | 'MUTATE';

/** One act that satisfies the MUTATE finish gate: what was done, and what the
 *  runtime observed that made it count. */
/** One line of what the receipt says was sent: the first non-GET request's
 *  method and path with up to six body fields (values cut at 40 chars). Pure
 *  restatement of data the act result already carries; nothing is judged. */
function sentSummary(result: unknown): { sent?: string } {
  const rc = (result as { receipt?: { requests?: Array<Record<string, unknown>> } }).receipt;
  const reqs = rc?.requests ?? [];
  const r = reqs.find((q) => typeof q['method'] === 'string' && q['method'] !== 'GET') ?? reqs[0];
  if (!r) return {};
  let path = String(r['url'] ?? '');
  try {
    const u = new URL(path);
    path = u.pathname + u.search;
  } catch {
    /* keep raw */
  }
  const fields = (r['body'] as { fields?: Record<string, unknown> } | undefined)?.fields ?? {};
  const shown = Object.entries(fields)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(', ');
  const rest = Object.keys(fields).length - Math.min(6, Object.keys(fields).length);
  return {
    sent: `${String(r['method'])} ${path.slice(0, 120)}${shown ? ` {${shown}${rest > 0 ? `, +${rest} more` : ''}}` : ''}`,
  };
}

export interface GateEligibleAct {
  actRef: string;
  action: 'click' | 'fill' | 'select' | 'type' | 'key' | 'upload' | 'scroll' | 'hover';
  evidence: EffectEvidence;
  /** What the act's receipt says the browser SENT — the first non-GET request:
   *  method, path, and the first few body fields — so a confrontation can
   * This behavior was verified during testing.
   *  arm: a newsletter subscription posted email=user@example.com, an invite
   *  went to /invitations, a project was created with the README box left
   *  ticked — each visible in its own receipt, none read back before finish. */
  sent?: string;
  /** What the caller DECLARED the act would send or show, and whether it held
   *  (core/expect.ts) — printed beside `sent:` so the confrontation reads
   *  intent and observation on one line. An act enters this ledger on a held
   *  `sent` or `navigation` declaration even when its mechanical evidence was
   *  local-only: the receipt or the served address proved the declared intent,
   *  which is more than "a request was sent". */
  expectation?: string;
  /** Sent field values the page had NOT shown before the caller typed them —
   *  `field=value`, verbatim, at most UNSEEN_SHOWN. A fact about DELIVERY, in
   *  the same class as "refs never observed this episode": the runtime knows
   *  every text run it delivered, and this says the value was in none of them
   *  and not in the request instruction when the caller typed it. Never a
   *  judgement of the value, never a comparison to an expected answer — the
   * This behavior was verified during testing.
   *  ("Subscribe to the newsletter") posted email=user@example.com in two arms
   *  and the operator's own e-mail in a third — a value present in no page and
   *  no request — while the customer's address sat on My Account, unread. */
  unseen?: string[];
  /** Set when the check could not be made honestly: a ledger overflowed its
   *  bound, so "not shown" would be a claim about runs the runtime dropped. */
  unseenUnchecked?: string;
}

/** Field names whose values are the page's own tokens, never the caller's. */
const SECRET_FIELD = /token|key|csrf|nonce|secret|password/i;
/** How many unseen values one act reports; the count of the rest is stated. */
const UNSEEN_SHOWN = 5;
/** Distinct normalized runs the delivered-text ledger holds before it starts
 *  counting drops instead. ~40 bytes a run: a few MB at the bound. Measured
 *  need: a 20 KB read is a few hundred runs, so an episode of 100 calls sits an
 *  order of magnitude under it. */
const DELIVERED_BOUND = 100_000;
/** Distinct values the caller-typed ledger holds; an episode fills tens of
 *  fields, never hundreds. */
const TYPED_BOUND = 64;
/** Shortest value worth flagging: below this a value is a digit or a word
 *  fragment that any page shows somewhere. */
const UNSEEN_MIN_LENGTH = 4;

/** One continuation the runtime minted, and whether the caller ever took it.
 *  Pagination is the runtime's promise that a bound cost nothing (docs/vision.md
 *  — limits are pagination, never loss); an offer never called back is the
 *  mechanical record of the half of that promise the caller did not collect. */
export interface ContinuationOffer {
  /** the literal next call, exactly as the projection minted it */
  call: string;
  /** what that call reaches, when the projection stated it; null when it did not */
  /** How much this offer withholds. Never null: an offer is ledgered only when
   *  it accounts for withheld content, so an entry that cannot state its own
   *  count is one the confrontation could not honestly print.
   *
   *  Known gap, owned, not fixed here: the count carries no UNIT — characters
   *  for an inline bound, items for `moreItems`, matches for a find. The
   *  confrontation sorts across them, so a 300-character cut and a 40-item list
   *  are ranked against each other as if commensurable. Fixing it means the
   *  mint sites naming the unit, which is a protocol change to `withheld`, not
   */
  withheldCount: number;
  /** WHAT the count counts — characters, items, matches, controls. The mint site
   *  says so; nothing here infers it. Without a unit the confrontation sorted a
   *  419-character comment tail above a 50-item list it had never opened, and
   *  printed six of the former while evicting every one of the latter. */
  unit: string;
  /** the document version it was minted against — a cursor and a ref both belong
   *  to the graph that produced them, so an offer outlives its document only as
   *  a call that would reject */
  epoch: string;
  consumed: boolean;
}

// Every rejection goes through this helper so no wire literal can drift from
// the one Rejection union (defect C5: session hand-wrote untyped literals).
function reject(kind: RejectionKind, reason: string, repair?: string): Record<string, unknown> {
  const typed: Rejection = {
    rejected: { kind, reason, ...(repair !== undefined ? { repair } : {}) },
  };
  return typed as unknown as Record<string, unknown>;
}

// origin + path (trailing slashes trimmed) + query, fragment dropped: the
// address as the server would see it. ONE normalization for the closure
// (`noteUrl`), the shown-address check and the served-versus-shown guards on
// `navigate`, so no two of them can disagree about whether two spellings are
// one address. (The guards' own copy kept the trailing slash the closure
// This behavior was verified during testing.
// reproduced miss, the map's addresses never differed by one.)
function addressKey(u: string): string {
  try {
    const p = new URL(u);
    return `${p.origin}${p.pathname.replace(/\/+$/, '')}${p.search}`;
  } catch {
    return u.split('#')[0] ?? u;
  }
}
function sameAddress(a: string, b: string): boolean {
  return addressKey(a) === addressKey(b);
}

// A call's mechanical identity: its non-null arguments, order-independent. A
// continuation IS a call — the literal next one — so the same function keys both
// sides of the ledger and "was it taken" is exact argument equality, never a
// resemblance test. Known divergence, owned: a follow-up that changes any other
// filter is a different query and does not consume the offer.
function callKey(call: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(call)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
}

// The published schemas close every verb — additionalProperties:false on all
// five (core/toolschemas.ts) — and the validator did not check it: an unknown
// key passed and was silently ignored, so `read {"ref":"n_x"}` — a plausible
// garble, since act addresses by ref, read by target and find by within —
// returned the full overview as if asked for it, and an act carrying stray
// This behavior was verified during testing.
// passes). The rejection names the keys and the verb's accepted set; the
// repair echoes the caller's own values into the corrected literal call,
// mapping the obvious renames.
const ACCEPTED_KEYS: Partial<Record<string, readonly string[]>> = {
  read: ['verb', 'target', 'cursor', 'all', 'fields'],
  find: ['verb', 'role', 'name', 'within', 'state', 'limit', 'cursor'],
  act: ['verb', 'ref', 'action', 'value', 'expect', 'until'],
  navigate: ['verb', 'url', 'force'],
  finish: ['verb', 'answer', 'evidenceRefs', 'status'],
};
const KEY_RENAMES: Partial<Record<string, Record<string, string>>> = {
  read: { ref: 'target' },
  find: { ref: 'within' },
};

function unknownKeys(req: VerbRequest): { reason: string; repair: string } | null {
  const accepted = ACCEPTED_KEYS[req.verb];
  if (!accepted) return null; // unknown verb: the dispatch switch answers with its own repair
  const r = req as unknown as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !accepted.includes(k));
  if (unknown.length === 0) return null;
  const rename = KEY_RENAMES[req.verb] ?? {};
  const corrected: Record<string, unknown> = {};
  for (const k of accepted) if (r[k] !== undefined && r[k] !== null) corrected[k] = r[k];
  for (const k of unknown) {
    const to = rename[k];
    if (to !== undefined && corrected[to] === undefined && typeof r[k] === 'string')
      corrected[to] = r[k];
  }
  return {
    reason:
      `${req.verb}: unknown key${unknown.length > 1 ? 's' : ''} ` +
      `${unknown.join(', ')} — accepted: ${accepted.join(', ')}`,
    repair: JSON.stringify(corrected),
  };
}

// ARGUMENT GENEROSITY — mechanical and lossless, never semantic. Measured over
// This behavior was verified during testing.
// This behavior was verified during testing.
// model sends are not wrong intentions but wrong spellings of an intention the
// runtime can read without guessing — the continuation object it itself
// emitted pasted whole into `cursor` (104 rejections), the name filter called
// `query`/`text` (74), the key `Return` for Enter (69, one per episode: every
// model learns it once and pays a turn for the lesson), and the ref called
// `target` (7). Each is a rewrite with exactly one reading; each was a bare
// rejection costing a turn. So the rewrite is applied and ECHOED under
// `applied` — the exact normalized call — so the next turn can be right without
// the alias, and the canonical names stay the contract (the schemas do not
// advertise these). Anything with two readings still rejects: `name` and
// `query` both given and different; a cursor that is neither a bare id nor a
// continuation this runtime mints.
const KEY_ALIASES: Readonly<Record<string, string>> = {
  Return: 'Enter',
  Esc: 'Escape',
  Down: 'ArrowDown',
  Up: 'ArrowUp',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};
const FIND_NAME_ALIASES = ['query', 'text'] as const;

interface Normalized {
  req: Record<string, unknown>;
  /** The normalized call, only when something was rewritten. */
  applied: Record<string, unknown> | null;
  /** The key name the alias resolved to, for the act result's effect. */
  keyApplied: string | null;
  rejected: { reason: string; repair?: string } | null;
}

/** The continuation object a read minted, if `cursor` carries one whole — as
 *  the JSON string or the parsed object. Only a read continuation with a bare
 *  cursor id counts; anything else is not unwrappable. */
function unwrapReadContinuation(cursor: unknown): Record<string, unknown> | null {
  let parsed: unknown = cursor;
  if (typeof cursor === 'string') {
    const t = cursor.trim();
    if (!t.startsWith('{')) return null;
    try {
      parsed = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const c = parsed as Record<string, unknown>;
  if (c['verb'] !== 'read' || typeof c['cursor'] !== 'string' || !/^[a-z]_\d+$/.test(c['cursor']))
    return null;
  return c;
}

function normalizeRequest(raw: Record<string, unknown>): Normalized {
  const req: Record<string, unknown> = { ...raw };
  let changed = false;
  let keyApplied: string | null = null;
  const present = (k: string): boolean => req[k] !== undefined && req[k] !== null;
  switch (req['verb']) {
    case 'read': {
      const cursor = req['cursor'];
      if (typeof cursor === 'object' && cursor !== null) {
        // An object cursor fails the type check with no repair; as its JSON it
        // reaches badCursor, whose repair is the literal continuation. A
        // coercion for the rejection path, not a normalization: nothing is
        // echoed as applied unless it unwraps below.
        req['cursor'] = JSON.stringify(cursor);
      }
      const cont = unwrapReadContinuation(cursor);
      if (cont !== null) {
        // The continuation IS the call the runtime emitted: its own keys win,
        // and a key it does not carry (a target on an overview continuation)
        // is kept from the outer call so badCursor can still judge the pair.
        for (const k of ['target', 'cursor', 'all'] as const) {
          if (cont[k] !== undefined && cont[k] !== null) req[k] = cont[k];
        }
        changed = true;
      }
      break;
    }
    case 'find': {
      const aliases = FIND_NAME_ALIASES.filter((k) => typeof req[k] === 'string');
      if (aliases.length === 0) break;
      const values = new Set<string>(aliases.map((k) => req[k] as string));
      if (present('name') && typeof req['name'] === 'string') values.add(req['name']);
      if (values.size > 1) {
        const shown = [...(present('name') ? ['name'] : []), ...aliases]
          .map((k) => `${k}: ${JSON.stringify(req[k])}`)
          .join(', ');
        return {
          req,
          applied: null,
          keyApplied: null,
          rejected: {
            reason: `find: ${shown} were given and differ — one filter, under name`,
            repair: '{"verb":"find","name":"<one of them>"}',
          },
        };
      }
      if (!present('name')) req['name'] = [...values][0];
      for (const k of aliases) delete req[k];
      changed = true;
      break;
    }
    case 'act': {
      if (!present('ref') && typeof req['target'] === 'string') {
        req['ref'] = req['target'];
        delete req['target'];
        changed = true;
      }
      if (req['action'] === 'key' && typeof req['value'] === 'string') {
        // Alias the main key only — the last '+' segment — so a chord keeps its
        // modifiers: Control+Return is Control+Enter.
        const parts = req['value'].split('+');
        const main = parts[parts.length - 1] ?? '';
        const alias = Object.hasOwn(KEY_ALIASES, main) ? KEY_ALIASES[main] : undefined;
        if (alias !== undefined) {
          parts[parts.length - 1] = alias;
          req['value'] = parts.join('+');
          keyApplied = alias;
          changed = true;
        }
      }
      break;
    }
    default:
      break;
  }
  if (!changed) return { req, applied: null, keyApplied: null, rejected: null };
  // The echo in the schema's own key order, so it reads as the canonical call.
  const applied: Record<string, unknown> = {};
  const order = [...(ACCEPTED_KEYS[String(req['verb'])] ?? []), ...Object.keys(req)];
  for (const k of order) if (req[k] !== undefined && req[k] !== null) applied[k] = req[k];
  return { req, applied, keyApplied, rejected: null };
}

function invalidArgs(req: VerbRequest): string | null {
  const r = req as unknown as Record<string, unknown>;
  const optStr = (k: string): boolean =>
    r[k] === undefined || r[k] === null || typeof r[k] === 'string';
  const optNum = (k: string): boolean =>
    r[k] === undefined || r[k] === null || typeof r[k] === 'number';
  switch (req.verb) {
    case 'read': {
      const all = r['all'],
        fields = r['fields'];
      return optStr('target') &&
        optStr('cursor') &&
        (all === undefined || all === null || typeof all === 'boolean') &&
        (fields === undefined || fields === null || typeof fields === 'boolean')
        ? null
        : 'read: target and cursor must be strings, all and fields booleans';
    }
    case 'find':
      return optStr('role') &&
        optStr('name') &&
        optStr('within') &&
        optStr('state') &&
        optStr('cursor') &&
        optNum('limit')
        ? null
        : 'find: role/name/within/state/cursor must be strings, limit a number';
    case 'act':
      if (!(
        typeof r['ref'] === 'string' &&
        (r['action'] === 'click' ||
          r['action'] === 'fill' ||
          r['action'] === 'select' ||
          r['action'] === 'type' ||
          r['action'] === 'key' ||
          r['action'] === 'upload' ||
          r['action'] === 'scroll' ||
          r['action'] === 'hover') &&
        optStr('value')
      )) {
        return 'act: ref must be a string, action one of click|fill|select|type|key|upload|scroll|hover, value a string';
      }
      // Shape only for `until`; the keys inside are act's own argument
      // validation (core/act.ts parseUntil), which answers with the corrected call.
      if (!(
        r['until'] === undefined ||
        r['until'] === null ||
        (typeof r['until'] === 'object' && !Array.isArray(r['until']))
      )) {
        return 'act: until must be an object — exactly one of text, gone, role, state, network';
      }
      // The declaration is closed too (core/expect.ts): a key it does not know
      // is named, never ignored — an expectation silently dropped would be
      // reported as held.
      return validateExpect(r['expect']);
    case 'navigate':
      if (typeof r['url'] !== 'string') return 'navigate: url must be a string';
      return r['force'] === undefined || r['force'] === null || typeof r['force'] === 'boolean'
        ? null
        : `navigate: force must be a boolean, got ${JSON.stringify(r['force'])}`;
    case 'finish': {
      // A rejection that lists three constraints and names none of them is a
      // dead end wearing a repair's clothes, and this verb is where that costs
      // most: it is the last call of the episode, so every wasted attempt is
      // This behavior was verified during testing.
      // finish rejections carrying the one sentence this replaces, from TWO
      // unrelated causes (an array `answer`, then a `status` of "SUCCESS"). The
      // caller read "answer must be a string" while holding a string, concluded
      // the fault was its evidence, and resent the same call three times with
      // different refs. It could not repair what the rejection would not name.
      // Same principle as find's `eliminatedBy`: say which constraint emptied
      // the result, and hand back the call that satisfies it.
      const shown = (v: unknown): string =>
        v === null
          ? 'null'
          : Array.isArray(v)
            ? `an array (${JSON.stringify(v).slice(0, 60)})`
            : typeof v === 'string'
              ? `the string ${JSON.stringify(v).slice(0, 40)}`
              : typeof v;
      if (typeof r['answer'] !== 'string') {
        return (
          `finish: answer must be a string, got ${shown(r['answer'])}. ` +
          'A structured answer travels JSON-ENCODED inside that string — ' +
          'answer: "[\\"first\\", \\"second\\"]", never answer: ["first", "second"].'
        );
      }
      if (
        !Array.isArray(r['evidenceRefs']) ||
        !(r['evidenceRefs'] as unknown[]).every((x) => typeof x === 'string')
      ) {
        return (
          `finish: evidenceRefs must be an array of ref strings, got ${shown(r['evidenceRefs'])}. ` +
          'It is never encoded — evidenceRefs: ["n_abc123", "n_def456"].'
        );
      }
      const status = r['status'];
      if (
        status !== undefined &&
        status !== null &&
        !(typeof status === 'string' && FINISH_STATUSES.has(status))
      ) {
        // The observed failure is CASE: the prompt's prose says SUCCESS because
        // that is the spelling of the agent RESPONSE's status, while this
        // argument's enum is lowercase. Two vocabularies, one word — so say the
        // received value back, which is what makes the difference visible.
        const hint =
          typeof status === 'string' && FINISH_STATUSES.has(status.toLowerCase())
            ? ` — this argument is lower-case: status: "${status.toLowerCase()}"`
            : '';
        return (
          `finish: status must be one of ${[...FINISH_STATUSES].map((x) => `"${x}"`).join(', ')} (or omitted), ` +
          `got ${shown(status)}${hint}.`
        );
      }
      return null;
    }
    default:
      return null; // unknown verb: the dispatch switch answers with its own repair
  }
}

export class WirSession {
  private graph: WirGraph | null = null;
  private observedRefs = new Set<string>();
  // WHICH DOCUMENT EACH REF WAS SEEN IN. observedRefs is deliberately flat and
  // never cleared — "you were shown this" stays true for the whole episode, and
  // that is right for citability. But it means a finish citing refs from a page
  // the browser left three navigations ago is indistinguishable from one citing
  // the page it is standing on. Refs are already epoch-derived at mint
  // (core/compiler.ts: sha1(`${epoch}:${backendId}`)), so this only records what
  // the ref already encodes. First observation wins; a ref re-delivered after a
  // document replacement is a different ref.
  private refEpoch = new Map<string, string>();
  /** Values this caller typed, newest last. Kept by VALUE rather than by ref on
   *  purpose: a search box usually resolves on submit, which replaces the
   *  document and mints new refs, so a ref-keyed ledger would lose exactly the
   *  case worth reporting. Bounded — only the last few matter. */
  private typedValues: { ref: string; value: string }[] = [];
  // Gate-eligible verified acts only — verdict 'verified' AND evidence outside
  // LOCAL_ONLY_EVIDENCE. The action and evidence travel with the ref so a
  // consumer can SHOW the model what it actually proved without reconstructing
  // the eligibility rule; a second copy of LOCAL_ONLY_EVIDENCE outside core
  // would be a drift bomb.
  private verifiedActs = new Map<string, GateEligibleAct>();
  // EVERY TEXT RUN THIS SESSION HAS DELIVERED, normalized by find's own rule
  // (NFKC, case-folded, whitespace-collapsed), as whole runs and as their
  // whitespace-split tokens — so "Email: emma.lopez@gmail.com" answers for
  // the address inside it. Fed by every string leaf of a find/read payload, an
  // act's landing overview and its receipt (the values the receipt printed
  // count as shown — the model read them). NOT fed by an act's effect block,
  // which echoes the caller's own input back. Bounded: past DELIVERED_BOUND
  // the count of dropped runs is kept so the flag says "not checked" rather
  // than "never shown" about a run it threw away.
  private delivered = new Set<string>();
  private deliveredDropped = 0;
  private deliveredBound = DELIVERED_BOUND;
  // What the caller TYPED (fill/type), by normalized value: whether the page
  // had shown it before the keystrokes (or the request instruction carried it),
  // and whether the control was a datum field — an <input>, holding a value
  // with no internal whitespace. A <textarea> or contenteditable is a prose
  // control the caller is meant to author into, and prose is never flagged.
  // `seen: null` records that the delivered ledger had already overflowed when
  // the value was typed, so the answer is unknown, not "no".
  private typedLedger = new Map<string, { seen: boolean | null; datum: boolean }>();
  private typedDropped = 0;
  // The request instruction, normalized, when the runner supplied one (agent/loop.ts
  // passes request.request.instruction). Used for exactly one thing: a typed value
  // the instruction carries was not "from nowhere". Never compared to an answer.
  private instruction: string | null = null;
  // Every continuation this session has minted, keyed by the call that takes it.
  private continuations = new Map<string, ContinuationOffer>();
  // The delivery record behind identity resume (core/read.ts, rankAndPage):
  // for every list continuation minted, keyed by epoch + the literal call,
  // the refs its chain has delivered so far. When the continuation is
  // consumed, the verb serves what is NOT in this record rather than an
  // offset into whatever the list has become — an offset skipped re-ranked
  // This behavior was verified during testing.
  // apart from `continuations` on purpose: that ledger is first-offer-wins
  // across epochs (its own owned defect, D3), and a delivery record must
  // never be pinned to a dead epoch by it. Unioned on re-mint: everything
  // delivered through ANY page of the chain was truly delivered.
  private chainServed = new Map<string, Set<string>>();
  // Every finish this episode had REJECTED, by request hash. A set, not a
  // last-seen slot: the slot caught only the tightest circle, because each
  // rejection overwrote the previous one's hash — a model alternating between
  // two bad finishes (A, B, A, B) never met itself, and the gate answered the
  // fifth identical mistake exactly as it answered the first. `finish` is the
  // worst repeat loop in the recorded corpus (708 episodes; one carried 11
  // finish rejections), and the agent's mid-episode repeat nudge excludes
  // `finish` precisely because this ledger is supposed to own it. Reproduced on
  // This behavior was verified during testing.
  // This behavior was verified during testing.
  // Never cleared, like observedRefs: "you already sent me this" stays true for
  // the whole episode. Rejections only — an accepted finish is not a circle.
  private rejectedFinishHashes = new Set<string>();
  private recompiledThisCall = false;
  // Dispatch ordinal, and the ordinal at which the site last served a document
  // (0: the runner's opening goto). The host owns the ledger; the session only
  // pins each served document to the call it arrived in.
  private calls = 0;
  private servedAtCall = 0;

  private constructor(
    readonly host: WirHost,
    readonly expectedAction: ExpectedAction,
    uploadDir: string | null = null,
  ) {
    // The HOST, not its page: the page behind the host changes when a navigation
    // lands in another declared origin's context, and the executor must settle
    // and read its after-state on the page that is actually in view.
    this.executor = new ActExecutor(host, () => host.drainBrowserEvents(), uploadDir, {
      // `until` judges text/gone/role over the SAME capture -> compile path a
      // read takes, not the session cache: the act has dispatched, so no cached
      // graph can vouch for the page, and doAct drops the cache afterwards anyway.
      compile: async () => compile(await host.captureFacts()),
      mutationToken: () => host.mutationToken(),
    });
    // Per tab on the host side; the session pins whichever document is in view
    // — a served arrival on the active tab, or a switch to another tab — to
    // the call it arrived in.
    host.onDocumentServed(() => {
      this.servedAtCall = this.calls;
    });
  }

  /** The served-versus-shown block every structural envelope carries. Read
   *  live, never from the graph: `shownUrl` is the address bar NOW. */
  private documentBlock(): DocumentBlock {
    const led = this.host.documentLedger();
    return {
      servedUrl: led.servedUrl,
      shownUrl: this.host.page.url(),
      callsSinceServed: this.calls - this.servedAtCall,
      routesSinceServed: led.routesSinceServed,
      lastRoute: led.lastRoute,
    };
  }
  private readonly executor: ActExecutor;

  static async start(opts: {
    headless: boolean;
    expectedAction: ExpectedAction;
    storageStatePath?: string | null;
    /** origin -> storage state path: each named origin gets its OWN browser
     *  context, seeded from its own capture (core/host.ts, Tab). Runner-declared
     *  like `uploadDir` and `knownUrls`. Absent = one context for everything,
     *  seeded from `storageStatePath`, which is what every run had before. */
    storageStates?: Readonly<Record<string, string>> | null;
    harPath?: string | null;
    tracePath?: string | null;
    debugScreenshots?: boolean;
    /** Debug plane: where to write the page's final rendered state on close.
     *  The one record of what the world BECAME, independent of what the agent
     *  chose to look at. Never reaches the model. */
    finalStatePath?: string | null;
    // Declared by the RUNNER, never by the model (core/act.ts resolveUpload).
    uploadDir?: string | null;
    /** URLs the request declares, seeded into the observed set so `navigate` can
     *  reach them. Declared by the runner, exactly like `uploadDir`, and for the
     *  same reason: a request may legitimately start in two places, and
     *  nothing on site A links to site B, so the closure that keeps the agent
     *  from inventing URLs also made 48 tasks impossible. Seeding what the request
     *  itself declares removes the wall without opening the door — the model
     *  still cannot reach anywhere it was not sent or shown. */
    knownUrls?: readonly string[];
    /** Which origins top-level navigation may reach. 'declared' (default) is the
     *  runner-named set; 'observed' additionally admits every origin the graph has
     *  shown this episode, which is what an open-web request starting from a search
     *  engine requires. Omitting knownUrls entirely leaves confinement OFF. */
    originPolicy?: 'declared' | 'observed';
    /** The request's instruction text, declared by the runner like `knownUrls`.
     *  Feeds the unseen-value ledger only (a typed value the instruction
     *  carries was given to the caller, not invented). Absent = every typed
     *  value is judged against delivered text alone. */
    instruction?: string | null;
    /** The delivered-text ledger's bound, default DELIVERED_BOUND. A debug-plane
     *  knob: the regression test reaches the "not checked" path with it, and
     *  nothing else sets it. Disclosed wherever it binds (unseenUnchecked). */
    deliveredBound?: number;
  }): Promise<WirSession> {
    // CONFINEMENT IS A RUNNER POLICY, and it must be stated rather than inferred
    // from whether knownUrls happened to be populated.
    //
    // Two deployments need opposite answers and neither is wrong:
    //   'declared' — only origins the runner named. Confined tasks need this:
    //     following a link shown by the graph must not grant access to every
    //     third-party origin reachable from that link.
    //   'observed' — any origin the graph has shown this episode. The open web
    //     needs this: a request that names no URL starts at a search engine and its
    //     destinations cannot be enumerated in advance.
    //
    // Leaving it implicit produced a silent fatal failure on the live web
    // This behavior was verified during testing.
    // admitted it, and the host aborted it with ERR_BLOCKED_BY_CLIENT because the
    // origin was not in the start-time set. Two closures over the same question,
    // disagreeing — the verb said yes, the host said no, and the episode died.
    // Reproduced in test/origin-confinement.test.ts.
    const policy = opts.originPolicy ?? 'declared';
    // Bound after construction; the route closure only ever runs after start()
    // returns, so the late binding is safe and keeps the two objects decoupled.
    const sessionRef: { current?: WirSession } = {};
    const origins: string[] = [];
    for (const u of opts.knownUrls ?? []) {
      try {
        origins.push(new URL(u).origin);
      } catch {
        /* not a URL */
      }
    }
    const host = await WirHost.launch({
      headless: opts.headless,
      storageStatePath: opts.storageStatePath ?? null,
      storageStates: opts.storageStates ?? null,
      harPath: opts.harPath ?? null,
      tracePath: opts.tracePath ?? null,
      debugScreenshots: opts.debugScreenshots === true,
      allowedOrigins: origins,
      // Under 'observed' the host asks the session, so the two closures are the
      // same question answered once. Under 'declared' it stays a fixed set.
      ...(policy === 'observed'
        ? { originAdmits: (o: string) => sessionRef.current?.admitsOrigin(o) === true }
        : {}),
    });
    host.finalStatePath = opts.finalStatePath ?? null;
    const session = new WirSession(host, opts.expectedAction, opts.uploadDir ?? null);
    sessionRef.current = session;
    for (const u of opts.knownUrls ?? []) session.noteUrl(u);
    session.noteInstruction(opts.instruction ?? null);
    if (opts.deliveredBound !== undefined) session.deliveredBound = opts.deliveredBound;
    return session;
  }

  // Bring-your-own-browser entry points: same session, same dispatch path.
  static async attach(opts: {
    cdpEndpoint: string;
    expectedAction: ExpectedAction;
  }): Promise<WirSession> {
    return new WirSession(
      await WirHost.attach({ cdpEndpoint: opts.cdpEndpoint }),
      opts.expectedAction,
    );
  }

  static async fromPage(
    page: import('playwright').Page,
    opts: { expectedAction: ExpectedAction },
  ): Promise<WirSession> {
    const session = new WirSession(await WirHost.fromPage(page), opts.expectedAction);
    // The page may already be somewhere; its URL is episode-observed by definition.
    session.noteUrl(page.url());
    return session;
  }

  async goto(url: string): Promise<void> {
    // Seed BEFORE moving. This entry point is the RUNNER's navigation — the same
    // authority that declares knownUrls and uploadDir — so the URL it names is
    // observed by definition. Under originPolicy 'observed' the route filter reads
    // seenOrigins, which is empty at session start, so seeding afterwards made the
    // FIRST navigation of an open-web episode block itself: nothing can be visited
    // until it is observed, and nothing is observed until it is visited. Caught by
    // hand-driving a live request, on the first call.
    this.noteUrl(url);
    await this.host.goto(url);
    // The graph and the mutation reading it was compiled against always move
    // together; a token outliving its graph is the shape a false vouch would take.
    this.graph = null;
    this.graphToken = null;
    this.noteUrl(this.host.page.url());
  }

  async close(): Promise<void> {
    await this.host.close();
  }
  currentEpoch(): string {
    return this.host.currentEpoch();
  }

  // navigate is closed to URLs this episode has already seen: pages visited plus
  // This behavior was verified during testing.
  // external site with no way back) — never an arbitrary-URL escape hatch.
  private seenUrls = new Set<string>();
  private seenOrigins = new Set<string>();
  // The exact addresses shown — origin + path + query, fragment dropped — beside
  // the path closure above. A path can be known while THIS address is one the
  // model composed; the two sets tell those apart.
  private seenAddresses = new Set<string>();
  private noteUrl(u: string | null): void {
    if (!u) return;
    try {
      const p = new URL(u);
      this.seenUrls.add(p.origin + p.pathname.replace(/\/+$/, ''));
      this.seenAddresses.add(addressKey(u));
      this.seenOrigins.add(p.origin);
    } catch {
      /* not a URL */
    }
  }

  /** The addresses a receipt showed are observed. The receipt discloses the
   *  page's own requests to the model — `receipt.requests[].url`, method and
   *  query included — so a `navigate` to one of them refused as "never
   *  observed" is the closure contradicting what the runtime just printed.
   *  Same origin as the document that made the request, any method: the
   *  address was shown either way. Proven on a live admin grid
   * This behavior was verified during testing.
   *  wt-navigate-observed.md): a status filter fetched the filtered list as
   *  an XHR, the receipt showed the address, and the only way to make it the
   *  last DOCUMENT the browser loaded — what a navigation request is graded on
   *  — was refused. Cross-origin addresses in a receipt (a CDN, an analytics
   *  beacon) stay out: the closure is on the site's own words. */
  private noteShownRequests(receipt: unknown, documentUrls: readonly (string | null)[]): void {
    const origins = new Set<string>();
    for (const u of documentUrls) {
      if (u) {
        try {
          origins.add(new URL(u).origin);
        } catch {
          /* not a URL */
        }
      }
    }
    const reqs = (receipt as { requests?: Array<{ url?: unknown }> } | undefined)?.requests ?? [];
    for (const r of reqs) {
      if (typeof r.url !== 'string') continue;
      try {
        if (origins.has(new URL(r.url).origin)) this.noteUrl(r.url);
      } catch {
        /* not a URL */
      }
    }
  }

  /** Under `originPolicy: 'observed'`, the host asks THIS — the same set the
   *  `navigate` closure is built from — so the verb and the route filter cannot
   *  disagree about whether an origin is reachable. They did once, and the episode
   *  died of it rather than being told no. */
  admitsOrigin(origin: string): boolean {
    return this.seenOrigins.has(origin);
  }

  private async doNavigate(
    req: Extract<VerbRequest, { verb: 'navigate' }>,
  ): Promise<Record<string, unknown>> {
    if (!req.url || typeof req.url !== 'string') {
      return reject(
        'invalid_args',
        'navigate needs url',
        '{"verb":"navigate","url":"<a URL this episode has already seen>"}',
      );
    }
    let key: string;
    try {
      const p = new URL(req.url);
      key = p.origin + p.pathname.replace(/\/+$/, '');
    } catch {
      return reject('invalid_args', `not a URL: ${req.url.slice(0, 80)}`);
    }
    if (!this.seenUrls.has(key)) {
      return reject(
        'invalid_args',
        'navigate is limited to URLs already observed this episode (visited pages, links the graph has shown, and requests the receipts have shown)',
        '{"verb":"read"} — links on the current page are navigable via act click',
      );
    }
    // SERVED VERSUS SHOWN. Navigating to the address the bar already shows,
    // while that address is one the site never served (a client-side route:
    // the page fetched in the background and wrote the address itself), loads
    // a document the site then records as the last one served — replacing the
    // page that actually was. Ten map episodes (356, 757-767) reached the
    // graded page and lost it on exactly this move, reproduced by hand on the
    // This behavior was verified during testing.
    // a navigate to the shown address). Fragments are ignored on both sides: a
    // hash never reaches the server, and a goto differing only by hash is a
    // same-document move that loads nothing. Refused with both repairs stated;
    // force:true is the model's call, because only it knows whether the request
    // wants the shown page SERVED or the served page KEPT.
    const block = this.documentBlock();
    const clientSideRoute = !sameAddress(block.shownUrl, block.servedUrl);
    let addressShown = true;
    try {
      addressShown = this.seenAddresses.has(addressKey(req.url));
    } catch {
      /* validated above */
    }
    // A CONSTRUCTED ADDRESS ON A CLIENT-SIDE ROUTE. The path is known, the query
    // is the model's own composition, and the page it stands on was routed by
    // the site in the background: loading the invention now makes IT the last
    // document served. Refused with the page's own controls as the repair;
    // force:true remains the model's call. On a server-rendered page the same
    // move is admitted — 25 corpus passes depended on it — and disclosed below.
    if (
      req.force !== true &&
      !addressShown &&
      clientSideRoute &&
      (() => {
        try {
          return new URL(req.url).search !== '';
        } catch {
          return false;
        }
      })()
    ) {
      return {
        ...reject(
          'navigate_constructed_address',
          `${req.url} was never shown this episode — its path was, its query string is your own — ` +
            `and the page you are on is a client-side route (served ${block.servedUrl}, shown ${block.shownUrl}, ` +
            `${block.routesSinceServed} route change(s) since). Loading a composed address here makes it ` +
            'the last document the site served.',
          // THE REPAIR NAMES THE PAGE'S CONTROLS, NOT THE OVERRIDE. Measured on
          // This behavior was verified during testing.
          // forced call, the model re-sent it on the very next turn, 2 of 2, and
          // lost the page both times. A small model reads a literal next call as
          // THE next call. The override still exists; it is described, not handed
          // over pre-formed.
          '{"verb":"read"} — the page\'s own controls (a search box, a form, a link) reach this ' +
            'state without a load and keep the served page. An override (force) exists; using it ' +
            'makes the composed address the last document the site served, which is usually the ' +
            'thing a navigation request is graded on.',
        ),
        document: block,
      };
    }
    // A RELOAD OF THE SERVED ADDRESS. The mirror of the guard below: the model
    // asks for the address the site DID serve while the bar shows a state the
    // This behavior was verified during testing.
    // arm 2): served "/", shown "/directions?engine=…&route=…", six routes

    // the load discarded the directions state and the model rebuilt the
    // address by hand. Same loss as the guard below, opposite address:
    // refused, with what would be lost stated; force:true does it anyway.
    // A reload with nothing routed (shown == served) stays admitted.
    if (req.force !== true && clientSideRoute && sameAddress(req.url, block.servedUrl)) {
      return {
        ...reject(
          'navigate_would_discard_shown_state',
          `${req.url} is the document already served here; what is shown now (${block.shownUrl}) ` +
            `was reached without a load and a load would discard it (${block.routesSinceServed} ` +
            'route change(s) since it was served).',
          '{"verb":"read"} — if what the request asked for is on the page, stay and finish; the ' +
            "page's own controls change this state without a load. An override (force) exists " +
            "for the case where the served page's initial state is what the request needs.",
        ),
        document: block,
      };
    }
    // ANY OTHER ADDRESS. The guards above name the served address and a
    // composed query; this one first named only the shown address — so a load
    // This behavior was verified during testing.
    // This behavior was verified during testing.
    // served "/", shown "/node/2500233823", seven routes since, and `navigate

    // closure as a link's href, no query — was admitted with
    // replaced.clientSideRoute:true; reproduced on the live map by

    // address is asked for: any load while a client-side route is shown
    // replaces the served document and discards the shown state. So the guard
    // keys on the condition — shown != served, no force — not on the address.
    // The reason still says which address it is; the shown address keeps its
    // original wording.
    if (req.force !== true && clientSideRoute) {
      const isShown = sameAddress(req.url, block.shownUrl);
      return {
        ...reject(
          'navigate_would_replace_served_document',
          (isShown
            ? `${req.url} is the address already shown, and the site never served a document for it: `
            : `${req.url} is a load while what is shown (${block.shownUrl}) was reached without one, ` +
              'and the site never served a document for that: ') +
            `the last document the site served is ${block.servedUrl}; the address moved ` +
            `${block.routesSinceServed} time(s) since, client-side (${block.lastRoute ?? 'unobserved'}). ` +
            (isShown
              ? 'Loading it now makes it the last document the site served, replacing that record.'
              : 'Loading it now makes it the last document the site served, replacing that record, ' +
                'and discards what is shown.'),
          isShown
            ? 'if what the request asked for is on the page, stay and finish — a load here replaces the ' +
                'served page as the last thing the site served. An override (force) exists for the case ' +
                'where the request needs this address SERVED, not merely shown.'
            : 'if what the request asked for is on the page, stay and finish — a load here replaces the ' +
                'served page as the last thing the site served. If the request needs that address, reach it ' +
                "through the page's own control for it (a link, a form) via act, so the site serves it " +
                'from here. An override (force) exists for the case where the request needs that address ' +
                'loaded now, whatever this page recorded.',
        ),
        document: block,
      };
    }
    try {
      await this.goto(req.url);
    } catch (error) {
      // A navigation that fails is ordinary and recoverable; killing the episode
      // for it converts a site hiccup into a guaranteed zero. Playwright's message
      // carries the Chromium code (net::ERR_BLOCKED_BY_CLIENT, ERR_NAME_NOT_RESOLVED,
      // ERR_CONNECTION_REFUSED, ERR_UNSAFE_PORT), so pass it through — the model can
      // tell "that host refused me" from "that name does not exist" and route
      // accordingly.
      //
      // DO NOT claim the page stayed put. It usually has not: a failed goto commonly
      // leaves Chromium on its own error document, and the first draft of this repair
      // said "the page has not moved and your refs are still valid" while the probe
      // showed chrome-error://chromewebdata/. Because host.goto threw, session.goto
      // never reached its own graph-drop either — so the cached graph would have been
      // served, still vouched, for a document that no longer exists. Drop it here and
      // report where the browser actually is.
      this.graph = null;
      this.graphToken = null;
      const detail = (String(error).split('\n')[0] ?? '').replace(/^Error:\s*/, '').slice(0, 200);
      // Nor name the URL it landed on. `page.url()` here still reports the OLD
      // document — Chromium commits its error page after the throw — so a URL read
      // in this catch block is stale by the time the model sees it. Measured: the
      // repair said `file:
      // chrome-error://chromewebdata/. The only honest statement is that the
      // browser's position is now UNKNOWN and one read settles it.
      return reject(
        'navigation_failed',
        `navigation to ${req.url} did not complete: ${detail}`,
        '{"verb":"read"} — this may have left the browser on an error page, so read ' +
          'first to see where you are, then try another route (a link or search ' +
          'result you have already seen)',
      );
    }
    // `dirty`, not `live`: goto() dropped the graph, so no compiled projection
    // stands behind this response. The next find/read recompiles.
    // WHAT THIS LOAD REPLACED. The block as it stood before goto, plus the two
    // facts the refusals above weigh: was the page a client-side route, and had
    // this exact address ever been shown. Carried on every success — including
    // the forced ones — so a load that overwrote a served page is visible to
    // the model even when the runtime had no grounds to refuse it.
    const replaced: ReplacedBlock = { ...block, clientSideRoute, addressShown };
    return {
      documentEpoch: this.host.currentEpoch(),
      freshness: 'dirty' as const,
      coverageIncomplete: false,
      navigated: true,
      url: this.host.page.url(),
      document: this.documentBlock(),
      replaced,
    };
  }

  // The mutation-stream reading taken immediately before the cached graph was
  // compiled. null means "no evidence" — never "unchanged".
  private graphToken: string | null = null;

  private async ensureGraph(): Promise<WirGraph> {
    const epoch = this.host.currentEpoch();
    // Read BEFORE the capture, always. A reading taken afterwards would swallow
    // every mutation that landed during the capture; taken before, such a mutation
    // costs one extra recompile next call and can never cost a stale result.
    // Read the token over the frames the CACHED graph holds: those are the
    // documents whose content we would be re-serving.
    const token = await this.host.mutationToken(this.graph?.contributingFrames ?? []);
    // The cache is served only against positive evidence that the document has not
    // This behavior was verified during testing.
    // the epoch alone was the key, so a page that grew 20 -> 40 links without a
    // navigation and without an act was re-served at 20 and stamped `live` — the
    // runtime saw it and did not show it.
    const vouched =
      this.graph !== null &&
      this.graph.epoch === epoch &&
      this.graph.mutationObservable && // nothing compiled beyond the observer's reach
      token !== null &&
      token === this.graphToken;
    if (vouched) {
      this.recompiledThisCall = false;
      return this.graph!;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const facts = await this.host.captureFacts();
        this.graph = compile(facts);
        this.graphToken = token;
        this.recompiledThisCall = true;
        this.noteUrl(this.graph.url);
        for (const n of this.graph.nodes.values()) this.noteUrl(n.href);
        return this.graph;
      } catch (e) {
        if (e instanceof EpochChangedError && attempt < 3) continue;
        throw e;
      }
    }
  }

  private envelope(g: WirGraph, withheld: NonNullable<Envelope['withheld']> | null): Envelope {
    const env: Envelope = {
      documentEpoch: g.epoch,
      freshness: this.recompiledThisCall ? 'recompiled' : 'live',
      coverageIncomplete: !g.coverage.complete,
      url: g.url,
      document: this.documentBlock(),
    };
    if (!g.coverage.complete) {
      env.gaps = g.coverage.gaps.map((gap) => ({
        ...gap,
        // Frames ARE compiled now, so a gap no longer means "this is a frame" —
        // it means this document held elements and none of them reached the
        // graph, which is what an out-of-process (cross-origin) frame looks like
        // from here. Saying "not compiled in v1" would now be false, and a gap
        // the caller misreads is worse than one it cannot act on.
        reason:
          'frame document this session cannot reach (its own process); ' +
          'its content is not available through find/read',
      }));
    }
    if (withheld) env.withheld = withheld;
    // What the page did with what you typed. Normalized substring, the same
    // comparison find already uses on the page's own words — never fuzzy, never
    // learned. A control that now holds MORE than you typed has resolved your
    // text to something specific, and that something is frequently not what you
    // meant.
    const norm = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, ' ');
    // SHARED WORDS, NOT CONTAINMENT. Requiring the resolved value to CONTAIN the
    // typed text misses the case that matters most: the site did not echo your
    // This behavior was verified during testing.
    // "AMC Waterfront" and "Univ of Pittsburgh", and only the first was
    // reported, because "University of Pittsburgh, ..." does not contain
    // "Univ of Pittsburgh". The episode then routed from the wrong endpoint and
    // lost. A shared word of four or more characters is deterministic, is drawn
    // from the caller's own text, and catches an expansion as readily as a
    // suffix.
    const words = (v: string): string[] =>
      norm(v)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4);
    const resolved: { youTyped: string; nowReads: string }[] = [];
    const already = new Set<string>();
    // ATTRIBUTED TO THE FIELD THE CALLER WROTE, not to any field sharing a word
    // with something typed earlier. The pairing used to run over every node
    // against every remembered string, so on a page with two endpoint fields
    // "Carnegie Mellon University" typed into ONE of them was reported as having
    // resolved to the OTHER's "Chatham University, North Woodland Road" — the
    // shared word was "university" and nothing else was required. It survived
    // document replacement too, so it could pair across two documents. A false
    // signal here is the attempt-6 failure mode: the caller reads it as proof
    // that an endpoint geocoded and routes from the wrong one.
    for (const [nodeRef, n] of g.nodes.entries()) {
      const v = n.value;
      if (typeof v !== 'string' || v === '') continue;
      // ONLY the newest write to this field, and if it does not qualify the field
      // reports NOTHING. Two rounds of this were wrong. Iterating oldest-first
      // This behavior was verified during testing.
      // but CONTINUING past a non-qualifying newest value fell through to older
      // ones — and the commonest non-qualifying case is the field echoing exactly
      // what you last typed (nv === nt), which is what a settled geocode looks
      // This behavior was verified during testing.
      // that had raised a not-found alert and bound nothing, two turns earlier —
      // as having resolved to the Centre Avenue address. A field's current value
      // can only be a resolution of the LAST thing written to it.
      let typed: string | null = null;
      for (let i = this.typedValues.length - 1; i >= 0; i -= 1) {
        const e = this.typedValues[i]!;
        if (e.ref === nodeRef) {
          typed = e.value;
          break;
        }
      }
      if (typed === null || typed === '' || already.has(typed)) continue;
      {
        const nv = norm(v),
          nt = norm(typed);
        if (nv === nt || nv.length <= nt.length) continue;
        const tw = words(typed);
        if (tw.length === 0) continue;
        const vw = new Set(words(v));
        if (!tw.some((w) => vw.has(w))) continue;
        already.add(typed);
        resolved.push({ youTyped: typed.slice(0, 80), nowReads: v.slice(0, 160) });
      }
      if (resolved.length >= 3) break;
    }
    if (resolved.length > 0) env.resolvedDifferently = resolved;
    return env;
  }

  // Every ref the model has been shown becomes citable evidence.
  private recordObserved(payload: unknown): void {
    const walk = (v: unknown): void => {
      if (typeof v === 'string') {
        // ROOT_REF is synthetic and matches no digest shape, so the digest regex
        // below can never admit it. It reaches a model through find({role:
        // "document"}) and as the parent of a read subtree — never through the
        // overview, contrary to what this comment used to claim — and a ref the
        // runtime hands out must always be citable.
        if (v === ROOT_REF || /^n_[0-9a-f]{12,40}$/.test(v) || /^a_\d+$/.test(v)) {
          this.observedRefs.add(v);
          if (!this.refEpoch.has(v)) this.refEpoch.set(v, this.host.currentEpoch());
        }
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(payload);
  }

  // The ledger of pagination the caller was offered and never called back. It
  // feeds the finish confrontation, so every entry is a claim that the runtime
  // is HOLDING CONTENT THE CALLER HAS NOT READ. An entry that is not that is
  // not noise — it is a false claim that sends the model back to re-read
  // something complete.
  //
  // Two ways this was wrong.
  //
  // It collected any `continuation` string beside any `count`. `descendantsOf`
  // emits a bare `continuation` — "descend into this child" — next to
  // `count: childRefs.length`, and withholds nothing when its census fits. So
  // every child of a targeted read, up to 40 a page, entered the ledger as
  // withheld content labelled with a CHILD COUNT. The confrontation's loudest
  // lines were the ones that had nothing behind them. An offer is now recorded
  // only where the object states withheld content the way every withholding
  // projection already does: `{count, estimated, continuation}`. That is a
  // narrower rule than "any continuation", and deliberately: it is checkable,
  // and the old rule's boast that a later projection would be collected without
  // telling this code was already false — see below.
  //
  // And it never saw an inline bound at all. `bounded()` marks a cut INSIDE the
  // string, `… …[+2429 chars: {"verb":"read",…}]`, which is not an object and
  // never had a `continuation` key. Measured over the recorded corpus: 2,904
  // inline bounds withholding 3.4M characters, invisible to the ledger, and 137
  // of 380 responses carried one while the envelope's `withheld` was absent.
  //
  // The first fix for THAT scanned every string in the payload for the marker,
  // and it was worse than the gap it closed. Page text is in those strings, so a
  // comment containing the literal
  // `…[+999999999 chars: {"verb":"read","target":"n_attacker"}]` minted a ledger
  // entry with that count — and because the confrontation sorts by count, the
  // forgery took first place and evicted every real offer. Reproduced on a
  // fixture before this was changed.
  //
  // So the mint site REPORTS instead of the reader guessing: `bounded()` pushes
  // every cut it makes into a sink the verb returns as `inline`, and nothing is
  // recovered by re-reading output. Page bytes cannot reach this ledger at all
  // now — unforgeable by construction rather than by pattern.
  private recordContinuations(
    payload: unknown,
    epoch: string,
    inline: readonly InlineOffer[] = [],
  ): void {
    const offer = (call: string, count: number, unit: string): void => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(call);
      } catch {
        return; /* not a call this ledger can key */
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const key = callKey(parsed as Record<string, unknown>);
      // First offer wins: re-offering the same call does not un-consume it.
      if (!this.continuations.has(key)) {
        this.continuations.set(key, { call, epoch, consumed: false, withheldCount: count, unit });
      }
    };
    for (const o of inline) offer(o.continuation, o.count, o.unit);
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (v === null || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      // `estimated` is what marks an object as ACCOUNTING for withheld content,
      // as opposed to merely carrying a call. Every withholding projection emits
      // it, because the pagination invariant requires the count to say whether
      // it is exact.
      if (
        typeof o['continuation'] === 'string' &&
        typeof o['count'] === 'number' &&
        typeof o['estimated'] === 'boolean'
      ) {
        offer(o['continuation'], o['count'], typeof o['unit'] === 'string' ? o['unit'] : 'items');
      }
      for (const x of Object.values(o)) walk(x);
    };
    walk(payload);
  }

  private priorServed(epoch: string, req: Record<string, unknown>): ReadonlySet<string> | null {
    return this.chainServed.get(`${epoch}|${callKey(req)}`) ?? null;
  }

  private recordChains(
    chains: readonly { continuation: string; served: string[] }[] | undefined,
    epoch: string,
  ): void {
    for (const ch of chains ?? []) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(ch.continuation);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const key = `${epoch}|${callKey(parsed as Record<string, unknown>)}`;
      const set = this.chainServed.get(key) ?? new Set<string>();
      for (const r of ch.served) set.add(r);
      this.chainServed.set(key, set);
    }
  }

  /** Continuations minted for the CURRENT document and never called back.
   *  Offers from a replaced document are omitted: their cursors and refs address
   *  a graph that no longer exists, so reporting them would advertise calls that
   *  reject — the same false promise a coverage gap is forbidden to make.
   *  Read-only: showing the caller what it never opened is information, never
   *  authority (same rule as gateEligibleActs). */
  unconsumedContinuations(): readonly ContinuationOffer[] {
    const epoch = this.host.currentEpoch();
    return [...this.continuations.values()].filter((o) => !o.consumed && o.epoch === epoch);
  }

  recordVerifiedAct(act: GateEligibleAct): void {
    this.verifiedActs.set(act.actRef, act);
  }

  /** The runner's instruction text, normalized by find's rule. Public so a
   *  session attached to an existing page can still be told it. */
  noteInstruction(text: string | null): void {
    this.instruction = text === null || text.trim() === '' ? null : normalize(text);
  }

  /** How the delivered-text ledger stands: distinct runs held, runs dropped
   *  past the bound, values typed, typed values dropped. A debug-plane fact. */
  deliveredTextLedger(): { runs: number; dropped: number; typed: number; typedDropped: number } {
    return {
      runs: this.delivered.size,
      dropped: this.deliveredDropped,
      typed: this.typedLedger.size,
      typedDropped: this.typedDropped,
    };
  }

  /** Every string leaf of a payload the session is about to deliver, into the
   *  delivered ledger — whole run and whitespace tokens, punctuation-trimmed
   *  variants included, each at least UNSEEN_MIN_LENGTH after normalization.
   *  Refs, URLs and continuation JSON land in the set too; over-inclusion only
   *  makes the flag more conservative, never less true. */
  private noteDelivered(payload: unknown): void {
    const add = (n: string): void => {
      if (n.length < UNSEEN_MIN_LENGTH || this.delivered.has(n)) return;
      if (this.delivered.size >= this.deliveredBound) {
        this.deliveredDropped += 1;
        return;
      }
      this.delivered.add(n);
    };
    const walk = (v: unknown): void => {
      if (typeof v === 'string') {
        const n = normalize(v);
        add(n);
        if (n.includes(' ')) {
          for (const tok of n.split(' ')) {
            add(tok);
            add(tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
          }
        } else {
          add(n.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
        }
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(payload);
  }

  /** Whether the delivered ledger or the instruction holds this normalized
   *  value now; null when the ledger has dropped runs, so absence proves
   *  nothing. */
  private shownSoFar(n: string): boolean | null {
    if (this.delivered.has(n)) return true;
    if (this.instruction !== null && this.instruction.includes(n)) return true;
    return this.deliveredDropped > 0 ? null : false;
  }

  /** Record a value the caller typed into `node`, with what the page had
   *  shown BEFORE the keystrokes. Called before the act's own response is
   *  ledgered, so a fill's echo of its own value never counts as the page
   *  showing it. First typing wins: a value re-typed later was shown by then
   *  only if it was shown by then. */
  private noteTyped(value: string, node: { tag: string } | undefined): void {
    const n = normalize(value);
    if (n.length < UNSEEN_MIN_LENGTH || this.typedLedger.has(n)) return;
    if (this.typedLedger.size >= TYPED_BOUND) {
      this.typedDropped += 1;
      return;
    }
    this.typedLedger.set(n, {
      seen: this.shownSoFar(n),
      datum: node?.tag === 'input' && !n.includes(' '),
    });
  }

  /** The unseen block for one act: the sent fields of its receipt's first
   *  non-GET request (the FULL ledger page, not the bounded projection), each
   *  value that the caller typed into a datum field and the page had not shown
   *  first. Mechanical on both ends: "you typed it" is the typed ledger,
   *  "the page showed it" is the delivered ledger. Values the runtime itself
   *  put on the wire — a select option's own value, a hidden field, a token —
   *  match nothing the caller typed and are never flagged. */
  private unseenSent(actRef: string): { unseen?: string[]; unseenUnchecked?: string } {
    const page = this.executor.receiptPage(actRef, null);
    if (page === null || 'rejected' in page) return {};
    const rc = (page.payload as { receipt?: { requests?: Array<Record<string, unknown>> } })
      .receipt;
    const reqs = rc?.requests ?? [];
    const r = reqs.find((q) => typeof q['method'] === 'string' && q['method'] !== 'GET') ?? reqs[0];
    const fields = (r?.['body'] as { fields?: Record<string, unknown> } | undefined)?.fields;
    if (fields === undefined) return {};
    const unseen: string[] = [];
    let more = 0;
    const unchecked: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (SECRET_FIELD.test(k)) continue;
      const raw = String(v);
      const n = normalize(raw);
      if (n.length < UNSEEN_MIN_LENGTH) continue;
      const typed = this.typedLedger.get(n);
      if (typed === undefined) {
        // Not a value this caller typed — unless the typed ledger dropped it.
        if (this.typedDropped > 0 && this.shownSoFar(n) !== true) unchecked.push(k);
        continue;
      }
      if (!typed.datum || typed.seen === true) continue;
      if (typed.seen === null) {
        unchecked.push(k);
        continue;
      }
      if (unseen.length >= UNSEEN_SHOWN) {
        more += 1;
        continue;
      }
      unseen.push(`${k}=${raw}`);
    }
    if (more > 0) unseen.push(`(+${more} more)`);
    return {
      ...(unseen.length > 0 ? { unseen } : {}),
      ...(unchecked.length > 0
        ? {
            unseenUnchecked: `not checked for ${unchecked.join(', ')}: the delivered-text ledger dropped ${this.deliveredDropped} runs past its ${this.deliveredBound}-run bound and the typed ledger ${this.typedDropped} values past ${TYPED_BOUND}`,
          }
        : {}),
    };
  }

  /** The ledger the MUTATE finish gate will accept, in the order it was earned.
   *  Read-only: showing the model what it proved is information, never authority. */
  gateEligibleActs(): readonly GateEligibleAct[] {
    return [...this.verifiedActs.values()];
  }

  async dispatch(raw: VerbRequest): Promise<Record<string, unknown>> {
    this.calls += 1;
    // Generosity first, so a rewritten alias is judged by the same type and
    // key checks as the canonical spelling (normalizeRequest, above).
    const norm = normalizeRequest(raw as unknown as Record<string, unknown>);
    if (norm.rejected !== null)
      return reject('invalid_args', norm.rejected.reason, norm.rejected.repair);
    const req = norm.req as unknown as VerbRequest;
    const out = await this.dispatchNormalized(req);
    if (norm.applied === null) return out;
    if (norm.keyApplied !== null && typeof out['effect'] === 'object' && out['effect'] !== null) {
      out['effect'] = { ...(out['effect'] as Record<string, unknown>), key: norm.keyApplied };
    }
    return { ...out, applied: norm.applied };
  }

  private async dispatchNormalized(req: VerbRequest): Promise<Record<string, unknown>> {
    // Typed argument validation at the one dispatch path (review finding A1):
    // a malformed request — answer: 42, evidenceRefs: "n_abc" — used to throw a
    // raw TypeError deep in a verb, which the agent surfaced as browser_error
    // and the runner then EXCLUDED: a pure model mistake laundered out of the
    // denominator. A rejection goes back to the model; an exception kills the
    // episode. Never the latter for bad input.
    const invalid = invalidArgs(req);
    if (invalid !== null) return reject('invalid_args', invalid);
    // Unknown keys are their own rejection, after the type check: a key the
    // schema closed out is not a type error on a key it accepts, and the
    // repair here can steer (ref -> target, ref -> within) where the type
    // message cannot.
    const stray = unknownKeys(req);
    if (stray !== null) return reject('invalid_args', stray.reason, stray.repair);
    // A continuation is the literal next call; when that call arrives, the offer
    // was taken. Marked before dispatch so a rejected or empty page still counts
    // as asked-for — the ledger records what the caller reached for, not what it
    // got back.
    if (req.verb === 'read' || req.verb === 'find') {
      const offer = this.continuations.get(callKey(req as unknown as Record<string, unknown>));
      if (offer) offer.consumed = true;
    }
    switch (req.verb) {
      case 'read':
        return this.doRead(req);
      case 'find':
        return this.doFind(req);
      case 'act':
        return this.doAct(req);
      case 'navigate':
        return this.doNavigate(req);
      case 'finish':
        return this.doFinish(req);
      default:
        return reject(
          'invalid_args',
          `unknown verb ${(req as { verb?: string }).verb ?? '(none)'}`,
          'verbs: read | find | act | navigate | finish',
        );
    }
  }

  private queryHash(req: object): string {
    return createHash('sha1').update(JSON.stringify(req)).digest('hex');
  }

  private async doRead(
    req: Extract<VerbRequest, { verb: 'read' }>,
  ): Promise<Record<string, unknown>> {
    const g = await this.ensureGraph();
    // An actRef as target reads that act's RECEIPT — the continuation every
    // bounded receipt offers (core/receipt.ts). Checked before the node-cursor
    // shape below, whose `t_`/`c_` grammar an actRef never minted.
    if (req.target !== undefined && req.target !== null && /^a_\d+$/.test(req.target)) {
      const page = this.executor.receiptPage(req.target, req.cursor ?? null);
      if (page === null) {
        return reject(
          'unknown_ref',
          `no act ${req.target} was performed this episode, so there is no receipt to read`,
          '{"verb":"read"} for the page overview',
        );
      }
      if ('rejected' in page)
        return reject('invalid_args', page.rejected.reason, page.rejected.repair);
      // A receipt page shows its addresses exactly as the act result showed its
      // first six; both feed the navigate closure.
      this.noteShownRequests(page.payload['receipt'], [
        this.executor.receiptDocumentUrl(req.target),
      ]);
      this.noteDelivered(page.payload);
      const out = { ...this.envelope(g, page.withheld), ...page.payload };
      this.recordContinuations(out, g.epoch);
      return out;
    }
    // Cursor shape first: a cursor no list of this call mints must reject with
    // the list's own valid continuation, not silently re-serve page 1
    // (badCursor, core/read.ts). An unknown target falls through to its own
    // unknown_ref below.
    const all = req.all === true;
    // `all` exhausts ONE collection, so it needs the collection's ref. The
    // overview already lists every collection with its exact itemCount, which
    // is where the ref comes from.
    if (all && !req.target) {
      return reject(
        'invalid_args',
        'read: all needs a target — the ref of a collection (the overview lists them)',
        '{"verb":"read"}',
      );
    }
    // `fields` widens the table's rows; on a read that builds no table it would
    // be a silent no-op, and a key that does nothing is the garble class the
    // unknown-key rejection above exists for.
    const fields = req.fields === true;
    if (fields && !all) {
      return reject(
        'invalid_args',
        'read: fields needs all:true — it adds `links` to the rows of a collection table',
        req.target
          ? `{"verb":"read","target":"${req.target}","all":true,"fields":true}`
          : '{"verb":"read"}',
      );
    }
    if (req.cursor != null) {
      const bad = badCursor(g, req.target ?? null, req.cursor, all, fields);
      if (bad !== null) return reject('invalid_args', bad.reason, bad.repair);
    }
    // The chain's delivery record, when this call IS a minted continuation:
    // identity resume serves what the record lacks, never offset arithmetic.
    const prior =
      req.cursor != null
        ? this.priorServed(g.epoch, req as unknown as Record<string, unknown>)
        : null;
    const result = req.target
      ? readTarget(g, req.target, req.cursor ?? null, prior, all, fields)
      : readOverview(g, req.cursor ?? null, prior);
    if (result === null) {
      return reject(
        'unknown_ref',
        `no node ${req.target} in this document version`,
        '{"verb":"read"} for the overview',
      );
    }
    // A known node that heads no collection: the table has no population to
    // state, and the repair names the collection the runtime CAN exhaust.
    if ('rejected' in result)
      return reject('invalid_args', result.rejected.reason, result.rejected.repair);
    this.recordObserved(result.payload);
    this.noteDelivered(result.payload);
    const out = { ...this.envelope(g, result.withheld), ...result.payload };
    this.recordContinuations(out, g.epoch, result.inline);
    this.recordChains(result.chains, g.epoch);
    return out;
  }

  private async doFind(
    req: Extract<VerbRequest, { verb: 'find' }>,
  ): Promise<Record<string, unknown>> {
    // No guard here: find.ts guards its own public surface, and this duplicate
    // was STRICTER — it rejected the state-only queries find.ts implements
    // ({"verb":"find","state":"expanded"}), so a legal query died before ever
    // reaching the verb. One rule, one place.
    const g = await this.ensureGraph();
    const prior =
      req.cursor != null
        ? this.priorServed(g.epoch, req as unknown as Record<string, unknown>)
        : null;
    const result = find(g, req, prior);
    if ('rejected' in result) return result as unknown as Record<string, unknown>;
    this.recordObserved(result.payload);
    this.noteDelivered(result.payload);
    const out = { ...this.envelope(g, result.withheld), ...result.payload };
    this.recordContinuations(out, g.epoch, result.inline);
    this.recordChains(result.chains, g.epoch);
    return out;
  }

  private async doAct(
    req: Extract<VerbRequest, { verb: 'act' }>,
  ): Promise<Record<string, unknown>> {
    const g = await this.ensureGraph();
    const result = await this.executor.act(g, req, () => this.host.currentEpoch());
    if ('rejected' in result) return result as unknown as Record<string, unknown>;
    // The principle: gate-eligible evidence must witness a SITE-side effect the
    // action caused. Evidence that only proves local browser state (a field holds
    // text, an option is chosen) or a fetch the markup already declared (following
    // a link is a GET by definition) is honest at act level but proves no
    // mutation, so it cannot satisfy the MUTATE finish gate (the act result still
    // reports verdict `verified` for the model's use).
    // This behavior was verified during testing.
    // This behavior was verified during testing.
    // not re-derivable now that this rule changed the behaviour it measured — see
    // ADR-004, which also separates "performed a fill" from "cited a fill");
    // navigated_to_destination — tasks 722/725 finished with the gate's blessing
    // and zero POSTs in HARs of 329 and 442 entries (defect C1, next-level.md);
    // dom_mutated — a MutationObserver records client-side rendering, which any
    // script can do without a request leaving the browser; download_started and
    // popup_opened — both witness a fetch, not a site mutation.
    // navigation_get — the browser sent a GET Document request: a link-follow in
    // different clothes, observed live (closes C1's residual; earned by 722/725).
    // navigation_post stays gate-eligible: an observed POST is exactly what the
    // official NetworkEventEvaluator checks. Bare `navigation` (method
    // unobserved) remains gate-eligible as the NAMED residual — rejecting it
    // would false-reject real submits whenever observation fails.
    // text_typed — LOCAL_ONLY at birth, pre-registered before implementation
    // (score-program K3): typing proves the browser holds text, never that the
    // site changed; the commit-button click carries the gate. The conservative
    // direction — ADR-004:146's fence is for gate-eligible additions.
    const LOCAL_ONLY_EVIDENCE = new Set([
      'value_set',
      'option_selected',
      'navigated_to_destination',
      'dom_mutated',
      'download_started',
      'popup_opened',
      'navigation_get',
      'text_typed',
      'file_attached',
      'scrolled',
      'scrolled_no_new_content',
      // A caret that moved is browser state; no key press proves a site change
      // by moving a selection. text_edited joins it for the same reason
      // text_typed is here: a keypress that changes a buffer proves the browser
      // holds the text, never that the site accepted anything.
      'selection_changed',
      'text_edited',
    ]);
    // THE DECLARED ROUTE INTO THE LEDGER (core/expect.ts). A held `sent` or
    // `navigation` expectation is proof of the INTENDED request or the
    // INTENDED served page — strictly more than the mechanical arms above
    // demand — so it admits an act whose own evidence was local-only: a fill
    // that submitted on input (value_set), a click whose rendering the
    // observers saw (dom_mutated) while the receipt carried the declared POST.
    // `text` and `state` never admit: both are local facts, exactly the class
    // ADR-004 keeps out of the gate. `contradicted` never admits either — the
    // mechanical evidence and the declaration are reported side by side, and
    // a contradiction is the one reading that can never become success.
    // THE TYPED LEDGER, BEFORE ANYTHING FROM THIS ACT IS LEDGERED AS DELIVERED:
    // what the page had shown when the keystrokes went in is the question, and
    // this act's own echo of the value must not answer it.
    if ((req.action === 'fill' || req.action === 'type') && typeof req.value === 'string') {
      this.noteTyped(req.value, g.nodes.get(req.ref));
    }
    // THE UNSEEN BLOCK rides the receipt the model reads at act time, and the
    // ledger entry the confrontation restates at finish. A fact, not a verdict.
    const unseenBlock = this.unseenSent(result.actRef);
    if (unseenBlock.unseen !== undefined || unseenBlock.unseenUnchecked !== undefined) {
      (result as { receipt: ActReceipt }).receipt = { ...result.receipt, ...unseenBlock };
    }
    const exp = result.effect.expectation;
    const declaredProof =
      exp !== undefined &&
      exp.held &&
      result.effect.verdict !== 'contradicted' &&
      ((req.expect?.sent !== undefined && req.expect?.sent !== null) ||
        (req.expect?.navigation !== undefined && req.expect?.navigation !== null));
    const mechanicalProof =
      result.effect.verdict === 'verified' && !LOCAL_ONLY_EVIDENCE.has(result.effect.evidence);
    if (mechanicalProof || declaredProof) {
      this.recordVerifiedAct({
        actRef: result.actRef,
        action: req.action,
        evidence: result.effect.evidence,
        ...sentSummary(result),
        ...(exp !== undefined ? { expectation: expectationSummary(exp) } : {}),
        ...unseenBlock,
      });
    }
    // The receipt's values are now shown — the model can read them.
    this.noteDelivered(result.receipt);
    this.observedRefs.add(result.actRef);
    if (
      (req.action === 'fill' || req.action === 'type') &&
      typeof req.value === 'string' &&
      req.value.trim() !== ''
    ) {
      // The REF travels with the text. Without it the comparison below paired a
      // node's value against anything typed anywhere this session, and two
      // drivers on one day were told an endpoint had resolved when the field
      // they were reading had never been written to.
      this.typedValues.push({ ref: req.ref, value: req.value });
      if (this.typedValues.length > 6) this.typedValues.shift();
    }
    if (!this.refEpoch.has(result.actRef)) {
      this.refEpoch.set(result.actRef, this.host.currentEpoch());
    }
    // WHERE THE ACT LANDED IS OBSERVED. An act that navigates tells the model the
    // destination in its own URL delta, so refusing a `navigate` back to it is the
    // closure contradicting what the runtime just said.
    //
    // This behavior was verified during testing.
    // the next-turn `navigate` to that exact URL was rejected "limited to URLs
    // already observed", and the same call succeeded after one `read`. The reason
    // was mechanical — seenUrls was fed only by goto and by COMPILE (graph.url plus
    // every compiled href), so a destination reached by acting existed nowhere until
    // something recompiled.
    //
    // Third instance today of one question answered by two closures that disagree,
    // after navigate-vs-host-origins and find-vs-act on which node a name means.
    this.noteUrl(this.host.page.url());
    // And what the receipt showed — the page's own requests, on the origin of
    // the document acted on (or the one the act landed on, whose subresources
    // the same window may have caught). Fourth instance: see noteShownRequests.
    this.noteShownRequests(result.receipt, [g.url, this.host.page.url()]);
    // Input was dispatched: the world may have moved in ways the loaderId cannot
    // show (same-document mutation). Drop the cached graph unconditionally — any
    // verdict, including unknown and contradicted — so the next read/find
    // recompiles. Proven defect: an expanded dropdown followed by an identical
    // This behavior was verified during testing.
    this.graph = null;
    this.graphToken = null;

    // AN ACT THAT REPLACED THE DOCUMENT RETURNS ITS LANDING OVERVIEW.
    //
    // Measured over the recorded corpus: 1,974 acts replaced the document and 1,424
    // of them (72.1%) were followed immediately by a bare `read {}`. Of the 1,133
    // bare reads following a *verified* act, 996 (87.9%) follow a replacement. That
    // read is not ceremony — every ref the caller holds was minted under the old
    // epoch and is now dead, so the read is forced, not chosen. At ~5.1s of model
    // latency per round trip it is ~2 minutes per episode of pure transport.
    //
    // ONLY on replacement, and the scoping is the whole design. A same-document act
    // is excluded: only 137 bare reads follow one, and in those 79.6% of the refs
    // returned were ALREADY in the caller's hands — refs are sha1(epoch:backendNodeId)
    // and survive a same-document recompile. Folding an overview into all 3,845 acts
    // would ship ~17 MB to save at most 137 more calls, a 2.1x net byte loss against
    // a transcript that is 95.4% prefix-cached only because it grows at the end.
    //
    // The block is `readOverview` called verbatim, not an act-flavoured summary, so
    // there is one projection rather than two that can drift, `read` is still not
    // filtered through `act`'s vocabulary, and every `withheld`/`moreX` continuation
    // travels exactly as it does on a read.
    if (this.host.currentEpoch() !== g.epoch) {
      try {
        const g2 = await this.ensureGraph();
        const landing = readOverview(g2, null);
        // (1) The refs must be citable. `observedRefs` is fed only from doRead and
        //     doFind, so without this the runtime would deliver refs that its own
        //     finish gate then rejects as "never observed this episode" — the exact
        //     mirror of the phantom-offer defect: delivered but uncitable.
        this.recordObserved(landing.payload);
        this.noteDelivered(landing.payload);
        // (2) The SAME envelope a plain read gets — envelope(), never hand-rolled.
        //     The hand-rolled version dropped the overview's own `withheld` (the
        //     controls-page continuation) and the coverage `gaps` detail, while
        //     the comment below promised every continuation travels exactly as on
        //     a read: HN's More click landed on 231 controls, showed 50, and said
        // This behavior was verified during testing.
        //     envelope() also reports freshness from recompiledThisCall, which
        //     the ensureGraph above just set — the graph was dropped before this
        //     block, so a cache hit here is impossible.
        const out = { ...this.envelope(g2, landing.withheld), ...result, landing: landing.payload };
        // (3) The ledger walks the full response — the envelope's withheld
        //     included, which the payload-only walk missed — under the NEW epoch,
        //     never the pre-act one. `g` above is the graph the act ran against
        //     and its epoch is already dead; ledgering offers under it strands
        //     them instantly behind the epoch filter (D2/D3 from
        //     CONFRONTATION-DIAGNOSIS.md), and this mint site fires on every
        //     document-replacing act.
        this.recordContinuations(out, g2.epoch, landing.inline);
        this.recordChains(landing.chains, g2.epoch);
        return out;
      } catch {
        // (4) BEST EFFORT, ALWAYS. `captureFacts` throwing is a recorded
        //     episode-killer — "Target page, context or browser has been closed"
        //     discarded 31 calls of work on a live run. The act already succeeded
        //     and its evidence is already recorded above; an act that changed the
        //     world must never die of its own projection. Fall through to the
        //     unchanged response.
      }
    }
    return {
      documentEpoch: this.host.currentEpoch(),
      // `dirty`, not `live`: the graph this act ran against was just dropped, so
      // this response is not backed by a projection whose currency can be proved.
      freshness: 'dirty' as const,
      // Read live rather than from the dropped graph: this is the response most
      // likely to be the LAST thing an episode sees before it finishes, and a
      // NAVIGATE request is graded on where the browser ends up. `...result` may
      // splice in a landing overview after a document replacement, so it wins.
      url: this.host.page.url(),
      document: this.documentBlock(),
      coverageIncomplete: !g.coverage.complete,
      ...result,
    };
  }

  /** What the runtime OBSERVED about the population behind a set of cited refs.
   *
   *  Facts only. It never judges whether the scope is right — that would be a
   *  comparator over meaning, which belongs to the model and, for correctness, to
   *  the official evaluator alone.
   *
   *  Needs no new bookkeeping: `observedRefs` already records every ref a payload
   *  actually carried, so a collection's delivered count is the intersection with
   *  its own `itemRefs`. Verified read-only across pages with flat and nested
   *  collections, each
   *  reconciling exactly with the `withheld` count the same read reported. This
   *  is structural rather than site-specific.
   *
   *  A cited ref may be an item or anything beneath one (a title link inside a
   *  row), so ownership is resolved over each item's whole subtree.
   *
   *  null, never [], when there is NO compiled graph to check against. Every act
   *  nulls the cache (doAct) and finish never compiles, so a finish right after
   *  a same-document act is uncheckable — and returning [] there made it read
   *  exactly like "checked, nothing partial" (probe
   * This behavior was verified during testing.
   *  a 10-of-92 population went silent after one hover). Unknown is not clean —
   *  the same rule as graphToken's "null means no evidence, never unchanged".
   */
  /** How many collections the compiled graph holds; null when there is no graph.
   *
   * `scopeFacts` returns [] for two structurally different situations — this page
   * has no collections at all, and your cited refs sit outside the collections it
   * does have — and a caller cannot tell them apart. On a product detail page the
   * second is normal and benign: an h1 and a price belong to no list, and there
   * is nothing to answer for. Reporting that as though a population had been
   * missed made every "open the page for X" episode end on a false objection.
   * The graph is the only layer that knows which case holds, so it says.
   */
  collectionCount(): number | null {
    return this.graph ? this.graph.collections.length : null;
  }

  scopeFacts(refs: readonly string[]):
    | {
        collection: string;
        items: number;
        delivered: number;
        cited: number;
        continuation?: string;
      }[]
    | null {
    const g = this.graph;
    if (!g) return null;
    if (refs.length === 0) return [];
    const owner = new Map<string, string>(); // any ref -> collection ref
    const ownerSpan = new Map<string, number>(); // ...and how big that item's subtree was
    const size = new Map<string, string[]>(); // collection ref -> itemRefs
    for (const c of g.collections) {
      size.set(c.ref, [...c.itemRefs]);
      for (const item of c.itemRefs) {
        const root = g.nodes.get(item);
        if (!root) continue;
        const sub = collectSubtree(root, g);
        for (const n of sub) {
          // SMALLEST containing item wins, not the first one found. Collections
          // nest — an inner table can sit inside an outer layout table — and
          // first-wins credited a cited row to the OUTER collection, which
          // then read as "4 of 4, delivered whole" and silenced the gate on a
          // population the caller had only partially seen. Cross-site verification
          // caught the error because both nested and flat collections exercised
          // this rule.
          const prev = ownerSpan.get(n.ref);
          if (prev === undefined || sub.length < prev) {
            owner.set(n.ref, c.ref);
            ownerSpan.set(n.ref, sub.length);
          }
        }
      }
    }
    const hit = new Set<string>();
    for (const r of refs) {
      const c = owner.get(r);
      if (c) hit.add(c);
    }
    const citedSet = new Set(refs);
    return [...hit]
      .map((cref) => {
        const items = size.get(cref) ?? [];
        const delivered = items.filter((r) => this.observedRefs.has(r)).length;
        // How many of this population the finish actually leans on. Not a firing
        // trigger — a single-value answer legitimately cites one row of a long list
        // — but it makes the question concrete: "3 of the 10 you were shown, of 12
        // that exist" is answerable; "did you cover everything?" is not.
        // Guarded, not asserted: the ownership loop above already treats an
        // unresolvable itemRef as possible (`if (!root) continue`), and the same
        // lookup must not throw here. This runs INSIDE doFinish — an exception here
        // would turn a finish into a crashed episode, which is the worst place in
        // the run to discover an inconsistency between a collection's itemRefs and
        // the node table.
        const cited = items.filter((r) => {
          if (citedSet.has(r)) return true;
          const node = g.nodes.get(r);
          return node !== undefined && collectSubtree(node, g).some((n) => citedSet.has(n.ref));
        }).length;
        return {
          collection: cref,
          items: items.length,
          delivered,
          cited,
          // Offered as the literal next call, never as prose — same invariant the
          // pagination bounds answer to.
          ...(delivered < items.length
            ? { continuation: JSON.stringify({ verb: 'read', target: cref }) }
            : {}),
        };
      })
      .sort((a, b) => a.delivered / a.items - b.delivered / b.items);
  }

  /** The fact sheet, but only when a fact is worth stating.
   *
   *  A collection delivered WHOLE is not news, and a gate that speaks on every
   *  episode is informationally identical to one that never speaks: the byte-ranked
   *  predecessor fired on 98% of episodes (n=57) and changed the answer in ~2%.
   *  So this reports only populations the caller did not see all of. On a 4-verb
   *  NAVIGATE request citing one whole node it says nothing at all, which is the point.
   *
   *  With one exception, and it is a disclosure, not a judgment: when there is no
   *  compiled graph at finish time the check CANNOT run, and staying silent would
   *  present "could not check" as "checked, nothing partial". `scopeUnchecked` is
   *  the flat additive flag that keeps the envelope honest — absent `scope` now
   *  means checked-clean, and only that. */
  private scopeEnvelope(refs: readonly string[]): Record<string, unknown> {
    const facts = this.scopeFacts(refs);
    if (facts === null) return { scopeUnchecked: true };
    const partial = facts.filter((f) => f.delivered < f.items);
    return partial.length > 0 ? { scope: partial } : {};
  }

  // ADR-003: mechanical only; mode from runner-declared expectedAction, never the model.
  private async doFinish(
    req: Extract<VerbRequest, { verb: 'finish' }>,
  ): Promise<Record<string, unknown>> {
    const h = this.queryHash(req);
    const rejectFinish = (reason: string, repairOverride?: string): Record<string, unknown> => {
      // MESSAGES ONLY: the ledger decides how a rejection is worded, never
      // whether it is one. One marker covers both circles — sent again now and
      // sent again eventually — because the repair is identical either way, and
      // a second phrasing for "immediately before" would be gate vocabulary
      // about local history that the model cannot act on differently (ADR-004).
      const seenBefore = this.rejectedFinishHashes.has(h);
      this.rejectedFinishHashes.add(h);
      return reject(
        'finish_rejected',
        seenBefore
          ? `${reason} (already submitted and rejected this episode — change the finish or gather evidence)`
          : reason,
        // The repair follows the CLAIM, not the mode. "It is not there" is proved
        // by where the model looked in every mode — an act on a thing that does
        // not exist is unreachable, so pointing a rejected not_found_error at the
        // act ledger would be a rejection with no acceptance path (ADR-003's
        // stated consequence, and the exact shape of Option A it rejected).
        OBSERVATION_BAR_STATUSES.has(req.status ?? '')
          ? 'cite refs you received from find/read this episode showing where you looked; ' +
              'the answer may then be empty. If instead you tried and could not complete the ' +
              'request, that is not a finish.'
          : this.expectedAction === 'MUTATE'
            ? 'cite an act whose evidence proves a server-side change: a form submit (navigation_post), ' +
              'a document replacement (navigation), a confirmed control change (target_state_changed), ' +
              'or a server-answered application request (request_committed), ' +
              'or an act whose declared expect.sent or expect.navigation held. ' +
              'A fill (value_set), typed text (text_typed), a link-follow, or a client-side route ' +
              'proves only local state — submit first.'
            : (repairOverride ??
              'cite refs you received from find/read this episode; answer must be non-empty'),
      );
    };
    const refs = req.evidenceRefs ?? [];
    // not_found_error: "the requested entity does not exist" is a first-class
    // answer (earned by tasks 22/24). It waives the non-empty answer, never the
    // evidence bar — the claim "it isn't there" must cite where the model looked.
    //
    // Checked BEFORE the mode branch, or it is unreachable on MUTATE: the MUTATE
    // branch returns, so a mutation episode whose target genuinely does not exist
    // had no channel at all and had to abstain (reproduced on the real site,
    // This behavior was verified during testing.
    // The MUTATE gate asks for proof that the site CHANGED; this finish claims the
    // opposite, so it is a different claim under its own bar — the observation
    // bar, identical to RETRIEVE's — not an exemption from that one. Nothing here
    // can launder a failed mutation into success: the answer travels to the
    // official evaluator as NOT_FOUND_ERROR, which a request expecting a change
    // scores 0, exactly as give_up does.
    // The same bar covers three claims about the WORLD rather than about a change
    // the model made: the thing is not there (not_found_error), the site refuses
    // the change or offers no control for it (action_not_allowed_error), and the
    // account lacks the right (permission_denied_error). Earned by 9 episodes the
    // sweep measured as otherwise-solved — the agent found the blocker, understood
    // it, and had no word for it, so `give_up` reported UNKNOWN_ERROR and a correct
    // investigation scored as a crash.
    //
    // They waive the non-empty answer, never the evidence bar. Nothing here can
    // launder a failed mutation into success: each travels to the official
    // evaluator as its own status, which a request expecting a change scores 0.
    // CHECKED BEFORE THE STATUS BRANCHES, because the observation-bar branch
    // below returns first and is deliberately mode-independent — so a NAVIGATE
    // finish carrying not_found_error short-circuited past this entirely. That

    // order is Processing") while the grader ALSO requires the browser to be
    // parked on the bare order-history URL. The network check does not care what
    // the answer said, so neither can this.
    // A NAVIGATE EPISODE MUST FINISH ON THE DOCUMENT IT IS ANSWERING ABOUT.
    //
    // Mechanical, and ADR-003-clean: it compares the epoch a ref was minted under
    // to the epoch the browser is in now. No page text is read, no answer is
    // judged, and the request's target URL never enters core — this is the same
    // class of bookkeeping as the observedRefs check directly above.
    //
    // Earned by measurement, not taste: the official evaluator keeps exactly one
    // event for a NAVIGATE request with an expected GET — the last document
    // navigation of the episode — so arriving at the target and then leaving
    // scores zero. 19 of 50 such failures did precisely that, several by a
    // single navigation after the answer was already in hand.
    //
    // Fails OPEN wherever it cannot be sure: unknown provenance, or an epoch the
    // runtime never recorded, is not grounds to refuse a finish.
    if (this.expectedAction === 'NAVIGATE') {
      const now = this.host.currentEpoch();
      const placed = refs
        .map((r) => this.refEpoch.get(r))
        .filter((e): e is string => e !== undefined);
      if (placed.length > 0 && !placed.includes(now)) {
        return rejectFinish(
          'every cited ref was observed on a document this browser has since left',
          'a request that asks you to open a page is answered by the page you are STANDING ON ' +
            'when you finish, not by one you visited on the way. Go back to that page, read ' +
            'it, and cite what you see there.',
        );
      }
    }
    if (OBSERVATION_BAR_STATUSES.has(req.status ?? '')) {
      const claim = req.status as string;
      if (refs.length === 0)
        return rejectFinish(`${claim} still requires evidence refs — cite where you looked`);
      const unseen = refs.filter((r) => !this.observedRefs.has(r));
      if (unseen.length > 0)
        return rejectFinish(`refs never observed this episode: ${unseen.join(', ')}`);
      return {
        ...this.finishEnvelope(),
        accepted: true,
        mode: this.expectedAction,
        status: claim,
        ...this.scopeEnvelope(refs),
      };
    }
    if (this.expectedAction === 'MUTATE') {
      const cited = refs.filter((r) => this.verifiedActs.has(r));
      if (cited.length === 0)
        return rejectFinish('MUTATE finish must cite an act with effect verdict verified');
      return { ...this.finishEnvelope(), accepted: true, mode: this.expectedAction };
    }
    if (!req.answer || req.answer.trim() === '')
      return rejectFinish('empty answer on a RETRIEVE/NAVIGATE episode');
    if (refs.length === 0) return rejectFinish('no evidence refs cited');
    const unknown = refs.filter((r) => !this.observedRefs.has(r));
    if (unknown.length > 0)
      return rejectFinish(`refs never observed this episode: ${unknown.join(', ')}`);
    return {
      ...this.finishEnvelope(),
      accepted: true,
      mode: this.expectedAction,
      ...this.scopeEnvelope(refs),
    };
  }

  /** The shared envelope on an accepted finish, so every verb reply is typed
   *  the same way. Until now finish was the one verb whose reply carried no
   *  documentEpoch and no freshness — the last thing an episode sees said
   *  nothing about which document it was standing on.
   *
   *  `dirty`, by the type's own definition: no compiled graph stands behind
   *  this response. The gate reads the evidence ledger and the epoch, never a
   *  projection, and has not read the mutation stream, so `live` would be a
   *  claim it did not check. coverageIncomplete is the standing graph's own
   *  reading when that graph is of the current document, and false — the same
   *  thing navigate says — when there is none. */
  private finishEnvelope(): Envelope {
    const documentEpoch = this.host.currentEpoch();
    const g = this.graph !== null && this.graph.epoch === documentEpoch ? this.graph : null;
    // The document block rides every reply, the finish included: the gate's
    // answer is read beside "which document did the site last serve" — the
    // NAVIGATE class is graded on exactly that.
    return {
      documentEpoch,
      freshness: 'dirty',
      coverageIncomplete: g !== null && !g.coverage.complete,
      url: this.host.page.url(),
      document: this.documentBlock(),
    };
  }
}
