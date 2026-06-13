// SPDX-License-Identifier: Apache-2.0
//
// iicpConsumer — the CONSUMER module of @iicp/web-node (discover + encrypted submit).
//
// A tiny (zero-runtime-dependency) TypeScript client for the IICP discovery mesh,
// built on the browser's native fetch / TextEncoder / SubtleCrypto so it embeds
// directly into a web page (and also runs in Node ≥18). It is the CONSUMER subset
// of the protocol only — it never registers as a provider and carries no TCP / NAT /
// relay machinery (that lives in the full @iicp/client Node SDK).
//
// Discovery (GET {directory}/v1/discover) works from any https:// page because
// iicp.network sends CORS headers. Task routing to a discovered node, or to a local
// LLM, is subject to browser CORS / mixed-content policy — see README "CORS reality".
//
// Epic: #446 · Dev: #447 · Research: research/wasm/WASM-1-feasibility.md (#292).

/** Intent URN shape — parity with @iicp/client (SDK-02). */
import { encryptPayload, type CxPublicKey } from "./cxConfidentiality";

const INTENT_RE = /^urn:iicp:intent:[a-z0-9_:/-]+$/;

export const DEFAULT_DIRECTORY_URL = "https://iicp.network";

export interface ClientConfig {
  /** Directory base URL. Default: https://iicp.network (CORS-enabled). */
  directory_url?: string;
  /** Per-request timeout (ms). Default 10000. */
  timeout_ms?: number;
}

export interface DiscoverOptions {
  region?: string;
  min_reputation?: number;
  /** Max nodes to return (directory caps at 50). */
  limit?: number;
}

/** A discoverable provider node (public discovery view — no tokens/endpoints private). */
export interface Node {
  node_id: string;
  endpoint: string;
  region?: string;
  reputation_score?: number;
  reputation_tier?: string;
  models?: string[];
  [k: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class IicpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IicpError";
  }
}

function validateIntent(intent: string): void {
  if (!INTENT_RE.test(intent)) {
    throw new IicpError(`invalid intent URN: ${intent}`, "invalid_intent");
  }
}

/** CIP consumer task envelope — extracted for testability (KAT, parity with @iicp/client). */
export interface TaskEnvelope {
  task_id: string;
  intent: string;
  constraints: Record<string, unknown>;
  payload: { messages: ChatMessage[]; model?: string };
}

/**
 * Build the CIP consumer task envelope. Pure, deterministic (pass task_id for KAT).
 * Wire-protocol parity with the Node SDK: `POST {endpoint}/v1/task` with this body.
 */
export function cipConsumerEnvelope(
  messages: ChatMessage[],
  opts: { intent?: string; model?: string; task_id?: string } = {},
): TaskEnvelope {
  const intent = opts.intent ?? "urn:iicp:intent:llm:chat:v1";
  validateIntent(intent);
  const taskId =
    opts.task_id ??
    (globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    task_id: taskId,
    intent,
    constraints: {},
    payload: { messages, model: opts.model },
  };
}

/**
 * Build the discover URL. Extracted so the query construction is unit-testable
 * (same discipline as the federation event-log URL regression test).
 */
export function discoverUrl(directoryUrl: string, intent: string, opts: DiscoverOptions = {}): string {
  const params = new URLSearchParams({ intent });
  if (opts.region) params.set("region", opts.region);
  if (opts.min_reputation != null) params.set("min_reputation", String(opts.min_reputation));
  if (opts.limit != null) params.set("limit", String(opts.limit));
  // /api/v1 — the directory API prefix (verified against prod iicp.network 2026-06-04:
  // /api/v1/discover → JSON {nodes,count,query_ms}; a bare /v1/discover hits the website's
  // static HTML fallback, not the directory). Same /api/v1 lesson as the federation work.
  return `${directoryUrl.replace(/\/+$/, "")}/api/v1/discover?${params}`;
}

/** Browser-native, consumer-only IICP client. */
export class IicpBrowserClient {
  private readonly directory: string;
  private readonly timeout: number;

  constructor(cfg: ClientConfig = {}) {
    this.directory = (cfg.directory_url ?? DEFAULT_DIRECTORY_URL).replace(/\/+$/, "");
    this.timeout = cfg.timeout_ms ?? 10_000;
  }

