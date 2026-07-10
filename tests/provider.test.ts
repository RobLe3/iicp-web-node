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

test("discoverRelay requests a short-lived ticket and uses its relay route", async () => {
  let url = "";
  let requestBody: Record<string, unknown> | null = null;
  await withFetch(async (input, init) => {
    url = String(input);
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({
      node_id: "good",
      route: { endpoint: "https://good.example", relay_capable: true, reputation_score: 0.8, browser_usable: true },
    }));
  }, async () => {
    const relay = await discoverRelay("https://directory.test/api");
    assert.equal(url, "https://directory.test/api/v1/dispatch/ticket");
    assert.equal(requestBody?.intent, "urn:iicp:intent:llm:chat:v1");
    assert.equal(requestBody?.relay_capable, true);
    assert.equal(requestBody?.limit, 1);
    assert.equal(relay?.nodeId, "good");
  });
});

test("start registers browser provider with CX key, relay exposure and current browser SDK version", async () => {
  let registerBody: Record<string, any> | null = null;
  let bindBody: Record<string, any> | null = null;
  const order: string[] = [];
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/relay/bind")) {
      order.push("bind");
      bindBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ session_token: "relay-session" }));
    }
    if (url.endsWith("/v1/register") && init?.method === "POST") {
      order.push("register");
      registerBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ node_token: "node-token" }));
    }
    if (url.endsWith("/v1/relay/ticket")) {
      order.push("ticket");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer node-token");
      return new Response(JSON.stringify({ ticket: "signed-bind-ticket" }), { status: 201 });
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
      relayNodeId: "relay-1",
      directoryUrl: "https://directory.test/api",
      model: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
      region: "test-region",
    });
    await provider.start();
    await provider.stop();
  });

  assert.equal(registerBody?.transport_method, "turn_relay");
  assert.equal(registerBody?.exposure_mode, "relay_required");
  assert.equal(registerBody?.backend, "custom");
  assert.equal(registerBody?.sdk_language, "browser");
  assert.equal(registerBody?.sdk_version, BROWSER_NODE_SDK_VERSION);
  assert.equal(registerBody?.cx_public_key?.algorithm, "X25519");
  assert.equal(registerBody?.cx_public_key?.encoding, "base64url");
  assert.equal(bindBody?.bind_ticket, "signed-bind-ticket");
  assert.deepEqual(order.slice(0, 3), ["register", "ticket", "bind"]);
});

test("provider exposes deterministic recovery state transitions", async () => {
  const diagnostics: string[] = [];
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/relay/bind")) return new Response(JSON.stringify({ session_token: "relay-session" }));
    if (url.endsWith("/v1/register") && init?.method === "POST") return new Response(JSON.stringify({ node_token: "node-token" }));
    if (url.endsWith("/v1/relay/ticket")) return new Response(JSON.stringify({ ticket: "signed-bind-ticket" }), { status: 201 });
    if (url.endsWith("/v1/heartbeat")) return new Response(JSON.stringify({ ok: true }));
    if (url.endsWith("/v1/relay/pull")) return new Promise<Response>(() => undefined);
    if (url.endsWith("/v1/relay/unbind") || (url.endsWith("/v1/register") && init?.method === "DELETE")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const provider = new BrowserNodeProvider(runtime(), {
      relayUrl: "https://relay.example",
      directoryUrl: "https://directory.test/api",
      model: "browser-model",
      onRecoveryChange: (diagnostic) => diagnostics.push(`${diagnostic.recovery_state}:${diagnostic.recovery_action}`),
    });
    try {
      await provider.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(provider.diagnostic.recovery_state, "stable");
      assert.equal(provider.diagnostic.directory_listed, true);
    } finally {
      await provider.stop();
    }
  });
  assert.deepEqual(diagnostics.slice(0, 3), [
    "tunnel_starting:wait_cooldown",
    "route_mismatch:reregister",
    "stable:none",
  ]);
});

test("bind failure deregisters the temporary browser node", async () => {
  let deregistered = false;
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/register") && init?.method === "POST") return new Response(JSON.stringify({ node_token: "node-token" }));
    if (url.endsWith("/v1/relay/ticket")) return new Response(JSON.stringify({ ticket: "signed-bind-ticket" }), { status: 201 });
    if (url.endsWith("/v1/relay/bind")) return new Response("ticket rejected", { status: 401 });
    if (url.endsWith("/v1/register") && init?.method === "DELETE") {
      deregistered = true;
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const provider = new BrowserNodeProvider(runtime(), {
      relayUrl: "https://relay.example",
      relayNodeId: "relay-1",
      directoryUrl: "https://directory.test/api",
      model: "browser-model",
    });
    await assert.rejects(() => provider.start(), /relay bind failed: HTTP 401/);
  });
  assert.equal(deregistered, true);
});

