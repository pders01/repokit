import assert from "node:assert/strict";
import { test } from "node:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { RepoService } from "@jpahd/git-chat-protocol/repo";
import {
  createGitChatReadingTransport,
  GIT_CHAT_RESPONSE_BYTES,
  type ReadingFetch,
} from "@jpahd/commits-adapters/git-chat-transport";

const options = (fetch: ReadingFetch, timeoutMs?: number) => ({
  baseUrl: "http://fixture.invalid/api",
  fetch,
  timeoutMs,
});
const request = (fetch: ReadingFetch, timeoutMs?: number) =>
  createClient(RepoService, createGitChatReadingTransport(options(fetch, timeoutMs))).listBranches({
    repoId: "exact-repo",
  });

for (const baseUrl of [
  "",
  "/relative",
  "ftp://fixture.invalid",
  "http://user:secret@fixture.invalid/",
  "http://fixture.invalid/?token=secret",
  "http://fixture.invalid/#secret",
  "http://fixture.invalid/?",
  "http://fixture.invalid/#",
]) {
  test(`transport rejects ambiguous/credential-bearing base URL ${baseUrl.replace(/secret/g, "redacted")}`, () => {
    assert.throws(() =>
      createGitChatReadingTransport({ ...options(async () => Response.json({})), baseUrl }),
    );
  });
}

test("bounds response bytes before Connect JSON decoding even with absent/lying length", async () => {
  for (const contentLength of [undefined, "1"]) {
    let cancelled = false,
      calls = 0,
      pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch: ReadingFetch = async () => {
      calls++;
      return new Response(stream, {
        headers: {
          "content-type": "application/json",
          ...(contentLength ? { "content-length": contentLength } : {}),
        },
      });
    };
    await assert.rejects(request(fetch));
    assert.strictEqual(cancelled, true);
    assert.strictEqual(calls, 1);
    assert.ok(pulls <= 11); // at most one stream-prefetch chunk beyond the rejected chunk
  }
});

test("rejects oversized declared bodies without draining them", async () => {
  let pulls = 0,
    cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      pulls++;
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    request(
      async () =>
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-length": String(GIT_CHAT_RESPONSE_BYTES + 1),
          },
        }),
    ),
  );
  assert.strictEqual(cancelled, true);
  assert.ok(pulls <= 1);
});

test("accepts the exact response byte boundary without clipping or rewriting fields", async () => {
  const wrapper = JSON.stringify({ branches: [{ name: "main" }], padding: "" });
  const body = JSON.stringify({
    branches: [{ name: "main" }],
    padding: "x".repeat(GIT_CHAT_RESPONSE_BYTES - wrapper.length),
  });
  assert.strictEqual(new TextEncoder().encode(body).byteLength, GIT_CHAT_RESPONSE_BYTES);
  const result = await request(
    async () => new Response(body, { headers: { "content-type": "application/json" } }),
  );
  assert.strictEqual(result.branches[0].name, "main");
});

test("preserves host auth headers, POST and response headers without claiming or redirecting", async () => {
  let seen: RequestInit | undefined,
    responseCookie = "";
  const transport = createGitChatReadingTransport(
    options(async (input, init) => {
      assert.strictEqual(
        String(input),
        "http://fixture.invalid/api/gitchat.v1.RepoService/ListBranches",
      );
      seen = init;
      return Response.json(
        { branches: [], tags: [] },
        { headers: { "set-cookie": "fixture-session=opaque; HttpOnly; SameSite=Strict" } },
      );
    }),
  );
  await createClient(RepoService, transport).listBranches(
    { repoId: "exact-repo" },
    {
      headers: { "x-fixture-auth": "opaque" },
      onHeader: (headers) => {
        responseCookie = headers.get("set-cookie") ?? "";
      },
    },
  );
  assert.strictEqual(seen?.method, "POST");
  assert.strictEqual(new Headers(seen?.headers).get("x-fixture-auth"), "opaque");
  assert.strictEqual(seen?.redirect, "error");
  assert.ok(responseCookie.includes("fixture-session=opaque"));
});

test("retains protocol error status/code through the bounded response copy", async () => {
  let failure: unknown;
  try {
    await request(async () =>
      Response.json(
        { code: "unauthenticated", message: "Fixture authentication required" },
        { status: 401 },
      ),
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ConnectError);
  assert.strictEqual((failure as ConnectError).code, Code.Unauthenticated);
});

test("the read-only transport never forwards catalog/config/other RPC methods", async () => {
  let calls = 0;
  const client = createClient(
    RepoService,
    createGitChatReadingTransport(
      options(async () => {
        calls++;
        return Response.json({});
      }),
    ),
  );
  await assert.rejects(client.listRepos({}));
  await assert.rejects(client.getConfig({}));
  assert.strictEqual(calls, 0);
});

test("captures the host fetch function rather than mutable option properties", async () => {
  let calls = 0;
  const config = options(async () => {
    calls++;
    return Response.json({});
  });
  const transport = createGitChatReadingTransport(config);
  config.fetch = async () => {
    throw new Error("replacement fetch");
  };
  config.baseUrl = "http://other.invalid";
  await createClient(RepoService, transport).listBranches({ repoId: "exact-repo" });
  assert.strictEqual(calls, 1);
});

test("aborts a stalled response body and releases the reader on the local deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    request(
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
      20,
    ),
  );
  // Cancellation is signalled synchronously, not established as server-side work cancellation.
  assert.strictEqual(cancelled, true);
});

test("cancels a late fetch response body after local cancellation already settled", async () => {
  const controller = new AbortController();
  let release!: (response: Response) => void, started!: () => void;
  let cancelled = false;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const transport = createGitChatReadingTransport(
    options(async () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  const pending = createClient(RepoService, transport).listBranches(
    { repoId: "exact-repo" },
    { signal: controller.signal },
  );
  await fetching;
  controller.abort();
  await assert.rejects(pending);
  release(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(cancelled, true);
});

test("cancels a rejected redirected response body without decoding it", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  );
  Object.defineProperty(response, "redirected", { value: true });
  await assert.rejects(request(async () => response));
  assert.strictEqual(cancelled, true);
});

test("supports caller abort while an injected host fetch ignores cancellation", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const transport = createGitChatReadingTransport(
    options(async (_input, init) => {
      observed = init!.signal!;
      controller.abort();
      return new Promise<never>(() => {});
    }),
  );
  await assert.rejects(
    createClient(RepoService, transport).listBranches(
      { repoId: "exact-repo" },
      { signal: controller.signal },
    ),
  );
  assert.strictEqual(observed?.aborted, true);
});
