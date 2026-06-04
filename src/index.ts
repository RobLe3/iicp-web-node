// SPDX-License-Identifier: Apache-2.0
//
// @iicp/client-wasm — browser-native, consumer-only IICP client.
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

/**
 * Minimal CIP consumer envelope (JSON form). The consumer wraps its payload with
 * the cooperative-inference policy it requires; a provider node honours or rejects it.
 * JSON-first by design (no CBOR dependency — keeps the bundle ~100KB per #292).
 */
export interface CipEnvelope {
  iicp_version: "1";
  mode: "consumer";
  intent: string;
  payload: unknown;
  cip_policy: {
    allow_remote_inference: boolean;
    allow_tool_execution: boolean;
    allow_file_access: boolean;
  };
}

export function cipConsumerEnvelope(
  intent: string,
  payload: unknown,
  policy?: Partial<CipEnvelope["cip_policy"]>,
): CipEnvelope {
  validateIntent(intent);
  return {
    iicp_version: "1",
    mode: "consumer",
    intent,
    payload,
    cip_policy: {
      allow_remote_inference: policy?.allow_remote_inference ?? true,
      allow_tool_execution: policy?.allow_tool_execution ?? false,
      allow_file_access: policy?.allow_file_access ?? false,
    },
  };
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
   * Route a chat to a node's endpoint (CIP consumer mode).
   *
   * ⚠ CORS reality (#448): from an https:// page the browser can reach iicp.network
   * (discover) but NOT http://localhost LLMs (mixed-content; Chrome 129+ flag only) nor
   * a discovered node that doesn't send Access-Control-Allow-Origin. Pass `endpoint`
   * explicitly to target a CORS-enabled or local-with-flag node. In Node there is no
   * CORS restriction. Returns the node's raw JSON response.
   */
  async chat(
    messages: ChatMessage[],
    opts: { endpoint: string; intent?: string; model?: string },
  ): Promise<Record<string, unknown>> {
    const intent = opts.intent ?? "urn:iicp:intent:llm:chat:v1";
    const envelope = cipConsumerEnvelope(intent, { messages, model: opts.model });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const resp = await fetch(`${opts.endpoint.replace(/\/+$/, "")}/v1/call`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(envelope),
      });
      if (!resp.ok) {
        throw new IicpError(`chat → ${resp.status}`, "node_error", resp.status);
      }
      return (await resp.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(t);
    }
  }
}
