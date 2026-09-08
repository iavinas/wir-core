// Browser host: one Playwright Chromium, a browser context PER DECLARED ORIGIN,
// and a raw CDP session on the page of each. Owns document identity: epoch =
// main frame loaderId of the ACTIVE page, proven by Page events
// (docs/adr/002-loaderid-document-epoch.md). Facts are acquired here and only here.

import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type CDPSession,
} from 'playwright';

export interface RawFacts {
  epoch: string;
  url: string;
  snapshot: SnapshotDoc;
  ax: AXNodeRaw[];

  axOnly: AxOnlyNode[];
  /** Elements in the browser's top layer at census time (see TopLayerIds). */
  topLayer?: TopLayerIds;
}

/** What the DOM domain reports for a backend id the snapshot omitted. Nothing
 *  here is inferred: nodeName/pseudoType are DOM.describeNode's own words, and
 *  bounds is DOM.getBoxModel's border quad. `bounds` is null when the node has
 *  no box (not rendered) — the compiler's admission rule reads that exactly as
 *  it reads a missing layout entry for a DOM node. */
export interface AxOnlyNode {
  backendNodeId: number;
  nodeName: string;
  pseudoType: string;
  bounds: [number, number, number, number] | null;
}

// Minimal typing over the CDP payloads we consume.
export interface SnapshotDoc {
  strings: string[];
  documents: {
    documentURL: number;
    title: number;
    baseURL: number;
    // Which frame this document belongs to. Needed to pull the frame's own
    // accessibility tree: getFullAXTree without a frameId answers for the main
    // frame only, so an iframe's content would arrive with DOM but no roles or
    // names — compiled and invisible, the recall class.
    frameId?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    nodes: {
      parentIndex: number[];
      nodeType: number[];
      nodeName: number[];
      nodeValue: number[];
      backendNodeId: number[];
      attributes: number[][];
      // Owner element -> index of the document it contains, within this
      // snapshot's `documents`. The only link between an <iframe> element and
      // the document inside it.
      contentDocumentIndex?: { index: number[]; value: number[] };
      inputValue?: { index: number[]; value: number[] };
      inputChecked?: { index: number[] };
      optionSelected?: { index: number[] };
      isClickable?: { index: number[] };
      // Non-empty when any compiled node lives inside a shadow tree. DOMSnapshot
      // hands us shadow content (open AND closed) as ordinary nodes of the top
      // document, so the graph contains it — but a MutationObserver cannot reach
      // it (see FRESHNESS_SOURCE). Read for exactly that judgement, never for
      // projection.
      shadowRootType?: { index: number[]; value: number[] };
    };
    layout: {
      // scrollRects vs clientRects — the only place the runtime can learn that a
      // region SCROLLS. CDP gives both per layout node; when the scroll rect is
      // taller (or wider) than the client rect, there is content past the fold.
      // Requested and decoded because a caller could not otherwise tell which of

      // test, an agent scrolled the PAGE instead of the legal-text container and
      // the accept button that container gates stayed disabled every run.
      scrollRects?: (number[] | undefined)[];
      clientRects?: (number[] | undefined)[];
      // `styles` is one entry per layout node: string indexes for exactly the
      // properties in SNAPSHOT_COMPUTED_STYLES, in that order (CDP
      // DOMSnapshot.LayoutTreeSnapshot). It was requested but never decoded —
      // which is how visibility:hidden nodes reached the graph (review R1).
      nodeIndex: number[];
      bounds: number[][];
      text?: number[];
      styles?: number[][];
    };
  }[];
}

// The document's TOP LAYER, as backendNodeIds — `<dialog>`s opened with
// showModal(), open popovers, fullscreen elements — read from
// `DOM.getTopLayerElements` in the same census as the snapshot. It is the one
// fact about stacking the snapshot cannot carry: a top-layer element paints
// above every z-index in the document, and nothing in its own computed style
// says so. Optional because compile() is also fed by fixtures and probes that
// build facts without a census; absent reads as "none".
export type TopLayerIds = number[];

// The computed-style whitelist the census requests, and the single source of the
// column order the compiler decodes. Kept beside the request so the two can never
// drift apart.
export const SNAPSHOT_COMPUTED_STYLES = ['display', 'visibility'] as const;

// Same-document freshness evidence (docs/vision.md §Freshness). The document's
// mutation stream is counted in an ISOLATED world, deliberately NOT the way
// act.ts's per-act counter does it: that one lives in the main world, so the site
// can read or forge it, and it dies with the document on every navigation. This
// one is installed by the browser into a fresh isolated world at document start,
// for every document, forever.
// The reading is an OPAQUE token — an install nonce plus a batch count — compared
// for EQUALITY only, never arithmetic: a new document restarts the count, and a
// count that happens to land on its old value under a new nonce must still read
// as changed.

// on `document` sees the whole light DOM and nothing inside a shadow root. Arming
// shadow roots as they are added does not fix it — attachShadow happens after the
// host element is inserted and emits no record of its own, and closed roots are
// unreachable from any world by construction. The graph says so instead: a
// document holding shadow content is never vouched for (see WirGraph.mutationObservable).
const FRESHNESS_WORLD = 'wir_freshness';
const FRESHNESS_SOURCE = `(() => {
  const state = { id: Date.now().toString(36) + Math.random().toString(36).slice(2), n: 0 };
  globalThis.__wirFreshness = state;
  new MutationObserver(records => { state.n += records.length; })
    .observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
})();`;
const FRESHNESS_EXPRESSION =
  'globalThis.__wirFreshness ? globalThis.__wirFreshness.id + ":" + globalThis.__wirFreshness.n : null';

