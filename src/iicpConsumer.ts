// SPDX-License-Identifier: Apache-2.0
// Browser-safe consumer used by @iicp/web-node and vendored by iicp.network.
// Keep both copies aligned when publishing this package.

//
// @iicp/web-node — browser-native IICP consumer module.
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

import { encryptPayload, type CxPublicKey } from "./cxConfidentiality.js";

const REFUSED_INTENT_RULES = [
  { category: "prohibited", rule_id: "eu-ai-act-social-scoring", label: "social scoring", fragments: ["social-scoring", "social_scoring", "social:scoring"] },
  { category: "prohibited", rule_id: "eu-ai-act-criminal-risk", label: "individual criminal risk prediction", fragments: ["criminal-risk", "criminal_risk", "criminal:risk", "predict-crime"] },
  { category: "prohibited", rule_id: "eu-ai-act-workplace-education-emotion", label: "workplace or education emotion recognition", fragments: ["emotion:workplace", "emotion:education", "workplace-monitoring", "education-monitoring", "worker-monitoring"] },
  { category: "prohibited", rule_id: "eu-ai-act-protected-trait-biometric", label: "biometric protected-trait classification", fragments: ["protected-trait", "protected_trait", "biometric:protected"] },
  { category: "prohibited", rule_id: "eu-ai-act-untargeted-face-scraping", label: "untargeted facial image scraping", fragments: ["untargeted-scraping", "untargeted_scraping", "face-scraping", "facial-scraping"] },
  { category: "prohibited", rule_id: "eu-ai-act-realtime-remote-biometric-id", label: "real-time remote biometric identification", fragments: ["remote-biometric:realtime", "realtime-remote-biometric", "real-time-remote-biometric"] },
  { category: "prohibited", rule_id: "eu-ai-act-nonconsensual-sexual-deepfake", label: "non-consensual sexual deepfake or CSAM generation", fragments: ["nonconsensual-sexual", "non-consensual-sexual", "child-sexual-abuse", "csam"] },
  { category: "high_risk", rule_id: "eu-ai-act-employment-workforce", label: "employment or workforce decision", fragments: ["employment:hiring", "employment:screen", "employment:rank", "recruitment:decision", "workforce:decision", "worker-management", "worker:performance", "worker:discipline"] },
  { category: "high_risk", rule_id: "eu-ai-act-education-admission-grading", label: "education admission or grading decision", fragments: ["education:admission", "education:grading", "education:grade", "student:admission", "student:assess", "exam-grading"] },
  { category: "high_risk", rule_id: "eu-ai-act-credit-essential-services", label: "credit or essential-services decision", fragments: ["credit-scoring", "credit:score", "credit:decision", "essential-services", "benefits:eligibility", "public-benefit:eligibility"] },
  { category: "high_risk", rule_id: "eu-ai-act-law-enforcement-border-justice", label: "law enforcement, border, justice or democratic-process decision", fragments: ["law-enforcement", "law_enforcement", "migration:decision", "asylum:decision", "border-control", "justice:decision", "democratic-process", "election:decision"] },
  { category: "high_risk", rule_id: "eu-ai-act-healthcare-critical-infrastructure", label: "healthcare or critical-infrastructure safety decision", fragments: ["healthcare:decision", "medical:diagnosis", "medical:triage", "clinical:decision", "critical-infrastructure", "grid:stabilize", "hospital:surge-capacity"] },
  { category: "high_risk", rule_id: "eu-ai-act-physical-world-control", label: "physical-world control", fragments: ["robotics:control", "robotics:fleet", "drone:control", "drone:search", "iot:actuate", "physical-world", "system_control"] },
] as const;

/** Intent URN shape — parity with @iicp/client (SDK-02). */
const INTENT_RE = /^urn:iicp:intent:[a-z0-9_:/-]+$/;

export const DEFAULT_DIRECTORY_URL = "https://iicp.network";

