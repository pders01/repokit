# @jpahd/commits-core

Private/unpublished, MIT-licensed, DOM-free commit-reading contracts, state and
bounded patch helpers. Node.js 22+ and modern browsers can consume unbundled ES2022 ESM
and declarations. There are **no runtime or peer dependencies**.

## Compiled public entries

- `@jpahd/commits-core/contracts`: plain `CommitEntry`/`ChangedFile` data,
  provider/scope/location/intent contracts, safe error categories, limits,
  location serialization, patch display clipping and structured-work preflight.
- `@jpahd/commits-core/state`: `CommitsReaderState` and `ReaderSnapshot`.
- `@jpahd/commits-core`: both entries, still headless and side-effect-free.

```js
import { CommitsReaderState } from '@jpahd/commits-core/state';

// provider is supplied by the host; it can be native Node, HTTP or in-memory.
const reader = new CommitsReaderState(() => renderSnapshot(reader.snapshot));
reader.configure(provider, { ref: 'refs/heads/main' });
// Later: reader.more(), reader.retry(), reader.retryDetail(), reader.refresh().
// Release all outstanding reads when the consumer disconnects:
reader.detach();
```

`configure()` starts finite reads; the host owns navigation and passes new
locations back in. State instances do not share caches or selections. Exact full
SHA-1/SHA-256 IDs pin pagination and independent detail; refresh explicitly
re-resolves a symbolic ref. Scope checks, cancellation fences, finite local
waits, immutable snapshots, page/row/ref/patch bounds, safe failures and explicit
retries define the reader behavior. Reconnect with `attach()` and
`configure()`; unfinished reads restart, accepted pins remain stable.

`CommitEntry.authorTime` is bigint seconds since the Unix epoch. Plain data shapes
are structurally compatible with Chatworks host data and git-chat wire values;
they do not import either. Received data are cloned/frozen by state validation.
`CommitsIntentDetail` describes UI-to-host intent only: it grants no navigation,
agent, execution or mutation authority. Node users need not use UI intents.

Patch presentation is bounded separately from retained raw text. Completeness,
explicit emptiness and missing text remain distinct; helpers never parse backend
prose to certify completeness. Abort/deadline settlement does not prove remote
work was canceled. Browsers need standard URL, encoding and Abort APIs; Node
provides these without a DOM shim.

## Build and verify

From this package directory, with development dependencies supplied by the npm
workspace:

```sh
npm run build
npm run check
npm test
npm run check:package
```

`check:package` checks archive integrity and module/declaration closure. The
workspace's `test:packed` checks consumption of the actual archives. See
[workspace commands](../../README.md#build-and-verify).

The rendered `<portable-commits-reader>` belongs to Chatworks at
`@jpahd/chatworks/commits-reader`; provider adapters live separately in
`@jpahd/commits-adapters`. git-chat remains an optional backend, not the owner of
headless state or browser UI.