export interface AXNodeRaw {
  nodeId: string;
  ignored: boolean;
  // The tree's own links. Declared for the nodes DOMSnapshot does not carry
  // (RawFacts.axOnly), whose only parent chain IS the AX tree: a `::scroll-marker`
  // hangs beneath a `::scroll-marker-group`, which hangs beneath the carousel
  // element, and none of that is in the DOM parentIndex array.
  parentId?: string;
  childIds?: string[];
  role?: { value?: string };
  name?: { value?: string };
  // The accessible DESCRIPTION, computed by the browser beside the name. It is
  // where a `title` lands on an element ARIA forbids naming: Page Builder's
  // exit control is `<i title="Close Full Screen">` — role generic, name "",
  // description "Close Full Screen" — and with only `name` declared here the

  // blocked_by_overlay while the model hunted for the exit).
  description?: { value?: string };
  // The browser's own current value. `getFullAXTree` has always returned it;
  // declaring it is the whole plumbing change. It is the only source for a
  // <select>'s value — DOMSnapshot's `inputValue` covers INPUT elements only.
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  // The payload has always carried these; only this interface hid them, so the
  // compiler could not see a state the executor rejects on. Declaring the array
  // is the whole plumbing change — `getFullAXTree` already returns it, and no
  // extra CDP call is involved. `disabled` is decoded today because act refuses
  // on it; `description`, `value` and the rest are now reachable for whatever
  // failing request proves it needs them.
  properties?: { name: string; value?: { value?: unknown } }[];
}

// A browser decision the model would otherwise never see (defect C3: with no
// listener Playwright dismisses every dialog invisibly — a hidden limit in the
// kill-criterion sense).
export interface BrowserEvent {
  kind: 'dialog' | 'popup' | 'download';
  action: 'dismissed' | 'accepted' | 'observed';
  description: string;
}

export interface DocumentLedger {
  servedUrl: string;
  servedLoaderId: string;
  /** documents served to this tab since it was wired — monotonic, so a
   *  consumer can tell "a new document arrived" without comparing URLs (a
   *  same-URL reload is a new document too). */
  loads: number;
  routesSinceServed: number;
  lastRoute: 'fragment' | 'historyApi' | 'other' | null;
}

const emptyLedger = (): DocumentLedger => ({
  servedUrl: '',
  servedLoaderId: '',
  loads: 0,
  routesSinceServed: 0,
  lastRoute: null,
});

// What this host may tear down at close(): a launched browser is fully ours; an
// attached one lends us a page; an external page lends us only a CDP session.
type Ownership = 'launched' | 'attached' | 'external';

// ONE BROWSER CONTEXT PER DECLARED ORIGIN.
//
// A tab is a context, its one page, the raw CDP session on that page, and the
// document identity of what the page currently holds. The host keeps one tab per
// origin the runner declared a storage state for, plus a DEFAULT tab for every
// other origin, and routes each top-level navigation to the tab of its origin.
//

// both PHP and both name their session cookie PHPSESSID. Cookies key on

// cannot coexist in one cookie jar — whichever is seeded second overwrites the

// cookie jar of its own, so a jar per origin is the fix at the layer the defect
// lives in; nothing about the host name has to change.
//
// The default tab is what every host had before this: one context seeded with
// `storageStatePath`. A caller that declares no per-origin state gets exactly
// that and nothing else — one context, one HAR, one trace, byte-identical.
interface Tab {
  /** The origin this tab is dedicated to; null for the default tab. */
  readonly origin: string | null;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdp: CDPSession;
  epoch: string;
  mainFrameId: string;
  /** This page's served-versus-shown record (DocumentLedger): which document
   *  its main frame last loaded and how far the address has moved since. */
  ledger: DocumentLedger;
  /** Where this context's HAR is being recorded (a part file when several
   *  contexts record, merged into the caller's path at close). */
  readonly harPath: string | null;
  readonly tracePath: string | null;
}

export interface LaunchOptions {
  headless: boolean;
  /** The state every origin WITHOUT a dedicated entry in `storageStates` is
   *  seeded with — the single-jar behaviour every existing run has. */
  storageStatePath?: string | null;
  /** origin -> Playwright storage state path. Each named origin gets its OWN
   *  browser context (cookie jar, storage), seeded from its own capture, and
   *  every top-level navigation to that origin lands in that context. Declared
   *  by the RUNNER, which knows which origins carry a session; the runtime
   *  does not guess. Keys are normalised through `new URL(k).origin`. */
  storageStates?: Readonly<Record<string, string>> | null;
  harPath?: string | null;
  tracePath?: string | null;
  debugScreenshots?: boolean;

  allowedOrigins?: readonly string[];
  /** Live admission test, used instead of the fixed set when the runner chose
   *  `originPolicy: 'observed'`. It reads the session's own observed origins, so
   *  the route filter and the `navigate` closure answer one question once. */
  originAdmits?: (origin: string) => boolean;
}

export class WirHost {
  private constructor(
    readonly browser: Browser | null,
    private readonly ownership: Ownership,
    private readonly launchOpts: LaunchOptions | null,
  ) {}