export interface ClientConfig {
  /** Directory base URL. Default: https://iicp.network (CORS-enabled). */
  directory_url?: string;
  /** Per-request timeout (ms). Default 10000. */
  timeout_ms?: number;
  /**
   * Optional fail-closed transfer/region policy. When set, discovery and
   * dispatch keep only nodes whose directory-safe `region` is in this list.
   * Empty/omitted means normal open-mesh routing.
   */
  allowed_regions?: string[];
  /**
   * Optional fail-closed node-policy requirement. When set, discovery and
   * dispatch keep only nodes whose directory-computed policy manifest identity
   * level is at least this strong. This is a technical accountability signal,
   * not legal/DPA compliance proof.
   */
  required_manifest_identity_level?: RequiredManifestIdentityLevel;
  /** Ticketed route migration mode. Default: auto. */
  route_discovery_mode?: "auto" | "ticketed" | "legacy";
}

export interface DiscoverOptions {
  region?: string;
  min_reputation?: number;
  /** Max nodes to return (directory caps at 50). */
  limit?: number;
  /** Browser pages should keep only HTTPS/loopback endpoints. Default: true. */
  browser_usable_only?: boolean;
  /** Optional per-discovery strict region allowlist; overrides client default. */
  allowed_regions?: string[];
  /** Optional per-discovery policy-manifest identity requirement; overrides client default. */
  required_manifest_identity_level?: RequiredManifestIdentityLevel;
}

export type RequiredManifestIdentityLevel = "signed_valid" | "operator_bound" | "known_operator";

