import { createClient, type Transport } from "@connectrpc/connect";
import { RepoService } from "@jpahd/git-chat-protocol/repo";
import type { CommitsProvider, ReadingRef, ReadingScope } from "@jpahd/commits-core/contracts";
import { READER_LIMITS } from "@jpahd/commits-core/contracts";
import {
  captureScope, changedFiles, diffQuery, invalidRead, listQuery,
  objectId, opaqueKey, pageValue, patchText, readingRef, readOperation, readTimeout, requestedRef, resultValue,
} from "./common.js";

export interface GitChatCommitsOptions {
  /** Host-owned authenticated endpoint/transport; never chosen from a catalog row. */
  readonly transport: Transport;
  readonly repoId: string;
  readonly scope: ReadingScope;
  readonly initialRef: string;
  readonly timeoutMs?: number;
}

/** Only RepoService reads. No AuthService, ChatService, configuration, or implicit repo choice. */
export function createGitChatCommitsProvider(options: GitChatCommitsOptions): CommitsProvider {
  if (!options?.transport || typeof options.transport.unary !== "function" || typeof options.transport.stream !== "function") invalidRead();
  const scope = captureScope(options.scope);
  const repoId = opaqueKey(options.repoId);
  const initialRef = requestedRef(options.initialRef);
  const timeoutMs = readTimeout(options.timeoutMs);
  const transport = Object.freeze({ unary: options.transport.unary.bind(options.transport),
    stream: options.transport.stream.bind(options.transport) });
  const client = createClient(RepoService, transport);
  const callOptions = (signal: AbortSignal) => ({ signal, timeoutMs });

  const lookup = async (ref: string, signal: AbortSignal, exact: boolean) => {
    const response = await client.listCommits({ repoId, ref, limit: 1, offset: 0, path: "" }, callOptions(signal));
    signal.throwIfAborted();
    const page = pageValue(response, 1);
    if (page.commits.length !== 1 || (exact && page.commits[0].sha !== ref)) invalidRead();
    return page.commits[0];
  };

  return Object.freeze({
    scope,
    describe: (signal) => readOperation(signal, timeoutMs, async () => resultValue(scope, Object.freeze({ initialRef }))),
    listRefs: (signal) => readOperation(signal, timeoutMs, async (readSignal) => {
      const response = await client.listBranches({ repoId }, callOptions(readSignal));
      readSignal.throwIfAborted();
      if (!Array.isArray(response.branches) || !Array.isArray(response.tags) ||
          response.branches.length + response.tags.length > READER_LIMITS.refs) invalidRead();
      const selectors = new Set<string>();
      const refs: ReadingRef[] = [];
      for (const [kind, entries] of [["branch", response.branches], ["tag", response.tags]] as const) {
        for (const entry of entries) {
          let value: ReadingRef;
          if (entry.fullRef !== "") {
            const selector = requestedRef(entry.fullRef);
            const prefix = kind === "branch" ? "refs/heads/" : "refs/tags/";
            if (!selector.startsWith(prefix)) invalidRead();
            value = readingRef(selector.slice(prefix.length), kind);
            if (value.selector !== selector) invalidRead();
          } else {
            // Older servers have only a display name. Native short names and the
            // go-git fallback disagree under ambiguity; never guess through that gap.
            if (/^(?:refs|heads|tags|remotes)\//.test(entry.name)) invalidRead();
            value = readingRef(entry.name, kind);
          }
          if (selectors.has(value.selector)) invalidRead();
          selectors.add(value.selector);
          // A catalog tag object's ID is deliberately not used for immutable resolution.
          refs.push(value);
        }
      }
      return resultValue(scope, Object.freeze(refs));
    }),
    resolve: async (input, signal) => {
      const ref = requestedRef(input);
      return readOperation(signal, timeoutMs, async (readSignal) => {
        const commit = await lookup(ref, readSignal, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref));
        readSignal.throwIfAborted();
        return resultValue(scope, Object.freeze({ requestedRef: ref, commit: commit.sha }));
      });
    },
    list: async (input, signal) => {
      const query = listQuery(input);
      return readOperation(signal, timeoutMs, async (readSignal) => {
        const response = await client.listCommits({ repoId, ref: query.revision.commit,
          path: query.path ?? "", limit: query.limit, offset: query.offset }, callOptions(readSignal));
        readSignal.throwIfAborted();
        return resultValue(scope, pageValue(response, query.limit));
      });
    },
    commit: async (input, signal) => {
      const sha = objectId(input);
      return readOperation(signal, timeoutMs, async (readSignal) => resultValue(scope, await lookup(sha, readSignal, true)));
    },
    diff: async (input, signal) => {
      const query = diffQuery(input);
      return readOperation(signal, timeoutMs, async (readSignal) => {
        const metadata = await lookup(query.commit, readSignal, true);
        readSignal.throwIfAborted();
        const parent = metadata.parentShas[0];
        const response = await client.getDiff({ repoId, toRef: query.commit, fromRef: parent ?? "", path: query.path ?? "",
          fromPath: "", detectRenames: false, fullRange: false, filesOnly: false }, callOptions(readSignal));
        readSignal.throwIfAborted();
        if (response.toCommit !== query.commit || (parent ? response.fromCommit !== parent : response.fromCommit !== "") ||
            typeof response.empty !== "boolean") invalidRead();
        const rawDiff = patchText(response.unifiedDiff);
        const files = changedFiles(response.files);
        if (response.empty && rawDiff !== "") invalidRead();
        // Mode-only changes can report empty=true with actual changed-file rows.
        // Preserve those rows; aggregate emptiness is then not established.
        const empty = response.empty && files.length > 0 ? undefined : response.empty;
        const partial = files.some((file) => file.status === "truncated");
        return resultValue(scope, Object.freeze({ toCommit: query.commit,
          base: parent ? Object.freeze({ kind: "commit" as const, commit: objectId(parent) })
            : Object.freeze({ kind: "empty-tree" as const }),
          rawDiff,
          // No machine-readable byte-completeness field exists. Never parse English patch prose
          // to certify completeness, nor use full_range to evade server caps.
          completeness: partial ? Object.freeze({ kind: "partial" as const, reason: "Backend changed-file listing reports omissions." })
            : Object.freeze({ kind: "unknown" as const }),
          empty,
          ...(files.length || (empty && !query.path) ? { files } : {}),
        }));
      });
    },
  } satisfies CommitsProvider);
}

// Referenced only by descriptor conformance tests; never imported into the shared reader.
export const gitChatReadMethods = Object.freeze(["ListBranches", "ListCommits", "GetDiff"] as const);