  private tabs: Tab[] = [];
  private byOrigin = new Map<string, Tab>();
  private activeTab: Tab | null = null;
  private epochListeners: (() => void)[] = [];
  private servedListeners: (() => void)[] = [];

  /** The page the runtime is currently reading and acting on. Follows the
   *  active tab: after a navigation to another declared origin this is a
   *  DIFFERENT Playwright page, so hold the host, not the page. */
  get page(): Page {
    return this.active.page;
  }
  /** The raw CDP session on `page`. Same caveat. */
  get cdp(): CDPSession {
    return this.active.cdp;
  }
  private get active(): Tab {
    if (this.activeTab === null) throw new Error('WirHost has no page yet');
    return this.activeTab;
  }

  /** Off-origin navigations refused this episode. Debug-plane only.
   *  Populated by the route installed in `openTab`. */
  blockedNavigations: string[] = [];
  /** Top-level navigations moved from one context to another because their
   *  origin has its own tab. Debug-plane only: `<from-origin> -> <url>`. */
  divertedNavigations: string[] = [];

  static async launch(opts: LaunchOptions): Promise<WirHost> {
    const browser = await chromium.launch({ headless: opts.headless });
    const host = new WirHost(browser, 'launched', opts);
    host.tracePath = opts.tracePath ?? null;
    // Dedicated tabs are opened EAGERLY, before the default one, so that the
    // route filter can hand a navigation to its tab synchronously — a tab
    // created on demand inside the route would leave the executor watching the
    // wrong page for the act's settle window.
    const declared: { origin: string; path: string }[] = [];
    for (const [key, path] of Object.entries(opts.storageStates ?? {})) {
      let origin: string;
      try {
        origin = new URL(key).origin;
      } catch {
        throw new Error(`storageStates: not an origin: ${key}`);
      }
      if (origin === 'null') throw new Error(`storageStates: opaque origin: ${key}`);
      if (declared.some((d) => d.origin === origin))
        throw new Error(`storageStates: ${origin} declared twice`);
      declared.push({ origin, path });
    }
    const multi = declared.length > 0;
    for (const { origin, path } of declared) {
      host.byOrigin.set(origin, await host.openTab(origin, path, multi));
    }
    const dflt = await host.openTab(null, opts.storageStatePath ?? null, multi);
    host.activeTab = dflt;
    return host;
  }

