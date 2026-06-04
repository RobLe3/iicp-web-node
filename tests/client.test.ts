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

test("discoverUrl builds /v1/discover with intent + opts, trims trailing slash", () => {
  const u = discoverUrl("https://iicp.network/", "urn:iicp:intent:llm:chat:v1", {
    region: "eu",
    min_reputation: 0.5,
    limit: 5,
  });
  assert.ok(u.startsWith("https://iicp.network/v1/discover?"), u);
  assert.ok(!u.includes("network//v1"), "must not double-slash");
  const q = new URL(u).searchParams;
  assert.equal(q.get("intent"), "urn:iicp:intent:llm:chat:v1");
  assert.equal(q.get("region"), "eu");
  assert.equal(q.get("min_reputation"), "0.5");
  assert.equal(q.get("limit"), "5");
});

test("default directory is iicp.network", () => {
  assert.equal(DEFAULT_DIRECTORY_URL, "https://iicp.network");
  assert.ok(discoverUrl(DEFAULT_DIRECTORY_URL, "urn:iicp:intent:llm:chat:v1").includes("https://iicp.network/v1/discover"));
});

test("invalid intent URN is rejected (parity with @iicp/client SDK-02)", () => {
  assert.throws(() => cipConsumerEnvelope("not-a-urn", {}), (e: unknown) => e instanceof IicpError && (e as IicpError).code === "invalid_intent");
  // a valid one does not throw
  cipConsumerEnvelope("urn:iicp:intent:llm:chat:v1", { x: 1 });
});

test("cipConsumerEnvelope shape is stable (consumer mode, safe-by-default policy)", () => {
  const env = cipConsumerEnvelope("urn:iicp:intent:llm:chat:v1", { messages: [] });
  assert.equal(env.iicp_version, "1");
  assert.equal(env.mode, "consumer");
  assert.equal(env.intent, "urn:iicp:intent:llm:chat:v1");
  // safe defaults: remote inference on (the point of CIP), tool-exec + file-access OFF
  assert.equal(env.cip_policy.allow_remote_inference, true);
  assert.equal(env.cip_policy.allow_tool_execution, false);
  assert.equal(env.cip_policy.allow_file_access, false);
});

test("client.discover rejects an invalid intent before any fetch", async () => {
  const c = new IicpBrowserClient({ directory_url: "https://example.test" });
  await assert.rejects(() => c.discover("bogus"), (e: unknown) => e instanceof IicpError);
});
