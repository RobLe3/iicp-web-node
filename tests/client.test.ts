// SPDX-License-Identifier: Apache-2.0
// Unit tests (#448) — no browser/network: URL builder, intent validation, CIP envelope.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverUrl,
  cipConsumerEnvelope,
  IicpBrowserClient,
  IicpError,
  DEFAULT_DIRECTORY_URL,
} from "../src/index.ts";

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

// Discover response normalisation — handles both {nodes:[...]} and plain [...] shapes.
test("discoverUrl encodes intent in query string", () => {
  const u = discoverUrl("https://iicp.network", "urn:iicp:intent:llm:chat:v1");
  assert.equal(new URL(u).searchParams.get("intent"), "urn:iicp:intent:llm:chat:v1");
});