  // Attach to a browser the caller already runs, over its CDP endpoint. WIR gets
  // its own page in the browser's existing default context; the browser's state
  // (profile, cookies) is the caller's. No HAR and no trace: both are
  // context-creation options and the context is not ours to configure.
  static async attach(opts: { cdpEndpoint: string }): Promise<WirHost> {
    const browser = await chromium.connectOverCDP(opts.cdpEndpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const host = new WirHost(browser, 'attached', null);
    host.activeTab = await host.adopt(null, context, page, cdp, null, null);
    return host;
  }

  // Wrap a Playwright Page the caller already holds. WIR owns only its CDP
  // session; close() detaches and touches nothing else. The dialog listener
  // keeps Playwright's default outcome (dismiss / accept-beforeunload) but makes
  // every decision visible.
  // INVARIANT: WIR must own navigation for a page it is given. Act-fencing rides
  // the loaderId epoch; a caller navigating the same page concurrently can make
  // the epoch stale between revalidation and dispatch, and the fence is then
  // advisory, not proof.
  static async fromPage(page: Page): Promise<WirHost> {
    const cdp = await page.context().newCDPSession(page);
    const host = new WirHost(page.context().browser(), 'external', null);
    host.activeTab = await host.adopt(null, page.context(), page, cdp, null, null);
    return host;
  }

  /** One context + page + CDP session for `origin` (null = the default tab),
   *  seeded from `storageStatePath`. `multi` says several contexts will record,
   *  so HARs go to part files (merged at close) and secondary traces to sibling
   *  files — a single context keeps the caller's paths verbatim. */
  private async openTab(
    origin: string | null,
    storageStatePath: string | null,
    multi: boolean,
  ): Promise<Tab> {
    const opts = this.launchOpts!;
    const index = this.tabs.length;
    const harPath = !opts.harPath ? null : multi ? `${opts.harPath}.${index}.part` : opts.harPath;
    const tracePath = !opts.tracePath
      ? null
      : origin === null
        ? opts.tracePath
        : siblingTrace(opts.tracePath, origin);
    const context = await this.browser!.newContext({
      viewport: { width: 1280, height: 900 },
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
      ...(harPath ? { recordHar: { path: harPath } } : {}),
    });
    if (tracePath) {
      // Debug runs get the filmstrip; clean runs keep traces lean.
      await context.tracing.start({
        screenshots: opts.debugScreenshots === true,
        snapshots: true,
      });
    }
    const page = await context.newPage();
    const allowed = new Set(opts.allowedOrigins ?? []);
    const admits = opts.originAdmits;
    const confined = allowed.size > 0 || admits !== undefined;
    const cdp = await context.newCDPSession(page);
    const tab = await this.adopt(origin, context, page, cdp, harPath, tracePath);
    if (confined || multi) {
      await page.route('**/*', async (route, request) => {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
          return route.continue();
        }
        let target: string;
        try {
          target = new URL(request.url()).origin;
        } catch {
          return route.continue();
        }
        if (confined && !(allowed.has(target) || admits?.(target) === true)) {
          // Aborted, not redirected: the page stays where it was, and the act that
          // caused it reports no navigation — which is true.
          this.blockedNavigations.push(request.url());
          return route.abort('blockedbyclient');
        }
        // ORIGIN ROUTING. A top-level navigation whose origin owns another tab
        // is moved there: this page's request is aborted and the same URL is
        // loaded in the origin's own context, which becomes the active one. The
        // executor reads `page`/`cdp` through the host, so its settle waits on
        // the page that is actually loading and its after-state is read there.
        // Same-origin navigations, and every subresource, pass untouched.
        const owner = this.tabFor(target);
        if (owner !== tab) {
          this.divertedNavigations.push(`${tab.origin ?? 'default'} -> ${request.url()}`);
          this.activate(owner);
          // Not awaited: the route must answer, and the navigation's own
          // settling is the executor's to observe through the active page. A
          // failure lands the target page on Chromium's error document, which
          // the next read reports — the same outcome a direct goto has.
          owner.page
            .goto(request.url(), { waitUntil: 'load' })
            .then(async () => {
              await this.seedEpoch(owner);
            })
            .catch((e: unknown) => {
              process.stderr.write(
                `[host] diverted navigation to ${request.url()} failed: ${String(e)}\n`,
              );
            });
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
    }
    return tab;
  }

  /** Which tab owns navigations to `origin`. */
  private tabFor(origin: string): Tab {
    return this.byOrigin.get(origin) ?? this.tabs.find((t) => t.origin === null) ?? this.active;
  }

  /** Make `tab` the one `page`/`cdp`/`currentEpoch` answer for. From the
   *  caller's side a switch IS a document replacement — a different document is
   *  now in view — so the epoch listeners fire exactly as on navigation. */
  private activate(tab: Tab): void {
    if (this.activeTab === tab) return;
    const before = this.activeTab?.epoch;
    const servedBefore = this.activeTab?.ledger.servedLoaderId;
    this.activeTab = tab;
    if (before !== tab.epoch) for (const l of this.epochListeners) l();
    // The same reasoning for the ledger: the document the caller now stands
    // on was served to THIS tab, and its consumers pin "served" to now.
    if (servedBefore !== tab.ledger.servedLoaderId) for (const l of this.servedListeners) l();
  }

  // Shared wiring for every entry path — one code path, whoever owns the browser.
  private async adopt(
    origin: string | null,
    context: BrowserContext,
    page: Page,
    cdp: CDPSession,
    harPath: string | null,
    tracePath: string | null,
  ): Promise<Tab> {
    const tab: Tab = {
      origin,
      context,
      page,
      cdp,
      epoch: '',
      mainFrameId: '',
      ledger: emptyLedger(),
      harPath,
      tracePath,
    };
    // Defect C3: with no handlers, dialogs are auto-dismissed (confirm -> Cancel,
    // chosen for the model, invisibly), beforeunload auto-accepted, downloads
    // vanish into a temp dir, popups run unobserved. The POLICY here is identical
    // to those defaults — nothing new is decided — but every decision is recorded
    // and surfaced through the next act result. Handled via Playwright, never raw
    // CDP: a raw Page.javascriptDialogOpening handler races Playwright's own
    // DialogManager (kb: playwright crPage.ts:419).
    page.on('dialog', (dialog) => {
      const accept = dialog.type() === 'beforeunload';
      this.pushBrowserEvent({
        kind: 'dialog',
        action: accept ? 'accepted' : 'dismissed',
        description: `${dialog.type()}(${JSON.stringify(dialog.message()).slice(0, 120)}) ${accept ? 'accepted' : 'dismissed'} by policy`,
      });
      // The handler must always answer, or every later act on this page stalls.
      (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    context.on('page', (popup) => {
      if (popup === page) return;
      this.pushBrowserEvent({
        kind: 'popup',
        action: 'observed',
        description: `popup opened (${popup.url() || 'url pending'}); WIR stays on the main page`,
      });
    });
    page.on('download', (download) => {
      this.pushBrowserEvent({
        kind: 'download',
        action: 'observed',
        description: `download started: ${download.suggestedFilename()} — not saved, deleted when the browser closes`,
      });
    });
    await cdp.send('Page.enable');
    // Epoch protocol (ADR-002): frameNavigated on the main frame proves replacement;
    // navigatedWithinDocument never does; documentUpdated invalidates unconditionally.
    cdp.on(
      'Page.frameNavigated',
      (ev: { frame: { id: string; loaderId: string; url: string; parentId?: string } }) => {
        if (!ev.frame.parentId) {
          tab.mainFrameId = ev.frame.id;
          this.noteServed(tab, ev.frame.loaderId, ev.frame.url);
          this.setEpoch(tab, ev.frame.loaderId);
        }
      },
    );
    // A same-document navigation moves the address and serves nothing. The
    // epoch does not move (ADR-002); this tab's ledger counts it and names its
    // kind. Keyed on THIS tab's main frame: every tab has its own session and
    // its own frame ids, so a parked tab's routes never land on the active one.
    cdp.on(
      'Page.navigatedWithinDocument',
      (ev: {
        frameId: string;
        url: string;
        navigationType: 'fragment' | 'historyApi' | 'other';
      }) => {
        if (ev.frameId !== tab.mainFrameId) return;
        tab.ledger.routesSinceServed += 1;
        tab.ledger.lastRoute = ev.navigationType;
      },
    );
    cdp.on('DOM.documentUpdated', () => this.setEpoch(tab, `${tab.epoch}!invalidated`));
    // runImmediately: an attached/external page already holds a document, and a
    // counter that only starts at the next navigation is a counter that reads
    // "nothing changed" over a page it never watched. Best-effort by design: if
    // the install fails, mutationToken() returns null and the session recompiles
    // every call — degraded and loud, never silently optimistic.
    try {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: FRESHNESS_SOURCE,
        worldName: FRESHNESS_WORLD,
        runImmediately: true,
      });
    } catch (e) {
      process.stderr.write(
        `[host] freshness counter not installed (${String(e)}); every call will recompile\n`,
      );
    }
    // An attached/external page may already hold a document — seed the epoch so
    // the first capture has an identity even when goto() is never called.
    await this.seedEpoch(tab);
    this.tabs.push(tab);
    return tab;
  }

  /** Read the authoritative document identity from the frame tree. */
  private async seedEpoch(tab: Tab): Promise<void> {
    const tree = (await tab.cdp.send('Page.getFrameTree')) as {
      frameTree: { frame: { id: string; loaderId: string; url: string } };
    };
    tab.mainFrameId = tree.frameTree.frame.id;
    this.noteServed(tab, tree.frameTree.frame.loaderId, tree.frameTree.frame.url);
    this.setEpoch(tab, tree.frameTree.frame.loaderId);
  }

  // One loader, one served document. Keyed on the loaderId, exactly like the
  // epoch, so the frameNavigated listener and the frame-tree re-read in
  // seedEpoch (which exists for the first-goto race) cannot count one document
  // twice. Per tab, and only the ACTIVE tab's arrivals reach the listeners — a
  // parked tab's new document is delivered when it is activated (see activate).
  private noteServed(tab: Tab, loaderId: string, url: string): void {
    if (loaderId === tab.ledger.servedLoaderId) return;
    tab.ledger = {
      servedUrl: url,
      servedLoaderId: loaderId,
      loads: tab.ledger.loads + 1,
      routesSinceServed: 0,
      lastRoute: null,
    };
    if (tab === this.activeTab) for (const l of this.servedListeners) l();
  }

  /** The ACTIVE tab's navigation ledger, as of now. A copy: the host's record
   *  is its own. Empty (no document) before any tab exists. */
  documentLedger(): DocumentLedger {
    return this.activeTab === null ? emptyLedger() : { ...this.activeTab.ledger };
  }

  /** Fires once per document the site serves to the tab in view (per new
   *  main-frame loaderId), and when a switch brings another tab's document
   *  into view. */
  onDocumentServed(l: () => void): void {
    this.servedListeners.push(l);
  }

  /** The document's mutation-stream reading, or null when the runtime cannot read
   *  it. Null is not "unchanged": the caller must treat it as changed. Costs one
   *  round trip (~0.3ms measured over 20 sequential reads). */
  async mutationToken(required: readonly string[] = []): Promise<string | null> {
    const tab = this.active;
    if (tab.mainFrameId === '') return null;
    // Read EVERY frame in the tree, not just the main one. The observer already
    // runs in all of them — addScriptToEvaluateOnNewDocument is installed with no
    // frameId, so every document created in this target has its own state — and
    // only the read was narrow.
    //
    // The scope is the FRAME TREE, never the caller's graph. Scoping it to the
    // graph made the first reading (taken when no graph exists yet) main-only and
    // every later one composite, so no two readings ever compared equal and the
    // cache was dead. Measured, by the regression that pins the vouch still works.
    const ids = await this.frameIds(tab);
    const readings = await Promise.all(
      ids.map(async (frameId) => {
        const one = await this.frameToken(tab, frameId);
        return { frameId, one };
      }),
    );
    const answered = readings.filter((r) => r.one !== null);
    // The main frame is non-negotiable: unreadable means unvouchable.
    if (!answered.some((r) => r.frameId === tab.mainFrameId)) return null;
    // A frame whose content the CALLER'S GRAPH holds must have answered. An
    // out-of-process frame contributes nothing and is reported as a coverage gap,
    // so its silence is expected and must not force a recompile on every page
    // carrying an ad; a same-process frame that is in the graph and has gone
    // quiet is exactly the stale-content case, and must.
    const answeredIds = new Set(answered.map((r) => r.frameId));
    if (required.some((f) => f !== '' && !answeredIds.has(f))) return null;
    // Frame-set membership is INSIDE the token: a frame appearing or vanishing
    // between two readings must not compare equal to the previous one, or the
    // vouch would survive exactly the change it exists to catch.
    return answered
      .map((r) => `${r.frameId}=${r.one!}`)
      .sort()
      .join('|');
  }

  /** Every frame in the page's tree, main first. */
  private async frameIds(tab: Tab): Promise<string[]> {
    try {
      const tree = (await tab.cdp.send('Page.getFrameTree')) as {
        frameTree: { frame: { id: string }; childFrames?: unknown[] };
      };
      const out: string[] = [];
      const walk = (t: { frame: { id: string }; childFrames?: unknown[] }): void => {
        out.push(t.frame.id);
        for (const c of t.childFrames ?? []) {
          walk(c as { frame: { id: string }; childFrames?: unknown[] });
        }
      };
      walk(tree.frameTree);
      return out;
    } catch {
      return [tab.mainFrameId];
    }
  }

  private async frameToken(tab: Tab, frameId: string): Promise<string | null> {
    try {
      // createIsolatedWorld is idempotent by name: it returns the context of the
      // world addScriptToEvaluateOnNewDocument already created for this document,
      // with its state intact (measured — same contextId and a rising count across
      // reads; a new id and a restarted count after navigation).
      const world = (await tab.cdp.send('Page.createIsolatedWorld', {
        frameId,
        worldName: FRESHNESS_WORLD,
      })) as { executionContextId: number };
      const evaluated = (await tab.cdp.send('Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: FRESHNESS_EXPRESSION,
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: unknown } };
      const value = evaluated.result?.value;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  // Per tab. Only the ACTIVE tab's document is the one in view, so only its
  // changes reach the listeners; a parked tab's new identity is delivered when
  // it is activated again (every activation replaces its document anyway).
  private setEpoch(tab: Tab, next: string): void {
    if (next === tab.epoch) return;
    tab.epoch = next;
    if (tab === this.activeTab) for (const l of this.epochListeners) l();
  }

  onEpochChange(l: () => void): void {
    this.epochListeners.push(l);
  }

  currentEpoch(): string {
    return this.activeTab?.epoch ?? '';
  }

  private browserEvents: BrowserEvent[] = [];
  pushBrowserEvent(event: BrowserEvent): void {
    this.browserEvents.push(event);
  }
  drainBrowserEvents(): BrowserEvent[] {
    const events = this.browserEvents;
    this.browserEvents = [];
    return events;
  }

  async goto(url: string): Promise<void> {
    // The tab is chosen BEFORE the navigation, by origin, so a declared origin's
    // own context does the loading and its cookies go on the wire. Choosing it
    // here rather than letting the route divert keeps goto's promise attached to
    // the navigation that actually happens.
    let tab = this.active;
    if (this.ownership === 'launched') {
      try {
        tab = this.tabFor(new URL(url).origin);
      } catch {
        /* not a URL; the page decides */
      }
    }
    // ARRIVE LIKE A LINK. A person reaching an address from a page arrives with
    // that page as Referer; a bare goto arrives with none, and every server- or
    // grader-side reading of Referer then sees a difference nothing in the
    // transcript explains. The document the caller stands on is the ACTIVE
    // tab's served document, read before any tab switch; the first goto of an
    // episode has none and stays referer-less.
    const referer = this.activeTab?.ledger.servedUrl ?? '';
    this.activate(tab);
    // 'load', not 'networkidle' (deprecated guidance) and not 'domcontentloaded'
    // (stylesheets may not be applied — hidden elements measure as visible; a real
    // divergence caught by the M1 oracle comparison).
    await tab.page.goto(url, { waitUntil: 'load', ...(referer !== '' ? { referer } : {}) });
    // frameNavigated may have fired before our listener in a race on first goto;
    // read the authoritative value from the frame tree.
    await this.seedEpoch(tab);
  }

  // The census acquisition: one bulk snapshot + one AX pull, joined downstream by
  // backendNodeId. Accessibility.enable stays OFF (per-pull reads; decision recorded
  // in implementation.md — revisit only on measured need).
  async captureFacts(): Promise<RawFacts> {
    const tab = this.active;
    const epochBefore = this.currentEpoch();
    const snapshot = (await tab.cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [...SNAPSHOT_COMPUTED_STYLES],
      // ON, for scrollRects/clientRects — the only signal that says WHICH region
      // scrolls. Cost measured before enabling, on the pages this runs against.
      includeDOMRects: true,
    })) as unknown as SnapshotDoc;
    const ax = await this.captureAxAllFrames(tab, snapshot);
    const axOnly = await this.captureAxOnly(tab, snapshot, ax);
    const topLayer = await this.captureTopLayer(tab);
    const epochAfter = this.currentEpoch();
    if (epochBefore !== epochAfter) {
      // The world moved mid-census; the caller recompiles. Never mix versions.
      throw new EpochChangedError(epochBefore, epochAfter);
    }
    return { epoch: epochAfter, url: tab.page.url(), snapshot, ax, axOnly, topLayer };
  }

  // The top layer, by backendNodeId. `DOM.getTopLayerElements` answers only
  // once the DOM agent has handed out a document (measured: `DOM.enable` alone
  // returns [], `DOM.getDocument` at depth 0 costs ~2 ms and makes it answer),
  // and its list carries each element's `::backdrop` pseudo beside it — the
  // pseudo is dropped here, since it is nobody's control. Any failure reads as
  // "none": the top layer is disclosure, and a census must never die on it.
  private async captureTopLayer(tab: Tab): Promise<TopLayerIds> {
    try {
      await tab.cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeIds } = (await tab.cdp.send('DOM.getTopLayerElements')) as { nodeIds: number[] };
      const ids: number[] = [];
      for (const nodeId of nodeIds) {
        const { node } = (await tab.cdp.send('DOM.describeNode', { nodeId })) as {
          node: { nodeType: number; backendNodeId: number; pseudoType?: string };
        };
        if (node.nodeType === 1 && node.pseudoType === undefined) ids.push(node.backendNodeId);
      }
      return ids;
    } catch {
      return [];
    }
  }

  // The join gap, measured rather than assumed: every non-ignored AX node whose
  // backend id no document in the snapshot carries, asked of the DOM domain
  // directly — on the session of the tab that took the snapshot, since backend
  // ids are meaningful only to the target that minted them. On an ordinary page
  // this is zero nodes and zero round trips; on a CSS-carousel page it is one
  // describeNode + one getBoxModel per pseudo-element control (8 on the
  // measured page), in parallel.
  //
  // A node that vanished between the two captures (describeNode throws) is
  // simply not reported — the AX tree that named it is already stale, and the
  // epoch fence around this capture is the caller's guard. A node with no box
  // is reported with bounds null, so the compiler, not this layer, decides what
  // "unrendered" means.
  private async captureAxOnly(
    tab: Tab,
    snapshot: SnapshotDoc,
    ax: AXNodeRaw[],
  ): Promise<AxOnlyNode[]> {
    const inSnapshot = new Set<number>();
    for (const d of snapshot.documents) for (const id of d.nodes.backendNodeId) inSnapshot.add(id);
    const missing: number[] = [];
    for (const a of ax) {
      const id = a.backendDOMNodeId;
      if (a.ignored || id === undefined || inSnapshot.has(id) || missing.includes(id)) continue;
      missing.push(id);
    }
    if (missing.length === 0) return [];
    // Snapshot layout bounds are document coordinates; getBoxModel answers in
    // viewport coordinates. Shift by the main document's scroll offset so the
    // two geometries a caller compares are in the same space. Projection only —
    // `act` resolves its own hit point through getContentQuads at dispatch.
    const main = snapshot.documents[0];
    const sx = main?.scrollOffsetX ?? 0,
      sy = main?.scrollOffsetY ?? 0;
    const out = await Promise.all(
      missing.map(async (backendNodeId): Promise<AxOnlyNode | null> => {
        let nodeName = '',
          pseudoType = '';
        try {
          const d = (await tab.cdp.send('DOM.describeNode', { backendNodeId })) as {
            node: { nodeName?: string; pseudoType?: string };
          };
          nodeName = d.node.nodeName ?? '';
          pseudoType = d.node.pseudoType ?? '';
        } catch {
          return null;
        }
        let bounds: AxOnlyNode['bounds'] = null;
        try {
          const { model } = (await tab.cdp.send('DOM.getBoxModel', { backendNodeId })) as {
            model: { border: number[] };
          };
          const q = model.border;
          if (q.length >= 8) {
            const xs = [q[0]!, q[2]!, q[4]!, q[6]!],
              ys = [q[1]!, q[3]!, q[5]!, q[7]!];
            const x = Math.min(...xs),
              y = Math.min(...ys);
            bounds = [x + sx, y + sy, Math.max(...xs) - x, Math.max(...ys) - y];
          }
        } catch {
          /* no box: unrendered, reported as such */
        }
        return { backendNodeId, nodeName, pseudoType, bounds };
      }),
    );
    return out.filter((n): n is AxOnlyNode => n !== null);
  }

  // One AX tree per document in the snapshot. getFullAXTree answers for a single
  // frame, so an iframe's nodes arrive with DOM structure and no roles or names
  // unless its own frame is asked. backendNodeIds are unique browser-wide, so the
  // trees concatenate and the downstream join needs no disambiguation.
  //
  // A frame that refuses (cross-origin/out-of-process, or destroyed mid-census)
  // is skipped, not fatal: its document then compiles to nothing and remains a
  // typed coverage gap, which is the honest outcome — the alternative is losing
  // the whole page because one ad iframe went away.
  private async captureAxAllFrames(tab: Tab, snapshot: SnapshotDoc): Promise<AXNodeRaw[]> {
    const out: AXNodeRaw[] = [];
    const seen = new Set<string>();
    for (const doc of snapshot.documents) {
      const frameId = doc.frameId === undefined ? '' : (snapshot.strings[doc.frameId] ?? '');
      if (frameId !== '' && seen.has(frameId)) continue;
      if (frameId !== '') seen.add(frameId);
      try {
        const res = (await tab.cdp.send(
          'Accessibility.getFullAXTree',
          frameId === '' ? {} : { frameId },
        )) as unknown as { nodes: AXNodeRaw[] };
        out.push(...res.nodes);
      } catch {
        /* frame not reachable from this session; its gap stands */
      }
    }
    return out;
  }

  async close(): Promise<void> {
    // Close only what we own: a launched browser is fully ours; attach lent us a
    // page; fromPage lent us only a CDP session. Killing a browser the caller
    // runs would be the runtime deciding for its embedder.
    // Artifacts are best-effort: the episode's outcome is already decided by the
    // time we get here, so cleanup must never outlive its budget. Proven defect:
    // This behavior was verified during testing.
    // 15 minutes until the harness reaped it — an infrastructure exclusion on an
    // episode that had already succeeded.
    const withTimeout = async (label: string, p: Promise<unknown>, ms: number): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          p.catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              process.stderr.write(`[host] ${label} exceeded ${ms}ms; abandoning artifact\n`);
              resolve();
            }, ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    // THE FINAL STATE, BEFORE ANYTHING IS TORN DOWN.
    //
    // An episode used to leave no independently readable record of how the page
    // ENDED. Everything after the fact came from the trajectory — which records
    // This behavior was verified during testing.
    // that cost three wrong reports in one session: a run that reached 9 was
    // reported as 1, because the agent stopped re-reading the score at call 27
    // and the trajectory froze there while the page kept climbing. The Playwright
    // trace could not settle it either: snapshots store the DOM as nodes, so text
    // split across elements ("Score:" · "9" · "/ 17") never appears as a string.
    //
    // innerText is the right reading precisely because it CONCATENATES what the
    // separate nodes render — it is what a person looking at the screen sees.
    //
    // Debug plane only. Written when the runner asks for it, never exposed to the
    // model, and best-effort like every other artifact here: an episode's outcome
    // is already decided by the time we reach close(), so this must never be the
    // reason a finished run is reaped.
    if (this.finalStatePath && this.activeTab !== null) {
      const page = this.activeTab.page;
      await withTimeout(
        'final-state',
        (async () => {
          const seen = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            text: document.body?.innerText ?? '',
          }));
          writeFileSync(
            this.finalStatePath as string,
            JSON.stringify({ ...seen, capturedAt: new Date().toISOString() }, null, 1),
          );
        })(),
        5_000,
      );
    }
    // Detach our raw CDP sessions FIRST: an attached session keeps the context
    // This behavior was verified during testing.
    for (const tab of this.tabs) await withTimeout('cdp.detach', tab.cdp.detach(), 5_000);
    if (this.ownership === 'external') return;
    if (this.ownership === 'attached') {
      for (const tab of this.tabs) await withTimeout('page.close', tab.page.close(), 10_000);
      return;
    }
    for (const tab of this.tabs) {
      // context.close flushes the HAR; tracing.stop writes the trace.
      if (tab.tracePath) {
        await withTimeout(
          'tracing.stop',
          tab.context.tracing.stop({ path: tab.tracePath }),
          20_000,
        );
      }
      // Close the page before the context: an open page with in-flight requests
      // makes the HAR flush wait on them. A minimal repro that closed the page
      // first finished in 4 ms; the agent, which did not, blocked past 15 minutes.
      await withTimeout('page.close', tab.page.close(), 10_000);
      await withTimeout('context.close', tab.context.close(), 20_000);
    }
    // Several contexts recorded: fold their HARs into the one file the caller
    // named. Every entry says which context carried it.
    const harPath = this.launchOpts?.harPath ?? null;
    if (harPath && this.tabs.some((t) => t.harPath !== null && t.harPath !== harPath)) {
      await withTimeout(
        'har.merge',
        (async () =>
          mergeHars(
            harPath,
            this.tabs
              .filter((t) => t.harPath !== null)
              .map((t) => ({ path: t.harPath!, context: t.origin ?? 'default' })),
          ))(),
        20_000,
      );
    }
    if (this.browser) {
      await withTimeout('browser.close', this.browser.close(), 10_000);
      // Whatever survived the races, the process must be able to exit.
      await this.browser.close().catch(() => undefined);
    }
  }
  tracePath: string | null = null;
  /** Where to write the page's final rendered state on close, or null. Debug
   *  plane: the one record of what the world BECAME, independent of what the
   *  agent looked at. */
  finalStatePath: string | null = null;
}