test("ticket authentication failure does not downgrade to an unsigned bind", async () => {
  let bindAttempted = false;
  let deregistered = false;
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/register") && init?.method === "POST") return new Response(JSON.stringify({ node_token: "node-token" }));
    if (url.endsWith("/v1/relay/ticket")) return new Response("unauthorized", { status: 401 });
    if (url.endsWith("/v1/relay/bind")) {
      bindAttempted = true;
      return new Response(JSON.stringify({ session_token: "should-not-bind" }));
    }
    if (url.endsWith("/v1/register") && init?.method === "DELETE") {
      deregistered = true;
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const provider = new BrowserNodeProvider(runtime(), {
      relayUrl: "https://relay.example",
      relayNodeId: "relay-1",
      directoryUrl: "https://directory.test/api",
      model: "browser-model",
    });
    await assert.rejects(() => provider.start(), /relay bind ticket refused: HTTP 401/);
  });
  assert.equal(bindAttempted, false);
  assert.equal(deregistered, true);
});

test("explicitly unconfigured older directory may use the legacy soft bind", async () => {
  let bindBody: Record<string, unknown> | undefined;
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/register") && init?.method === "POST") return new Response(JSON.stringify({ node_token: "node-token" }));
    if (url.endsWith("/v1/relay/ticket")) return new Response(JSON.stringify({ error: { code: "not_configured" } }), { status: 503 });
    if (url.endsWith("/v1/relay/bind")) {
      bindBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ session_token: "legacy-session" }));
    }
    if (url.endsWith("/v1/heartbeat")) return new Response(JSON.stringify({ ok: true }));
    if (url.endsWith("/v1/relay/pull")) return new Promise<Response>(() => undefined);
    if (url.endsWith("/v1/relay/unbind") || (url.endsWith("/v1/register") && init?.method === "DELETE")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const provider = new BrowserNodeProvider(runtime(), {
      relayUrl: "https://relay.example",
      directoryUrl: "https://directory.test/api",
      model: "browser-model",
    });
    await provider.start();
    await provider.stop();
  });
  assert.equal(bindBody?.bind_ticket, undefined);
});

test("missing relay is reported as operator action without exposing its full URL", async () => {
  const logs: string[] = [];
  const provider = new BrowserNodeProvider(runtime(), {
    relayUrl: "https://secret-relay.example/private/path",
    directoryUrl: "https://directory.test/api",
    model: "browser-model",
    onLog: (line) => logs.push(line),
  });
  await withFetch(async () => {
    throw new Error("offline");
  }, async () => {
    await assert.rejects(() => provider.start(), /relay unreachable/);
  });
  assert.equal(provider.state, "error");
  assert.equal(provider.diagnostic.recovery_state, "operator_action_needed");
  assert.equal(provider.diagnostic.recovery_action, "operator_endpoint_needed");
  assert.equal(logs.join("\n").includes("secret-relay.example/private/path"), false);
});

test("directory rejection stays relay-only and reports route mismatch", async () => {
  await withFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/relay/bind")) return new Response(JSON.stringify({ session_token: "relay-session" }));
    if (url.endsWith("/v1/register") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: { code: "validation_error" } }), { status: 422 });
    }
    if (url.endsWith("/v1/relay/pull")) return new Promise<Response>(() => undefined);
    if (url.endsWith("/v1/relay/unbind")) return new Response(JSON.stringify({ ok: true }));
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const provider = new BrowserNodeProvider(runtime(), {
      relayUrl: "https://relay.example",
      directoryUrl: "https://directory.test/api",
      model: "browser-model",
    });
    try {
      await provider.start();
      assert.equal(provider.state, "serving");
      assert.equal(provider.diagnostic.directory_listed, false);
      assert.equal(provider.diagnostic.relay_bound, true);
      assert.equal(provider.diagnostic.recovery_state, "route_mismatch");
      assert.equal(provider.diagnostic.recovery_action, "reregister");
    } finally {
      await provider.stop();
    }
  });
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
  assert.equal(resultBody?.result?.generated_by_ai, true);
  assert.equal(heartbeatBody?.metrics?.tasks_success, 1);
  assert.equal(heartbeatBody?.metrics?.tasks_failed, 0);
  assert.equal(typeof heartbeatBody?.metrics?.avg_latency_ms, "number");
});
