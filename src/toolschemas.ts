// The five verbs as OpenAI-style tool definitions. They live in core so the
// reference agent and any future consumer share ONE source of truth with the
// wire contract (core/types.ts VerbRequest) — schema drift between an agent's
// tool list and the runtime's verbs was defect class C5. Schemas are flat — no
// nested argument objects (docs/protocol.md).

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const READ_DESCRIPTION =
  "Read the page's structure and text. Without target: the page overview (regions, " +
  'headings, collections, controls). With target (a node ref): that subtree. ' +
  'cursor pages further through withheld content. ' +
  "all:true with a collection ref (from the overview's collections) returns EVERY " +
  'item of that collection on this page as one table — one row per item with its ' +
  'ref, label and text, plus the row as a RECORD: `numbers` (every numeric token in the ' +
  'row\'s own text, verbatim, as {raw, number, unit?} — "$244.97" is {raw:"$244.97", ' +
  'number:244.97, unit:"$"}; aggregate over these, never by re-parsing the text) and ' +
  '`values` (each control under the row holding a value); add fields:true for `links` ' +
  'too (each link under the row: ref, name, href) — with the exact item count stated ' +
  'first; use it before ' +
  'counting, comparing or ranging over a list (a min/max price, a count of rows ' +
  'matching a condition) instead of paging by hand. A table over the byte budget ' +
  'pages by rows, with the count remaining and the continuation. It covers this ' +
  'page only: when the site continues the list on another page the table names that control as nextPage — click it and read all:true again; the population is the union. ' +
  "With target an actRef: that act's full receipt — every request it sent, every " +
  'body field, values uncut. cursor pages further through withheld content. ' +
  'An argument the runtime could unambiguously normalize is applied and echoed under `applied`, the exact call it ran.';

