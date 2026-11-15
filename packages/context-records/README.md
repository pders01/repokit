# @jpahd/context-records

Private/unpublished, MIT-licensed ESM for source-linked context, with no runtime
dependencies. Hosts supply records and decide when context is shown or sent;
the package does not collect or inject it automatically.

## Exports

- `@jpahd/context-records` — all public exports.
- `/sources` — source/record types, structural input constructors, stable keys,
  linked statements and search text.
- `/inputs` — minimum host-independent constructor input types.
- `/policy` — canonical/derived/observed authority checks and display policy.
- `/aggregation` — source grouping, chronology and explicit supersession.
- `/prompt` — explicit selection, citation identity and bounded prompt drafts.

```js
import {
  documentContext, contextSourceKey, buildContextPromptDraft,
} from '@jpahd/context-records';

const record = documentContext({
  authority: 'canonical', path: 'docs/design.md', objectId: 'verified-blob-id',
  title: 'Design', preview: 'The host supplies verified source text.',
});
const draft = buildContextPromptDraft([record], {
  selectedSourceKeys: [contextSourceKey(record.source)], maxTokens: 4096,
});
```

These are trusted typed inputs, not an untrusted JSON parser or Git verifier.
Hosts must establish that canonical documents and commits really identify their
sources. Policy checks reject mismatched category/provenance, not forged contents.
The host is also responsible for freshness and authorization.

Canonical and observed changes remain in chronology; newer derived summaries may
supersede older summaries. Source keys group revisions, while prompt citations
retain exact revision/object identity. Stale records are excluded from prompts.
The token estimate is a character-based heuristic, **not a tokenizer guarantee**.
Prompt framing is defense in depth, not a security boundary against prompt injection.

git-chat knowledge/cards use a separate service and data model. See [capabilities and limits](../../docs/compatibility.md).

From this directory, `npm run build` emits JS/declarations, `npm test` runs Node
checks against compiled exports, and `npm run check` validates types. TypeScript
is build tooling supplied by the workspace; consumers need only the built package.