function siblingTrace(tracePath: string, origin: string): string {
  const slug = origin.replace(/^[a-z]+:\/\//, '').replace(/[^A-Za-z0-9]+/g, '_');
  const m = /^(.*)(\.[A-Za-z0-9]+)$/.exec(tracePath);
  return m ? `${m[1]}.${slug}${m[2]}` : `${tracePath}.${slug}`;
}

// One HAR from several. Playwright numbers pages per context (`page_0`, …), so
// pagerefs are prefixed with the part index to keep them distinct; entries are
// ordered by start time and each carries `_wirContext`, the origin of the
// context that sent it (HAR permits `_`-prefixed custom fields). Part files
// are removed once the merged file is written; a part that fails to parse is
// left in place and reported, never silently dropped.
function mergeHars(outPath: string, parts: { path: string; context: string }[]): void {
  type Har = {
    log: {
      pages?: { id: string }[];
      entries: { pageref?: string; startedDateTime: string }[];
      [k: string]: unknown;
    };
  };
  let base: Har | null = null;
  const pages: unknown[] = [];
  const entries: { pageref?: string; startedDateTime: string; _wirContext?: string }[] = [];
  const consumed: string[] = [];
  for (const [i, part] of parts.entries()) {
    let har: Har;
    try {
      har = JSON.parse(readFileSync(part.path, 'utf8')) as Har;
    } catch (e) {
      process.stderr.write(
        `[host] HAR part ${part.path} unreadable (${String(e)}); left in place\n`,
      );
      continue;
    }
    if (base === null) base = har;
    for (const p of har.log.pages ?? []) pages.push({ ...p, id: `${i}:${p.id}` });
    for (const e of har.log.entries) {
      entries.push({
        ...e,
        ...(e.pageref !== undefined ? { pageref: `${i}:${e.pageref}` } : {}),
        _wirContext: part.context,
      });
    }
    consumed.push(part.path);
  }
  if (base === null) return;
  entries.sort((a, b) =>
    a.startedDateTime < b.startedDateTime ? -1 : a.startedDateTime > b.startedDateTime ? 1 : 0,
  );
  const merged = { log: { ...base.log, pages, entries } };
  writeFileSync(outPath, JSON.stringify(merged));
  for (const p of consumed) {
    try {
      unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
}

export class EpochChangedError extends Error {
  constructor(
    readonly before: string,
    readonly after: string,
  ) {
    super(`document epoch changed during capture: ${before} -> ${after}`);
  }
}