// EXPERIMENT ONLY (docs/plans/read-screenshot-experiment.md). The screenshot is an
// instrument for measuring what the projection fails to carry, not a capability:
// screenshots-to-model stays on the banned list (docs/next-level.md), and a win
// here buys a projection change, never this clause staying on.
const READ_SCREENSHOT_CLAUSE = 'A picture of the visible page is attached after each read.';

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'find',
      description:
        'Resolve a description to page nodes. At least one of role or name is required. ' +
        'name matches by case-, whitespace- and Unicode-normalized substring over the ' +
        "node's accessible name, owned text and accessible description (a title or " +
        "tooltip, shown as `description`) — use the page's own words. " +
        'When exactly one node matches, the result also carries `detail`: what read ' +
        '{target: thatRef} would return (the node, its children with their content, the ' +
        'continuation if they page), so no follow-up read is needed. ' +
        'find never changes the page, so several finds are always safe together: ' +
        'issue every one you already know you need in THIS turn rather than one per turn. ' +
        'A result may carry `unrendered`: text that IS in the document but is not rendered ' +
        '— inside a collapsed menu, a closed section, a hidden tab panel — grouped under the ' +
        'nearest rendered container, each with the literal call (`open`) that reveals it: ' +
        'act click on the container, or read it for its controls, then find again. ' +
        'Only rendered nodes have refs; an unrendered match is a lead, not a target. ' +
        'Matches that would otherwise print identically each carry `in`, the nearest enclosing landmark ' +
        'or named container ({ref, role, name?}) — or the ancestor chain, nearest first, when the nearest ' +
        'reads the same — so a nav label and a section header with the same words are told apart. ' +
        'An argument the runtime could unambiguously normalize is applied and echoed under `applied`, the exact call it ran.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'role filter, e.g. link, button, textbox' },
          name: { type: 'string', description: "substring of the page's own words" },
          within: { type: 'string', description: 'node ref that scopes the search' },
          state: { type: 'string', description: 'state filter' },
          limit: { type: 'integer', description: 'max matches per page of results' },
          cursor: { type: 'string', description: 'continuation cursor from a previous result' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: READ_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'node ref to read; omit for the page overview' },
          cursor: { type: 'string', description: 'continuation cursor from a previous result' },
          all: {
            type: 'boolean',
            description:
              'with a collection ref as target: exhaust the collection into one table of every item on this page',
          },
          fields: {
            type: 'boolean',
            description:
              'with all:true: each row also carries `links` — every link under it with ref, name and href',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'act',
      description:
        'Perform an action on a node. ' +
        'fill, select, type and upload change only their own control, so a whole form ' +
        'is ONE turn: issue an act per field in the same turn, then the submit click. ' +
        'A batch stops at the first call that moves the page, and the rest are returned ' +
        'unrun, so ordering them field-by-field-then-submit costs nothing. ' +
        'click — press it; checkboxes and radios are click. ' +
        "fill — replace a field's value. " +
        'select — choose an option by its visible label. ' +
        "type — replace an editor-like control's content through the page's keyboard " +
        'layer; use when fill reports value_mismatch on a code or rich-text editor, ' +
        'whose readable value is a paged window rather than the document. ' +
        'key — press one key or chord on a control as a real key event: value is ' +
        'Enter, Escape, Tab, Backspace, Delete, Home, End, PageUp, PageDown, an arrow ' +
        'key, a function key or a single character, optionally prefixed with Control+, ' +
        'Alt+, Shift+ or Meta+ (for example "Control+a" to select all). Use it for what ' +
        'only the keyboard can do — submitting a field that has no button, dismissing a ' +
        "dialog that has no close control, selecting an editor's whole content. It " +
        'presses; it never types text — fill and type do that. ' +
        'upload — attach a file to a file input by its NAME (a bare filename, never a ' +
        'path); only files made available to this episode can be attached. ' +
        'scroll — advance the scrollable region containing ref by one of its own ' +
        'viewports, to reach list content the page renders only as you scroll; the ' +
        'result says whether anything new appeared, so repeat while it does. ' +
        'hover — rest the pointer on a node, pressing nothing, to reveal content ' +
        'that appears on pointer-over: a hover menu, a tooltip, a flyout. The ' +
        'pointer stays put, so what opened stays open for the next call. ' +
        'Returns an actRef, an effect verdict, and a receipt: the requests the browser ' +
        "sent inside this act's window — method, URL with query, response status, and the " +
        'body fields (form, JSON or multipart) — as data. The verdict says whether something ' +
        'happened; the receipt says WHAT WAS SENT, so read it before trusting a verified act: ' +
        'a request to a different route, or carrying different fields, than you intended is ' +
        "visible there and nowhere else. Attribution is by window — a timer's request can " +
        'appear beside yours; atMs and initiator tell them apart. Password field values are ' +
        'redacted. The receipt is capped and states what it withheld; read the actRef as a ' +
        'target for all of it. ' +
        'expect declares what you MEAN this act to send or show; the result then carries ' +
        'effect.expectation {held, failed:[{key, wanted, observed}]} beside the verdict.' +
        ' ' +
        'An argument the runtime could unambiguously normalize is applied and echoed under `applied`, the exact call it ran. ' +
        'until — wait, as part of this act, for a condition instead of re-reading or ' +
        're-scrolling: exactly one of text (these words appear on the page), gone (they no ' +
        'longer do), role ({role, name?} exists), state ({ref?, checked|selected|expanded|' +
        'disabled|value} holds on the target or ref), network ("idle": no request of this ' +
        'act still in flight for 500 ms); withinMs bounds it (default 5000, max 15000). The ' +
        "result's effect.until says condition_met or timed_out, when, and what was seen; " +
        'timed_out never changes the verdict. scroll with until.text scrolls to the end until ' +
        'the words appear. A click refused as blocked_by_overlay by a loading indicator offers ' +
        'the same act with until: that act first waits, within the same bound, for the ' +
        'indicator to leave the target, then dispatches.',
      parameters: {
        type: 'object',
        properties: {
          // scroll's ref is deliberately looser than the others', and saying so
          // here is the only place a model would learn it: nothing in the graph
          // is marked "scrollable" (a scroll container is usually an anonymous
          // div with no name and no role), so a model told to pass "the
          // scrollable ref" would hunt for something that is never projected.
          ref: {
            type: 'string',
            description:
              'node ref from a previous result. For scroll, pass any ref INSIDE the ' +
              'region you want scrolled — a link or item you can see there — and the ' +
              'nearest scrolling container around it is what moves; the result names ' +
              'which one that was.',
          },
          action: {
            type: 'string',
            enum: ['click', 'fill', 'select', 'type', 'key', 'upload', 'scroll', 'hover'],
          },
          value: {
            type: 'string',
            description:
              'text for fill and type, visible label for select, key name or chord for key, filename for upload, "end" for scroll to go all the way to the bottom of that region in one call; omit for click and hover, and for scroll to advance one viewport',
          },
          // The one nested object on the wire (docs/protocol.md says flat).

          // which claims belong together, and a declaration is one claim.
          expect: {
            type: 'object',
            description:
              'What you expect this act to send or show, checked after settle. Every key ' +
              'optional. text: page words that must be NEWLY on the page. state: ' +
              '{checked, selected, expanded, disabled, value} the target must then hold. ' +
              'navigation: origin+path (or a path) the site must have SERVED afterwards. ' +
              'sent: {method (default any non-GET), path, fields:{name:value}} a request in ' +
              'the receipt must carry, answered below 400 — the value of each field is ' +
              'compared exactly. held:false never changes the verdict; each failed key ' +
              'reports what was actually observed. An act whose sent or navigation ' +
              'expectation held proves the request you INTENDED, so it is what a MUTATE ' +
              'finish should cite, even when its evidence is value_set or dom_mutated.',
            properties: {
              text: { type: 'string' },
              state: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  checked: { type: 'boolean' },
                  selected: { type: 'boolean' },
                  expanded: { type: 'boolean' },
                  disabled: { type: 'boolean' },
                  value: { type: 'string' },
                },
              },
              navigation: { type: 'string' },
              sent: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  method: { type: 'string' },
                  path: { type: 'string' },
                  fields: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
            additionalProperties: false,
          },
          until: {
            type: 'object',
            description:
              'a condition this act waits for before returning — exactly one of text, gone, role, state, network',
            properties: {
              text: {
                type: 'string',
                description:
                  "the page's own words that must appear (normalized substring, as find matches)",
              },
              gone: {
                type: 'string',
                description: 'words that must no longer appear, e.g. a loading label',
              },
              role: {
                type: 'object',
                additionalProperties: false,
                required: ['role'],
                properties: { role: { type: 'string' }, name: { type: 'string' } },
                description: 'a rendered node with this role (and name substring) must exist',
              },
              state: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: { type: 'string' },
                  checked: { type: 'boolean' },
                  selected: { type: 'boolean' },
                  expanded: { type: 'boolean' },
                  disabled: { type: 'boolean' },
                  value: { type: 'string' },
                },
                description: "the target's (or ref's) own state must read so",
              },
              network: {
                type: 'string',
                enum: ['idle'],
                description: "no request of this act's window still in flight for 500 ms",
              },
              withinMs: {
                type: 'integer',
                description: 'bound in milliseconds, default 5000, max 15000',
              },
            },
            additionalProperties: false,
          },
        },
        required: ['ref', 'action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description:
        "Go directly to a page this episode has already seen — the closure is on ORIGIN + PATH (a visited page, a link the graph has shown, or a request an act's receipt has shown), so the QUERY STRING may differ from anything observed. Use it to return after following an external link, and to reach a filter bound the site keeps in its parameter grammar but exposes through no control. " +
        "A receipt's request URL is navigable as shown: when a control fetched a page in the background (an XHR the receipt lists), loading that same address makes it the document the browser is on. It arrives with the page you are on as Referer, like a link. " +
        "It LOADS a document. Every result carries document.servedUrl (the last page the site actually served) and document.shownUrl (the address bar now); when they differ you are on a client-side route the page drew itself, and a navigate to ANY address — the one already shown, or another path a link showed you — is refused (navigate_would_replace_served_document), because that load would replace the served page as the last thing the site served and discard what is shown; reach the address through the page's own control via act, or pass force:true to load it anyway. " +
        "Navigating back to the served address itself while a client-side route is shown is refused too (navigate_would_discard_shown_state): that load reaches the same served document and discards the state the page reached without one; the page's own controls change that state, or force:true. " +
        "A URL whose query string you composed yourself is admitted on a server-rendered page but refused while the page you are on is a client-side route (navigate_constructed_address) — reach that state through the page's own controls, or force:true. Every result carries `replaced`: the document the load replaced and whether it was a client-side route, so you can see when a load overwrote the page the site had been serving.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          force: {
            type: 'boolean',
            description:
              'load the URL even when it is the address already shown on a client-side route',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'End the episode. answer is your final answer; evidenceRefs is a flat array of ' +
        'refs received earlier this episode (node refs and actRefs) that support it.',
      parameters: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            description:
              'the final answer, ALWAYS a string — when the request declares a structured answer schema, send that JSON encoded as a string ("[\\"a\\", \\"b\\"]", never ["a", "b"]); may be empty when the request was a site change backed by a verified act, or when status is not_found_error, action_not_allowed_error or permission_denied_error',
          },
          evidenceRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'refs observed this episode',
          },
          status: {
            type: 'string',
            enum: [
              'success',
              'not_found_error',
              'action_not_allowed_error',
              'permission_denied_error',
            ],
            description:
              'not_found_error when the requested entity does not exist; action_not_allowed_error when the site refuses the change or offers no control for it; permission_denied_error when your account lacks the right. All three cite the refs where you looked; the answer may then be empty',
          },
        },
        required: ['answer', 'evidenceRefs'],
        additionalProperties: false,
      },
    },
  },
];

/** The verb list a consumer should hand the model, given what this episode will
 *  actually do. A model told about a screenshot it never receives, and a model
 *  sent one it was never told about, are two different experiments — the arms have
 *  to differ in exactly one thing, so the description and the attachment move
 *  together or not at all. Core takes the decision as an argument and reads no
 *  environment: which arm is running is the runner's authority, not the runtime's. */
export function toolDefinitionsFor(opts: { readScreenshot: boolean }): ToolDefinition[] {
  if (!opts.readScreenshot) return toolDefinitions;
  return toolDefinitions.map((tool) =>
    tool.function.name !== 'read'
      ? tool
      : {
          ...tool,
          function: {
            ...tool.function,
            description: `${READ_DESCRIPTION} ${READ_SCREENSHOT_CLAUSE}`,
          },
        },
  );
}
