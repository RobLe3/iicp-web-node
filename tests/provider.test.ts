// SPDX-License-Identifier: Apache-2.0
// Browser provider tests: registration advertises CX/privacy fields, relay discovery filters,
// encrypted task serving decrypts iicp_conf, and heartbeat reports task metrics.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BrowserNodeProvider,
  BROWSER_NODE_SDK_VERSION,
  discoverRelay,
  encryptPayload,
  type BrowserProviderRuntime,
} from "../src/index.ts";

type FetchImpl = typeof globalThis.fetch;

async function withFetch(fn: FetchImpl, run: () => Promise<void>): Promise<void> {
  const prev = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    await run();
  } finally {
    globalThis.fetch = prev;
  }
}

function runtime(reply = "ok"): BrowserProviderRuntime {
  return {
    async chat(messages) {
      assert.ok(Array.isArray(messages));
      return reply;
    },
  };
}

test("discoverRelay queries wide and prefers browser-usable/high-reputation relays", async () => {
  let url = "";
  await withFetch(async (input) => {
    url = String(input);
    return new Response(JSON.stringify({
      nodes: [
        { node_id: "native", endpoint: "iicp://relay", relay_capable: true, reputation_score: 1 },
        { node_id: "low", endpoint: "https://low.example", relay_capable: true, reputation_score: 0.01 },
        { node_id: "good", endpoint: "https://good.example", relay_capable: true, reputation_score: 0.8, browser_usable: true },
        { node_id: "probation", endpoint: "https://new.example", relay_capable: true, reputation_score: 0.9, probation: true, browser_usable: true },
      ],
    }));
  }, async () => {
    const relay = await discoverRelay("https://directory.test/api");
    assert.equal(new URL(url).searchParams.get("limit"), "50");
    assert.equal(relay?.nodeId, "good");
  });
});

test("start registers browser provider with CX key, relay exposure and current browser SDK version", async () => {
  let registerBody: Record<string, any> | null = null;
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/relay/bind")) {
      return new Response(JSON.stringify({ session_token: "relay-session" }));
    }
    if (url.endsWith("/v1/register") && init?.method === "POST") {
      registerBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ node_token: "node-token" }));
    }
    if (url.endsWith("/v1/heartbeat")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.endsWith("/v1/relay/pull")) {
      return new Promise<Response>(() => undefined);
    }
    if (url.endsWith("/v1/relay/unbind") || (url.endsWith("/v1/register") && init?.method === "DELETE")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const provider = new BrowserNodeProvider(runtime(), {
      relayUrl: "https://relay.example",
      directoryUrl: "https://directory.test/api",
      model: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
      region: "test-region",
    });
    await provider.start();
    await provider.stop();
  });

  assert.equal(registerBody?.transport_method, "turn_relay");
  assert.equal(registerBody?.exposure_mode, "relay_required");
  assert.equal(registerBody?.backend, "webllm");
  assert.equal(registerBody?.sdk_language, "browser");
  assert.equal(registerBody?.sdk_version, BROWSER_NODE_SDK_VERSION);
  assert.equal(registerBody?.cx_public_key?.algorithm, "X25519");
  assert.equal(registerBody?.cx_public_key?.encoding, "base64url");
});

test("serveCall decrypts iicp_conf tasks and heartbeat includes latency metrics", async () => {
  const seenMessages: unknown[] = [];
  let resultBody: Record<string, any> | null = null;
  let heartbeatBody: Record<string, any> | null = null;
  const provider = new BrowserNodeProvider({
    async chat(messages) {
      seenMessages.push(messages);
      return "decrypted ok";
    },
  }, {
    relayUrl: "https://relay.example",
    directoryUrl: "https://directory.test/api",
    model: "browser-model",
  });
  const anyProvider = provider as any;
  anyProvider._sessionToken = "relay-session";
  anyProvider._nodeToken = "node-token";

  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/relay/result")) {
      resultBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.endsWith("/v1/heartbeat")) {
      heartbeatBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const taskId = "task-encrypted-1";
    const intent = "urn:iicp:intent:llm:chat:v1";
    const payload = { messages: [{ role: "user", content: "secret" }], max_tokens: 32 };
    const iicpConf = await encryptPayload(payload, anyProvider._cx.publicKey, taskId, intent);
    await anyProvider.serveCall({ call_id: "call-1", task: { task_id: taskId, intent, iicp_conf: iicpConf } });
    await anyProvider.heartbeat();
  });

  assert.deepEqual(seenMessages[0], [{ role: "user", content: "secret" }]);
  assert.equal(resultBody?.result?.result?.choices?.[0]?.message?.content, "decrypted ok");
  assert.equal(heartbeatBody?.metrics?.tasks_success, 1);
  assert.equal(heartbeatBody?.metrics?.tasks_failed, 0);
  assert.equal(typeof heartbeatBody?.metrics?.avg_latency_ms, "number");
});
