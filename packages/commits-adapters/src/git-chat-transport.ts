import { createConnectTransport } from "@connectrpc/connect-web";
import type { Transport } from "@connectrpc/connect";
import { invalidRead, readOperation, readTimeout } from "./common.js";

export const GIT_CHAT_RESPONSE_BYTES = 8 * 1024 * 1024;
export type ReadingFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
export interface GitChatReadingTransportOptions {
  /** Explicit host-approved same-origin proxy/API base; never includes credentials. */
  readonly baseUrl: string;
  /** Host owns authentication/cookie policy. This helper does not claim a session. */
  readonly fetch: ReadingFetch;
  readonly timeoutMs?: number;
}

/** Connect-web has no unary response-size option: bound the bytes before its JSON decoder. */
export function createGitChatReadingTransport(options: GitChatReadingTransportOptions): Transport {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { return invalidRead(); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.href.includes("?") || base.href.includes("#") ||
      typeof options.fetch !== "function") invalidRead();
  const baseUrl = base.href.replace(/\/+$/, "");
  const authenticatedFetch = options.fetch;
  const timeoutMs = readTimeout(options.timeoutMs);
  const allowed = new Set(["ListBranches", "ListCommits", "GetDiff"].map((method) => `${baseUrl}/gitchat.v1.RepoService/${method}`));
  const boundedFetch: ReadingFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (!allowed.has(url) || method !== "POST") invalidRead();
    const parent = init?.signal ?? (input instanceof Request ? input.signal : new AbortController().signal);
    return readOperation(parent, timeoutMs, async (signal) => {
      const response = await authenticatedFetch(input, { ...init, signal, redirect: "error" });
      if (signal.aborted || response.redirected) {
        // A host fetch may ignore cancellation and return after our local wait ended.
        // Do not leave that late response (or a rejected redirect) streaming in the background.
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        invalidRead();
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > GIT_CHAT_RESPONSE_BYTES) { cancel(); invalidRead(); }
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > GIT_CHAT_RESPONSE_BYTES) { cancel(); invalidRead(); }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        // Preserve status and headers (including protocol errors/cookies), not just success JSON.
        return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    });
  };
  return createConnectTransport({ baseUrl, fetch: boundedFetch as typeof globalThis.fetch, useBinaryFormat: false,
    useHttpGet: false, defaultTimeoutMs: timeoutMs });
}