/** A discoverable provider node (public discovery view — no tokens/endpoints private). */
export interface Node {
  node_id: string;
  endpoint: string;
  region?: string;
  reputation_score?: number;
  reputation_tier?: string;
  models?: string[];
  directory_observed_reachable?: boolean | null;
  route_evidence?: string;
  routing_hint?: string;
  browser_usable?: boolean;
  node_policy_manifest?: {
    manifest_identity_level?: string | null;
    verification?: { status?: string | null };
  } | null;
  dispatch_ticket_id_prefix?: string;
  [k: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Compatibility helper for callers that need to inspect or test the canonical
 * plaintext task shape. Production `chat()` remains fail-closed and sends only
 * an encrypted `iicp_conf` envelope.
 */
export interface TaskEnvelope {
  task_id: string;
  intent: string;
  constraints: Record<string, unknown>;
  payload: { messages: ChatMessage[]; model?: string };
}

export function cipConsumerEnvelope(
  messages: ChatMessage[],
  opts: { intent?: string; model?: string; task_id?: string } = {},
): TaskEnvelope {
  const intent = opts.intent ?? "urn:iicp:intent:llm:chat:v1";
  validateIntent(intent);
  const taskId = opts.task_id
    ?? (globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    task_id: taskId,
    intent,
    constraints: {},
    payload: { messages, model: opts.model },
  };
}

export interface RoutingReceipt {
  receipt_version: "iicp-routing-receipt-v1";
  trace_id: string;
  task_id: string;
  issued_at: string;
  status: "attempted" | "ok";
  intent: string;
  generated_by_ai: true;
  dispatch_ticket_id_prefix?: string;
  selected_node: {
    node_id_prefix?: string;
    region?: string;
    reputation_tier?: string;
    reputation_score?: number;
    model?: string;
  };
  transport: {
    endpoint_kind: "https_public" | "https_tunnel" | "http_loopback" | "other" | "unknown";
    relay_used: boolean;
  };
  policy: {
    cx_required: true;
    cx_key_status: "present";
    cx_key_id?: string;
    plaintext_allowed: false;
    directory_prompt_free: true;
    region_policy: "not_configured" | "allowed_regions_strict";
    allowed_regions?: string[];
    selected_region_allowed?: boolean;
    region_policy_decision?: RegionPolicyDecision["reason"];
    manifest_identity_policy: "not_configured" | "minimum_required";
    required_manifest_identity_level?: RequiredManifestIdentityLevel;
    selected_manifest_identity_level?: string;
  };
  redaction: {
    prompt_content: "excluded";
    response_content: "excluded";
    node_token: "excluded";
    endpoint_url: "not_recorded";
  };
}

export interface RegionPolicyDecision {
  active: boolean;
  allowed_regions?: string[];
  selected_region?: string;
  selected_region_allowed?: boolean;
  reason: "not_configured" | "allowed" | "missing_region" | "region_not_allowed";
}

export interface ManifestIdentityPolicyDecision {
  active: boolean;
  required_level?: RequiredManifestIdentityLevel;
  selected_level?: string;
  selected_level_allowed?: boolean;
  reason: "not_configured" | "allowed" | "missing_manifest" | "insufficient_level" | "revoked_or_rotated";
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

class LegacyDiscoveryRequired extends Error {}

function validateIntent(intent: string): void {
  if (!INTENT_RE.test(intent)) {
    throw new IicpError(`invalid intent URN: ${intent}`, "invalid_intent");
  }
  const normalized = intent.trim().toLowerCase();
  const rule = REFUSED_INTENT_RULES.find((candidate) =>
    candidate.fragments.some((fragment) => normalized.includes(fragment)),
  );
  if (rule) {
    throw new IicpError(
      `intent refused by public-mesh policy: ${rule.label} (${rule.rule_id}) [${rule.category}]`,
      "intent_policy_refused",
    );
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

function isBrowserUsableEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function safeNodePrefix(nodeId: unknown): string | undefined {
  return typeof nodeId === "string" && nodeId.length > 0 ? `${nodeId.slice(0, 8)}…` : undefined;
}

function endpointKind(endpoint: string | undefined): RoutingReceipt["transport"]["endpoint_kind"] {
  if (!endpoint) return "unknown";
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol === "https:" && TUNNEL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return "https_tunnel";
    if (url.protocol === "https:") return "https_public";
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname)) return "http_loopback";
  } catch {
    return "unknown";
  }
  return "other";
}

export function normalizeAllowedRegions(regions?: readonly string[] | null): string[] {
  if (!regions) return [];
  return Array.from(new Set(
    regions
      .map((region) => region.trim().toLowerCase())
      .filter((region) => region.length > 0),
  )).sort();
}

function normalizeNodeRegion(node?: Node): string | undefined {
  const region = typeof node?.region === "string" ? node.region.trim().toLowerCase() : "";
  return region.length > 0 ? region : undefined;
}

export function regionPolicyDecision(node: Node | undefined, allowedRegions?: readonly string[] | null): RegionPolicyDecision {
  const allowed = normalizeAllowedRegions(allowedRegions);
  if (allowed.length === 0) {
    return { active: false, reason: "not_configured" };
  }
  const selected = normalizeNodeRegion(node);
  if (!selected) {
    return {
      active: true,
      allowed_regions: allowed,
      selected_region_allowed: false,
      reason: "missing_region",
    };
  }
  const ok = allowed.includes(selected);
  return {
    active: true,
    allowed_regions: allowed,
    selected_region: selected,
    selected_region_allowed: ok,
    reason: ok ? "allowed" : "region_not_allowed",
  };
}

export function filterNodesByAllowedRegions(nodes: Node[], allowedRegions?: readonly string[] | null): Node[] {
  const allowed = normalizeAllowedRegions(allowedRegions);
  if (allowed.length === 0) return nodes;
  return nodes.filter((node) => regionPolicyDecision(node, allowed).selected_region_allowed === true);
}

const MANIFEST_IDENTITY_RANK: Record<string, number> = {
  self_attested: 0,
  signed_valid: 1,
  operator_bound: 2,
  known_operator: 3,
  rotated: -1,
  revoked: -1,
};

function manifestIdentityLevel(node?: Node): string | undefined {
  const level = node?.node_policy_manifest?.manifest_identity_level;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}

export function manifestIdentityPolicyDecision(
  node: Node | undefined,
  requiredLevel?: RequiredManifestIdentityLevel | null,
): ManifestIdentityPolicyDecision {
  if (!requiredLevel) {
    return { active: false, reason: "not_configured" };
  }
  const selected = manifestIdentityLevel(node);
  if (!selected) {
    return {
      active: true,
      required_level: requiredLevel,
      selected_level_allowed: false,
      reason: "missing_manifest",
    };
  }
  if (selected === "revoked" || selected === "rotated") {
    return {
      active: true,
      required_level: requiredLevel,
      selected_level: selected,
      selected_level_allowed: false,
      reason: "revoked_or_rotated",
    };
  }
  const ok = (MANIFEST_IDENTITY_RANK[selected] ?? -1) >= MANIFEST_IDENTITY_RANK[requiredLevel];
  return {
    active: true,
    required_level: requiredLevel,
    selected_level: selected,
    selected_level_allowed: ok,
    reason: ok ? "allowed" : "insufficient_level",
  };
}

export function filterNodesByManifestIdentity(
  nodes: Node[],
  requiredLevel?: RequiredManifestIdentityLevel | null,
): Node[] {
  if (!requiredLevel) return nodes;
  return nodes.filter((node) => manifestIdentityPolicyDecision(node, requiredLevel).selected_level_allowed === true);
}

function assertAllowedRegionForNode(node: Node | undefined, allowedRegions?: readonly string[] | null): RegionPolicyDecision {
  const decision = regionPolicyDecision(node, allowedRegions);
  if (decision.active && decision.selected_region_allowed !== true) {
    throw new IicpError(
      decision.reason === "missing_region"
        ? "IICP strict region policy refused node before task dispatch: node region is missing"
        : `IICP strict region policy refused node before task dispatch: region ${decision.selected_region ?? "unknown"} is not allowed`,
      "region_not_allowed",
    );
  }
  return decision;
}

function assertManifestIdentityForNode(
  node: Node | undefined,
  requiredLevel?: RequiredManifestIdentityLevel | null,
): ManifestIdentityPolicyDecision {
  const decision = manifestIdentityPolicyDecision(node, requiredLevel);
  if (decision.active && decision.selected_level_allowed !== true) {
    throw new IicpError(
      decision.reason === "missing_manifest"
        ? `IICP strict policy refused node before task dispatch: missing policy manifest identity level ${requiredLevel}`
        : `IICP strict policy refused node before task dispatch: manifest identity ${decision.selected_level ?? "unknown"} is below ${requiredLevel}`,
      "manifest_identity_not_allowed",
    );
  }
  return decision;
}

export function createRedactedRoutingReceipt(args: {
  taskId: string;
  intent: string;
  endpoint?: string;
  node?: Node;
  model?: string;
  cxPublicKey: CxPublicKey;
  status?: RoutingReceipt["status"];
  allowedRegions?: readonly string[] | null;
  requiredManifestIdentityLevel?: RequiredManifestIdentityLevel | null;
}): RoutingReceipt {
  const regionDecision = regionPolicyDecision(args.node, args.allowedRegions);
  const manifestDecision = manifestIdentityPolicyDecision(args.node, args.requiredManifestIdentityLevel);
  return {
    receipt_version: "iicp-routing-receipt-v1",
    trace_id: args.taskId,
    task_id: args.taskId,
    issued_at: new Date().toISOString(),
    status: args.status ?? "attempted",
    intent: args.intent,
    generated_by_ai: true,
    dispatch_ticket_id_prefix: args.node?.dispatch_ticket_id_prefix,
    selected_node: {
      node_id_prefix: safeNodePrefix(args.node?.node_id),
      region: args.node?.region,
      reputation_tier: typeof args.node?.reputation_tier === "string" ? args.node.reputation_tier : undefined,
      reputation_score: typeof args.node?.reputation_score === "number" ? args.node.reputation_score : undefined,
      model: args.model,
    },
    transport: {
      endpoint_kind: endpointKind(args.endpoint),
      relay_used: args.node?.relay_capable === true || args.node?.routing_hint === "relay",
    },
    policy: {
      cx_required: true,
      cx_key_status: "present",
      cx_key_id: args.cxPublicKey.key_id,
      plaintext_allowed: false,
      directory_prompt_free: true,
      region_policy: regionDecision.active ? "allowed_regions_strict" : "not_configured",
      allowed_regions: regionDecision.allowed_regions,
      selected_region_allowed: regionDecision.active ? regionDecision.selected_region_allowed : undefined,
      region_policy_decision: regionDecision.active ? regionDecision.reason : undefined,
      manifest_identity_policy: manifestDecision.active ? "minimum_required" : "not_configured",
      required_manifest_identity_level: manifestDecision.required_level,
      selected_manifest_identity_level: manifestDecision.selected_level,
    },
    redaction: {
      prompt_content: "excluded",
      response_content: "excluded",
      node_token: "excluded",
      endpoint_url: "not_recorded",
    },
  };
}

/** Browser-native, consumer-only IICP client. */
export class IicpBrowserClient {
  private readonly directory: string;
  private readonly timeout: number;
  private readonly allowedRegions: string[];
  private readonly requiredManifestIdentityLevel?: RequiredManifestIdentityLevel;
  private readonly routeDiscoveryMode: "auto" | "ticketed" | "legacy";

  constructor(cfg: ClientConfig = {}) {
    this.directory = (cfg.directory_url ?? DEFAULT_DIRECTORY_URL).replace(/\/+$/, "");
    this.timeout = cfg.timeout_ms ?? 10_000;
    this.allowedRegions = normalizeAllowedRegions(cfg.allowed_regions);
    this.requiredManifestIdentityLevel = cfg.required_manifest_identity_level;
    this.routeDiscoveryMode = cfg.route_discovery_mode ?? "auto";
  }

  private effectiveAllowedRegions(override?: readonly string[] | null): string[] {
    return override !== undefined ? normalizeAllowedRegions(override) : this.allowedRegions;
  }

  private effectiveManifestIdentityLevel(override?: RequiredManifestIdentityLevel | null): RequiredManifestIdentityLevel | undefined {
    return override !== undefined ? (override ?? undefined) : this.requiredManifestIdentityLevel;
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

  private async ticketedDiscover(intent: string, opts: DiscoverOptions): Promise<Node[]> {
    const url = `${this.directory}/api/v1/dispatch/ticket`;
    const excluded: string[] = [];
    const nodes: Node[] = [];
    const limit = Math.max(1, Math.min(opts.limit ?? 4, 10));
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            intent,
            region: opts.region,
            min_reputation: opts.min_reputation,
            limit,
            exclude_node_id_prefixes: excluded,
          }),
        });
      } finally {
        clearTimeout(timer);
      }
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const error = body.error as Record<string, unknown> | undefined;
      const errorCode = typeof error?.code === "string" ? error.code : undefined;
      if (response.status === 201) {
        const route = body.route as Record<string, unknown> | undefined;
        if (!route || typeof body.node_id !== "string") {
          throw new IicpError("ticketed route response is malformed", "ticket_malformed");
        }
        const node = {
          ...route,
          node_id: body.node_id,
          dispatch_ticket_id_prefix: typeof body.ticket_id_prefix === "string" ? body.ticket_id_prefix : undefined,
        } as Node;
        nodes.push(node);
        excluded.push(body.node_id.slice(0, 8));
        continue;
      }
      if (response.status === 404 && errorCode === "no_route_available") break;
      if ([404, 405, 501].includes(response.status) || (response.status === 503 && errorCode === "not_configured")) {
        throw new LegacyDiscoveryRequired();
      }
      throw new IicpError(
        `ticketed route request refused (${errorCode ?? response.status})`,
        "ticket_refused",
        response.status,
      );
    }
    return nodes;
  }

  /** Discover nodes capable of an intent (GET /v1/discover — CORS-enabled on iicp.network). */
  async discover(intent: string, opts: DiscoverOptions = {}): Promise<Node[]> {
    validateIntent(intent);
    let nodes: Node[];
    if (this.routeDiscoveryMode === "legacy") {
      const body = await this.getJson<{ nodes?: Node[] } | Node[]>(discoverUrl(this.directory, intent, opts));
      nodes = Array.isArray(body) ? body : (body.nodes ?? []);
    } else {
      try {
        nodes = await this.ticketedDiscover(intent, opts);
      } catch (error) {
        if (!(error instanceof LegacyDiscoveryRequired)) throw error;
        if (this.routeDiscoveryMode === "ticketed") {
          throw new IicpError("directory does not support ticketed dispatch", "ticket_unavailable");
        }
        const body = await this.getJson<{ nodes?: Node[] } | Node[]>(discoverUrl(this.directory, intent, opts));
        nodes = Array.isArray(body) ? body : (body.nodes ?? []);
      }
    }
    const browserUsableNodes = opts.browser_usable_only === false ? nodes : nodes.filter((node) => {
      if (typeof node.browser_usable === "boolean") return node.browser_usable;
      return isBrowserUsableEndpoint(String(node.endpoint ?? ""));
    });
    const regionFiltered = filterNodesByAllowedRegions(browserUsableNodes, this.effectiveAllowedRegions(opts.allowed_regions));
    return filterNodesByManifestIdentity(regionFiltered, this.effectiveManifestIdentityLevel(opts.required_manifest_identity_level));
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
 * Privacy: IICP-CX is fail-closed in the browser too.  A discovered node must
 * advertise `cx_public_key` (or the temporary `public_key` alias) before this
 * helper will send it a task.
 *
 * ⚠ Reachability: from an https:// page the browser reaches iicp.network (discover) but
   * NOT http://localhost LLMs (mixed-content; Chrome 129+ flag only), nor a node without
   * CORS, nor an IPv6-firewalled node (today's live nodes are `ipv6_direct_firewall_required`).
   * Pass a reachable `endpoint`. In Node there is no CORS restriction. Returns the node JSON.
   */
  async chat(
    messages: ChatMessage[],
    opts: { endpoint: string; intent?: string; model?: string; cxPublicKey?: CxPublicKey | null; node?: Node; allowed_regions?: string[]; required_manifest_identity_level?: RequiredManifestIdentityLevel | null },
  ): Promise<Record<string, unknown>> {
    const routed = await this.chatWithReceipt(messages, opts);
    return routed.response;
  }

  /**
   * Same dispatch as `chat()`, but returns a redacted routing receipt. The receipt
   * deliberately excludes prompt text, response text, node tokens and endpoint URLs.
   */
  async chatWithReceipt(
    messages: ChatMessage[],
    opts: { endpoint: string; intent?: string; model?: string; cxPublicKey?: CxPublicKey | null; node?: Node; allowed_regions?: string[]; required_manifest_identity_level?: RequiredManifestIdentityLevel | null },
  ): Promise<{ response: Record<string, unknown>; receipt: RoutingReceipt }> {
    const intent = opts.intent ?? "urn:iicp:intent:llm:chat:v1";
    validateIntent(intent);
    const taskId =
      globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = { messages, model: opts.model };
    // IICP-CX S.16: encryption is MANDATORY (privacy-first #360) — no opt-out.
    // Refuse keyless nodes instead of silently regressing to plaintext.
    if (!opts.cxPublicKey) {
      throw new IicpError(
        "IICP-CX confidentiality required: node advertises no cx_public_key/public_key",
        "cx_required",
      );
    }
    const allowedRegions = this.effectiveAllowedRegions(opts.allowed_regions);
    const requiredManifestIdentityLevel = this.effectiveManifestIdentityLevel(opts.required_manifest_identity_level);
    assertAllowedRegionForNode(opts.node, allowedRegions);
    assertManifestIdentityForNode(opts.node, requiredManifestIdentityLevel);
    const receipt = createRedactedRoutingReceipt({
      taskId,
      intent,
      endpoint: opts.endpoint,
      node: opts.node,
      model: opts.model,
      cxPublicKey: opts.cxPublicKey,
      status: "attempted",
      allowedRegions,
      requiredManifestIdentityLevel,
    });
    const body: Record<string, unknown> = {
      task_id: taskId,
      intent,
      constraints: {},
      iicp_conf: await encryptPayload(payload, opts.cxPublicKey, taskId, intent),
    };
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
      return {
        response: (await resp.json()) as Record<string, unknown>,
        receipt: { ...receipt, status: "ok", issued_at: new Date().toISOString() },
      };
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Mask the high-entropy random subdomain of an ephemeral tunnel endpoint for
 * display (#privacy — maintainer 2026-06-12: keep tunnel DNS names private,
 * like node UUIDs are shown only as prefixes). The random label of a
 * *.trycloudflare.com (or other known tunnel-provider) host is a capability
 * secret — anyone who learns it has a direct line to the operator's machine.
 * Routing code keeps the real URL; only human-facing surfaces mask it.
 * Operator-chosen public domains (e.g. iicp.shaal.dev) are left intact.
 */
const TUNNEL_SUFFIXES = [".trycloudflare.com", ".ngrok.io", ".ngrok-free.app", ".loca.lt"];

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