  private async getJson<T>(url: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!resp.ok) {
        throw new IicpError(`GET ${url} → ${resp.status}`, "http_error", resp.status);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  /** Discover nodes capable of an intent (GET /v1/discover — CORS-enabled on iicp.network). */
  async discover(intent: string, opts: DiscoverOptions = {}): Promise<Node[]> {
    validateIntent(intent);
    const body = await this.getJson<{ nodes?: Node[] } | Node[]>(
      discoverUrl(this.directory, intent, opts),
    );
    return Array.isArray(body) ? body : (body.nodes ?? []);
  }

  /** Directory mesh stats (GET /v1/stats), incl. mesh_health + active_nodes. */
  async stats(): Promise<Record<string, unknown>> {
    return this.getJson(`${this.directory}/api/v1/stats`);
  }

  /** Public node registry listing (GET /v1/registry/nodes). */
  async registry(): Promise<Record<string, unknown>> {
    return this.getJson(`${this.directory}/api/v1/registry/nodes`);
  }

  /**
   * Route a chat to a node over the node's **HTTP transport**: `POST {endpoint}/v1/task`
   * with the real task body `{ task_id, intent, payload, constraints }` (SDK-01/02 — same
   * shape the @iicp/client Node SDK sends; the node replies `{ task_id, result, status,
   * metrics }`). `payload` for llm:chat is `{ messages, model }`.
   *
   * Transport note: nodes also expose the **native IICP binary protocol on port 9484**
   * (`transport_endpoint: iicp://…`) — more efficient, used by the full SDKs. A browser
   * can't open raw TCP, so this client uses the HTTP transport (the discover `endpoint`).
   *
   * ⚠ Reachability: from an https:// page the browser reaches iicp.network (discover) but
   * NOT http://localhost LLMs (mixed-content; Chrome 129+ flag only), nor a node without
   * CORS, nor an IPv6-firewalled node (today's live nodes are `ipv6_direct_firewall_required`).
   * Pass a reachable `endpoint`. In Node there is no CORS restriction. Returns the node JSON.
   */
  async chat(
    messages: ChatMessage[],
    opts: { endpoint: string; intent?: string; model?: string; cxPublicKey?: CxPublicKey | null },
  ): Promise<Record<string, unknown>> {
    const env = cipConsumerEnvelope(messages, { intent: opts.intent, model: opts.model });
    // IICP-CX S.16: encryption is MANDATORY (privacy-first #360) — no opt-out. When the node
    // advertises a cx_public_key, seal the payload into an iicp_conf envelope so the directory,
    // relays and network see only ciphertext (byte-compatible with the node/adapter decrypt).
    // A node with no key yet gets a loud transitional plaintext warning; fail-closed once the
    // mesh is key-ready. Same posture as the Python/TS/Rust SDKs.
    let body: Record<string, unknown>;
    if (opts.cxPublicKey) {
      body = {
        task_id: env.task_id,
        intent: env.intent,
        constraints: {},
        iicp_conf: await encryptPayload(env.payload, opts.cxPublicKey, env.task_id, env.intent),
      };
    } else {
      console.warn(
        "[iicp-cx] node advertises no encryption key — sending UNENCRYPTED " +
          "(transitional; will be refused once the mesh is key-ready)",
      );
      body = env as unknown as Record<string, unknown>;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const resp = await fetch(`${opts.endpoint.replace(/\/+$/, "")}/v1/task`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        throw new IicpError(`task → ${resp.status}`, "node_error", resp.status);
      }
      return (await resp.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(t);
    }
  }
}

const TUNNEL_SUFFIXES = [".trycloudflare.com", ".ngrok.io", ".ngrok-free.app", ".loca.lt"];

/** Mask the high-entropy subdomain of an ephemeral tunnel endpoint for display (#privacy). */
export function maskTunnelUrl(url: string): string {
  try {
    const u = new URL(url);
    const suffix = TUNNEL_SUFFIXES.find((s) => u.hostname.endsWith(s));
    if (!suffix) return url;
    return `${u.protocol}//****${suffix}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}
