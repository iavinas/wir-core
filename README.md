# WIR Core

WIR Core is a TypeScript runtime for browser agents. It turns a live browser page into a structural interface graph and provides a small, typed interaction surface for working with that graph.

## What it provides

- Captures browser state through Playwright and compiles it into nodes, relationships, collections, headings, and page metadata.
- Resolves page content with `find` and `read`, including bounded results and continuations for larger pages.
- Performs browser actions through `act`: click, fill, select, type, key, upload, scroll, and hover.
- Revalidates targets before actions and reports delivery, effect evidence, receipts, and rejections.
- Supports navigation, mutation tracking, freshness information, and finish-state evidence.
- Exposes tool definitions and TypeScript types for integrating the runtime into an agent loop.

## Install

The package is not currently published to npm.

From the parent repository, install the local workspace dependency:

```bash
npm install
```

From another local project, install the package by path:

```bash
npm install /path/to/wir-public/wir-core
```

WIR Core requires Node.js 22 or newer. Playwright is used for browser access.

## Basic usage

```ts
import { WirSession } from '@wir/core';

const session = await WirSession.start({
  headless: true,
  expectedAction: 'RETRIEVE',
});

try {
  await session.goto('https://example.com');

  const page = await session.dispatch({ verb: 'read' });
  const links = await session.dispatch({ verb: 'find', role: 'link' });

  console.log(page, links);
} finally {
  await session.close();
}
```

The main session entry points are `WirSession.start`, `WirSession.attach`, and `WirSession.fromPage`. Requests are sent through `session.dispatch` using the core verbs:

```text
read       inspect the current page or a graph node
find       locate nodes by name, role, state, or scope
act        interact with a resolved node
navigate   load a URL
finish     report the final answer and evidence
```

For lower-level integration, the package also exports `WirHost`, `compile`, `ActExecutor`, the read and find functions, tool schemas, and the graph, request, receipt, and effect types.

## Development

```bash
npm install
npm run check
```

`npm run check` verifies formatting, linting, the TypeScript build, and tests.
