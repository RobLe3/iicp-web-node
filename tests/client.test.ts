// SPDX-License-Identifier: Apache-2.0
// Unit tests (#448) — no browser/network: URL builder, intent validation, browser filtering,
// fail-closed IICP-CX, and CIP envelope KATs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverUrl,
  cipConsumerEnvelope,
  IicpBrowserClient,
  IicpError,
  DEFAULT_DIRECTORY_URL,
} from "../src/index.ts";
import { createCxKeyPair } from "../src/cxConfidentiality.ts";

type FetchImpl = typeof globalThis.fetch;

function withFetch(fn: FetchImpl, run: () => Promise<void>): Promise<void> {
  const prev = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => {
    globalThis.fetch = prev;
  });
}

test("discoverUrl builds /api/v1/discover with intent + opts, trims trailing slash", () => {
  const u = discoverUrl("https://iicp.network/", "urn:iicp:intent:llm:chat:v1", {
    region: "eu",
    min_reputation: 0.5,
    limit: 5,
  });
  assert.ok(u.startsWith("https://iicp.network/api/v1/discover?"), u);
  assert.ok(!u.includes("network//v1"), "must not double-slash");
  const q = new URL(u).searchParams;
  assert.equal(q.get("intent"), "urn:iicp:intent:llm:chat:v1");
  assert.equal(q.get("region"), "eu");
  assert.equal(q.get("min_reputation"), "0.5");
  assert.equal(q.get("limit"), "5");
});

test("default directory is iicp.network", () => {
  assert.equal(DEFAULT_DIRECTORY_URL, "https://iicp.network");
  assert.ok(discoverUrl(DEFAULT_DIRECTORY_URL, "urn:iicp:intent:llm:chat:v1").includes("https://iicp.network/api/v1/discover"));
});

test("client.discover rejects an invalid intent before any fetch", async () => {
  const c = new IicpBrowserClient({ directory_url: "https://example.test" });
  await assert.rejects(() => c.discover("bogus"), (e: unknown) => e instanceof IicpError);
});

test("client.discover filters to browser-usable endpoints by default", async () => {
  await withFetch(async () => new Response(JSON.stringify({
    nodes: [
      { node_id: "https", endpoint: "https://relay.example/v1/relay-for/n", browser_usable: true },
      { node_id: "http", endpoint: "http://203.0.113.1:9484", browser_usable: false },
      { node_id: "loopback", endpoint: "http://127.0.0.1:9484" },
      { node_id: "native", endpoint: "iicp://node:9484" },
    ],
  })), async () => {
    const c = new IicpBrowserClient({ directory_url: "https://directory.test" });
    const nodes = await c.discover("urn:iicp:intent:llm:chat:v1");
    assert.deepEqual(nodes.map((n) => n.node_id), ["https", "loopback"]);
  });
});

test("client.discover can opt out of browser-usable filtering", async () => {
  await withFetch(async () => new Response(JSON.stringify([
    { node_id: "https", endpoint: "https://relay.example" },
    { node_id: "native", endpoint: "iicp://node:9484" },
  ])), async () => {
    const c = new IicpBrowserClient({ directory_url: "https://directory.test" });
    const nodes = await c.discover("urn:iicp:intent:llm:chat:v1", { browser_usable_only: false });
    assert.deepEqual(nodes.map((n) => n.node_id), ["https", "native"]);
  });
});

// CIP consumer envelope KAT (#448) — byte-stable shape, parity with @iicp/client task wire format.
test("cipConsumerEnvelope has required fields with correct shape", () => {
  const msgs = [{ role: "user" as const, content: "hello" }];
  const env = cipConsumerEnvelope(msgs, { task_id: "test-task-1" });
  assert.equal(env.task_id, "test-task-1");
  assert.equal(env.intent, "urn:iicp:intent:llm:chat:v1");
  assert.deepEqual(env.constraints, {});
  assert.deepEqual(env.payload.messages, msgs);
  assert.equal(env.payload.model, undefined);
});

test("cipConsumerEnvelope accepts custom intent + model", () => {
  const msgs = [{ role: "user" as const, content: "embed this" }];
  const env = cipConsumerEnvelope(msgs, {
    intent: "urn:iicp:intent:embedding:text:v1",
    model: "nomic-embed-text",
    task_id: "test-task-2",
  });
  assert.equal(env.intent, "urn:iicp:intent:embedding:text:v1");
  assert.equal(env.payload.model, "nomic-embed-text");
});

test("cipConsumerEnvelope rejects an invalid intent", () => {
  assert.throws(
    () => cipConsumerEnvelope([], { intent: "not-a-urn", task_id: "x" }),
    (e: unknown) => e instanceof IicpError,
  );
});

test("chat refuses keyless nodes before fetch", async () => {
  let called = false;
  await withFetch(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }, async () => {
    const c = new IicpBrowserClient({ directory_url: "https://directory.test" });
    await assert.rejects(
      () => c.chat([{ role: "user", content: "hi" }], { endpoint: "https://node.example" }),
      (e: unknown) => e instanceof IicpError && e.code === "cx_required",
    );
    assert.equal(called, false, "fail-closed must happen before any network send");
  });
});

test("chat sends iicp_conf and omits plaintext payload when a CX key is supplied", async () => {
  const { publicKey } = createCxKeyPair("test");
  let sent: Record<string, unknown> | null = null;
  await withFetch(async (_input, init) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ task_id: sent?.task_id, result: { ok: true }, status: "ok" }), { status: 200 });
  }, async () => {
    const c = new IicpBrowserClient({ directory_url: "https://directory.test" });
    await c.chat([{ role: "user", content: "hi" }], { endpoint: "https://node.example", cxPublicKey: publicKey });
  });
  assert.ok(sent?.iicp_conf, "encrypted envelope expected");
  assert.equal("payload" in (sent ?? {}), false, "plaintext payload must not be sent");
});

// Discover response normalisation — handles both {nodes:[...]} and plain [...] shapes.
test("discoverUrl encodes intent in query string", () => {
  const u = discoverUrl("https://iicp.network", "urn:iicp:intent:llm:chat:v1");
  assert.equal(new URL(u).searchParams.get("intent"), "urn:iicp:intent:llm:chat:v1");
});
