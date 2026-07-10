// SPDX-License-Identifier: Apache-2.0
//
// Browser node provider glue — issue #452 (the "serve into the mesh" half
// of the hybrid browser node #449).
//
// Pairs the WebLLM runtime (webllmRuntime.ts, #451) with the HTTP long-poll
// relay transport (#450, iicp-client >= 0.7.56 relay nodes):
//
//   1. Register with the directory (CORS is open on /api/v1/*) advertising
//      endpoint = {relay}/v1/relay-for/{node_id}  (transport_method=turn_relay)
//   2. Bind to the relay: POST /v1/relay/bind → bearer session token
//   3. Poll loop: GET /v1/relay/pull (long-poll) → run WebLLM chat() →
//      POST /v1/relay/result  (OpenAI-shape choices, same as SDK nodes)
//   4. Heartbeat the directory every 30 s; unbind + deregister on stop.
//
// Wire contracts mirror the Python SDK reference (node.py register()/
// _heartbeat payloads, client.py chat_async() result parsing) so PUBLISHED
// consumers route to a browser worker with zero client changes.

import { maskTunnelUrl } from "./iicpConsumer.js";
import type { ChatMessage } from "./iicpConsumer.js";
import { createCxKeyPair, decryptPayload } from "./cxConfidentiality.js";

export interface BrowserProviderRuntime {
  chat(
    messages: ChatMessage[],
    opts?: { temperature?: number; max_tokens?: number },
  ): Promise<string>;
}

export interface BrowserProviderConfig {
  /** Relay node base URL, e.g. "http://127.0.0.1:9484". Required. */
  relayUrl: string;
  /** Auto-discovered relay node id. Used to audience-scope relay bind tickets. */
  relayNodeId?: string;
  /** Directory API base. Default: "https://iicp.network/api". */
  directoryUrl?: string;
  /** Model name advertised to the directory (the loaded WebLLM model id). */
  model: string;
  region?: string;
  onLog?: (line: string) => void;
  /** Called after each served task with the running total. */
  onTaskServed?: (total: number) => void;
  onStateChange?: (state: BrowserProviderState) => void;
  onRecoveryChange?: (diagnostic: BrowserProviderDiagnostic) => void;
}

export type BrowserProviderState = "stopped" | "starting" | "serving" | "error";
export type BrowserProviderRecoveryState =
  | "stable"
  | "tunnel_starting"
  | "route_mismatch"
  | "operator_action_needed"
  | "unavailable";
export type BrowserProviderRecoveryAction =
  | "none"
  | "reregister"
  | "wait_cooldown"
  | "operator_endpoint_needed";

export interface BrowserProviderDiagnostic {
  recovery_state: BrowserProviderRecoveryState;
  recovery_action: BrowserProviderRecoveryAction;
  directory_listed: boolean;
  relay_bound: boolean;
  tasks_served: number;
}

const CHAT_INTENT = "urn:iicp:intent:llm:chat:v1";
export const BROWSER_NODE_SDK_VERSION = "0.7.86-browser";

/**
 * Coarse region autodetect from the browser's timezone (no network, no
 * geolocation permission). Matches the mesh's region convention
 * (eu-central / us-east / …) as a SCORING HINT — deliberately coarse;
 * operators can override via config. "(Browser)" is shown separately on
 * the nodes page via sdk_language.
 */
export function detectRegion(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    const continent = tz.split("/")[0];
    const offset = -new Date().getTimezoneOffset() / 60; // hours east of UTC
    switch (continent) {
      case "Europe":
        return offset <= 0.5 ? "eu-west" : "eu-central";
      case "America":
        if (offset <= -7) return "us-west";
        if (offset <= -5.5) return "us-central";
        if (offset <= -3.5) return "us-east";
        return "sa-east";
      case "Asia":
        if (offset >= 8.5) return "ap-northeast";
        if (offset >= 6.5) return "ap-east";
        return "ap-south";
      case "Australia":
      case "Pacific":
        return "ap-southeast";
      case "Africa":
        return "af-central";
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}
const HEARTBEAT_MS = 30_000;
const POLL_ERROR_BACKOFF_MS = 2_000;

export interface DiscoveredRelay {
  endpoint: string;
  nodeId: string;
  reputation: number;
  probation: boolean;
}

/**
 * Auto-discover a browser-usable relay from the live directory (WQ-087 — the
 * web client's "automagical" rung; tabs can't spawn tunnels, so relays carry
 * them). Client-side filtering remains a hardening guard (not a dependency):
 * the directory filter is server-side and authoritative when enabled, and query
 * width is kept at 50 to avoid default-window clipping of relays.
 * Browser-usable = https endpoint (or loopback
 * http for local testing — loopback is a trustworthy origin).
 *
 * Red-team F3: a malicious relay sees & can inject the tasks a browser serves
 * through it. Full trust needs relay attestation; as an interim mitigation we
 * (a) drop relays below a hard floor (actively demoted / bad actors), (b)
 * PREFER the highest-reputation, non-probationary relay, and (c) return the
 * relay's node_id + trust state so the UI shows exactly what's being trusted.
 *
 * We do NOT hard-block probation: a brand-new relay is always on probation, so
 * blocking it would mean no relay can ever bootstrap (it can't earn reputation
 * without being used). Probationary relays sort LAST and are clearly labelled;
 * the operator consents by clicking "Start serving".
 */
const MIN_RELAY_REPUTATION = 0.1; // hard floor — drop actively-demoted nodes only

export async function discoverRelay(
  directoryUrl = "https://iicp.network/api",
): Promise<DiscoveredRelay | null> {
  try {
    const base = directoryUrl.replace(/\/$/, "");
    const resp = await fetch(`${base}/v1/dispatch/ticket`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ intent: CHAT_INTENT, relay_capable: true, limit: 1 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const route = data?.route;
    const nodes: Array<{
      relay_capable?: boolean;
      endpoint?: string;
      node_id?: string;
      reputation_score?: number;
      score?: number;
      probation?: boolean;
      browser_usable?: boolean;
      routing_hint?: string;
    }> = route && typeof route === "object"
      ? [{ ...route, node_id: data?.node_id, relay_capable: true }]
      : [];

    const isLoopback = (ep: string) => /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(ep);
    const usable = nodes
      .filter(
        (n) =>
          n.relay_capable === true &&
          typeof n.endpoint === "string" &&
          (n.browser_usable === true || n.endpoint.startsWith("https://") || isLoopback(n.endpoint)),
      )
      .map((n) => ({
        endpoint: (n.endpoint as string).replace(/\/$/, ""),
        nodeId: n.node_id ?? "relay",
        reputation: typeof n.reputation_score === "number" ? n.reputation_score : 0,
        probation: n.probation === true,
        loopback: isLoopback(n.endpoint as string),
      }))
      // F3: drop only below-the-hard-floor (demoted) relays; keep loopback
      // (local operator testing, trusted by definition).
      .filter((r) => r.loopback || r.reputation >= MIN_RELAY_REPUTATION)
      // Prefer loopback (local) → non-probationary → higher reputation.
      .sort(
        (a, b) =>
          (b.loopback ? 1 : 0) - (a.loopback ? 1 : 0) ||
          (a.probation ? 1 : 0) - (b.probation ? 1 : 0) ||
          b.reputation - a.reputation,
      );

    const top = usable[0];
    return top
      ? { endpoint: top.endpoint, nodeId: top.nodeId, reputation: top.reputation, probation: top.probation }
      : null;
  } catch {
    return null;
  }
}

export class BrowserProviderError extends Error {
  constructor(message: string, readonly stage: "register" | "bind" | "serve") {
    super(message);
    this.name = "BrowserProviderError";
  }
}

export class BrowserNodeProvider {
  readonly nodeId: string;
  private _state: BrowserProviderState = "stopped";
  private _nodeToken = "";
  private _sessionToken = "";
  private _tasksServed = 0;
  // Success/fail since the last heartbeat (reset each beat — mirrors the SDK).
  private _okSinceBeat = 0;
  private _failSinceBeat = 0;
  private _latencyMsSinceBeat = 0;
  private readonly _cx = createCxKeyPair();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _stopRequested = false;
  private _recoveryState: BrowserProviderRecoveryState = "unavailable";
  private _recoveryAction: BrowserProviderRecoveryAction = "operator_endpoint_needed";
  /** True when the directory accepted the registration (mesh-discoverable). */
  directoryListed = false;

  constructor(
    private readonly runtime: BrowserProviderRuntime,
    private readonly cfg: BrowserProviderConfig,
  ) {
    this.nodeId = `browser-${crypto.randomUUID().slice(0, 8)}`;
  }

  get state(): BrowserProviderState {
    return this._state;
  }

  get tasksServed(): number {
    return this._tasksServed;
  }

  get diagnostic(): BrowserProviderDiagnostic {
    return {
      recovery_state: this._recoveryState,
      recovery_action: this._recoveryAction,
      directory_listed: this.directoryListed,
      relay_bound: Boolean(this._sessionToken),
      tasks_served: this._tasksServed,
    };
  }

  private get directoryBase(): string {
    return (this.cfg.directoryUrl ?? "https://iicp.network/api").replace(/\/$/, "");
  }

  private get relayBase(): string {
    return this.cfg.relayUrl.replace(/\/$/, "");
  }

  private log(line: string): void {
    this.cfg.onLog?.(line);
  }

  private setState(s: BrowserProviderState): void {
    this._state = s;
    this.cfg.onStateChange?.(s);
  }

  private setRecovery(
    state: BrowserProviderRecoveryState,
    action: BrowserProviderRecoveryAction,
  ): void {
    this._recoveryState = state;
    this._recoveryAction = action;
    this.cfg.onRecoveryChange?.(this.diagnostic);
  }

  /** Register → obtain bind ticket → bind → serve. */
  async start(): Promise<void> {
    if (this._state === "serving" || this._state === "starting") return;
    this._stopRequested = false;
    this.setState("starting");
    this.setRecovery("tunnel_starting", "wait_cooldown");

    const endpoint = `${this.relayBase}/v1/relay-for/${this.nodeId}`;

    // 1. Register first. Strict relays require a directory-issued bind ticket,
    // which in turn requires the worker's node token. A failed later bind is
    // immediately cleaned up so this ordering does not leave stale listings.
    await this.register(endpoint);

    // 2. Obtain a short-lived worker/audience-scoped bind ticket. Only an
    // explicit older-directory response may use the legacy soft-bind path.
    let bindTicket = "";
    if (this._nodeToken) {
      bindTicket = await this.fetchBindTicket();
    }

    // 3. Bind to the relay, presenting the ticket whenever one was issued.
    let bindResp: Response;
    try {
      bindResp = await fetch(`${this.relayBase}/v1/relay/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worker_id: this.nodeId,
          intent: CHAT_INTENT,
          models: [this.cfg.model],
          ...(bindTicket ? { bind_ticket: bindTicket } : {}),
        }),
      });
    } catch (err) {
      this.setRecovery("operator_action_needed", "operator_endpoint_needed");
      this.setState("error");
      await this.deregisterQuietly();
      throw new BrowserProviderError(
        `relay unreachable at ${maskTunnelUrl(this.relayBase)}: ${err instanceof Error ? err.message : String(err)}`,
        "bind",
      );
    }
    if (!bindResp.ok) {
      this.setState("error");
      const detail = await bindResp.text().catch(() => "");
      await this.deregisterQuietly();
      throw new BrowserProviderError(
        `relay bind failed: HTTP ${bindResp.status} ${detail.slice(0, 200)}`,
        "bind",
      );
    }
    const bind = await bindResp.json();
    this._sessionToken = bind.session_token;
    this.setRecovery("route_mismatch", "reregister");
    this.log(`relay bound — worker ${this.nodeId}`);
    if (this.directoryListed) this.setRecovery("stable", "none");

    // 4. Heartbeat (only when directory-listed) + poll loop.
    if (this.directoryListed) {
      void this.heartbeat();
      this._heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    }
    this.setState("serving");
    void this.pollLoop();
  }

  private async register(endpoint: string): Promise<void> {
    try {
      const regResp = await fetch(`${this.directoryBase}/v1/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: this.nodeId,
          endpoint,
          region: this.cfg.region ?? detectRegion(),
          capabilities: [
            {
              intent: CHAT_INTENT,
              models: [this.cfg.model],
              max_tokens: 1024,
              input_modalities: ["text"],
            },
          ],
          limits: { max_concurrent: 1, tokens_per_min: 6000 },
          transport_method: "turn_relay",
          exposure_mode: "relay_required",
          transport_metadata: {
            relay_for: this.nodeId,
            relay_transport: "http-poll",
          },
          sdk_language: "browser",
          sdk_version: BROWSER_NODE_SDK_VERSION,
          // The current directory contract accepts native backend identifiers
          // plus "custom". Browser/WebLLM providers are non-native providers,
          // so advertise them as custom until the protocol taxonomy grows a
          // dedicated browser backend token.
          backend: "custom",
          // IICP-CX S.16: browser providers are privacy-ready too.  The relay
          // still sees metadata, but not the task payload.
          cx_public_key: this._cx.publicKey,
        }),
      });
      if (!regResp.ok) {
        const detail = await regResp.text().catch(() => "");
        throw new Error(`HTTP ${regResp.status} ${detail.slice(0, 200)}`);
      }
      const reg = await regResp.json();
      this._nodeToken = reg.node_token ?? reg.token ?? "";
      if (!this._nodeToken) throw new Error("directory returned no node_token");
      this.directoryListed = true;
      this.log(`registered with directory as ${this.nodeId}`);
    } catch (err) {
      // Relay-only degradation: a rejected registration (e.g. IICP-E035
      // loopback-endpoint validation against a local test relay) means the
      // node is not mesh-discoverable, but consumers that know the relay
      // endpoint can still dispatch — keep serving and say so plainly.
      this.directoryListed = false;
      this.setRecovery("route_mismatch", "reregister");
      this.log(
        `directory registration rejected — serving relay-only (not discoverable): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async fetchBindTicket(): Promise<string> {
    let resp: Response;
    try {
      resp = await fetch(`${this.directoryBase}/v1/relay/ticket`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._nodeToken}`,
          "Content-Type": "application/json",
          // Opaque node tokens need an explicit subject hint; JWT-backed
          // clients can be resolved from their claims, but browser providers
          // intentionally use the portable opaque registration credential.
          "X-Node-Id": this.nodeId,
        },
        body: JSON.stringify({ relay_node_id: this.cfg.relayNodeId ?? "*" }),
      });
    } catch (err) {
      await this.deregisterQuietly();
      this.setState("error");
      throw new BrowserProviderError(
        `relay bind ticket request failed: ${err instanceof Error ? err.message : String(err)}`,
        "bind",
      );
    }

    if (resp.ok) {
      const body = await resp.json();
      if (typeof body.ticket !== "string" || !body.ticket) {
        await this.deregisterQuietly();
        throw new BrowserProviderError("directory returned no relay bind ticket", "bind");
      }
      return body.ticket;
    }

    const detail = await resp.text().catch(() => "");
    const legacy = resp.status === 404 || (resp.status === 503 && detail.includes("not_configured"));
    if (legacy) {
      this.log("directory has no relay bind-ticket service — trying legacy soft bind");
      return "";
    }

    await this.deregisterQuietly();
    this.setState("error");
    throw new BrowserProviderError(
      `relay bind ticket refused: HTTP ${resp.status} ${detail.slice(0, 200)}`,
      "bind",
    );
  }

  /** Unbind from the relay and deregister from the directory. */
  async stop(): Promise<void> {
    this._stopRequested = true;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    await this.unbindQuietly();
    await this.deregisterQuietly();
    this.setState("stopped");
  }

  private async deregisterQuietly(): Promise<void> {
    if (!this._nodeToken) return;
    try {
      await fetch(`${this.directoryBase}/v1/register`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this._nodeToken}`,
          // Opaque registration credentials carry no subject claim.
          "X-Node-Id": this.nodeId,
        },
        keepalive: true,
      });
      this.log("deregistered from directory");
    } catch {
      // best-effort — heartbeat expiry cleans up server-side
    }
    this._nodeToken = "";
    this.directoryListed = false;
  }

  private async unbindQuietly(): Promise<void> {
    if (!this._sessionToken) return;
    try {
      await fetch(`${this.relayBase}/v1/relay/unbind`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._sessionToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        keepalive: true,
      });
    } catch {
      // best-effort — relay liveness window GCs the session
    }
    this._sessionToken = "";
    if (!this._stopRequested) this.setRecovery("operator_action_needed", "operator_endpoint_needed");
  }

  private async heartbeat(): Promise<void> {
    if (!this._nodeToken) return;
    const ok = this._okSinceBeat;
    const fail = this._failSinceBeat;
    const latencyMs = this._latencyMsSinceBeat;
    this._okSinceBeat = 0;
    this._failSinceBeat = 0;
    this._latencyMsSinceBeat = 0;
    const payload: Record<string, unknown> = {
      node_id: this.nodeId,
      node_token: this._nodeToken,
      status: "available",
      available: true,
      max_concurrent: 1,
      // Liveness: the model is loaded and the tab is open. health_models is the
      // directory's signal that the advertised model is actually servable
      // (empty here would demote us in discover) — see #494.
      health_models: [this.cfg.model],
    };
    if (ok > 0 || fail > 0) {
      const total = ok + fail;
      payload.metrics = {
        tasks_success: ok,
        tasks_failed: fail,
        ...(latencyMs > 0 && total > 0
          ? { avg_latency_ms: Math.round((latencyMs / total) * 100) / 100 }
          : {}),
      };
    }
    try {
      const resp = await fetch(`${this.directoryBase}/v1/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._nodeToken}`,
        },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        this.log(
          `keep-alive ✓ (model loaded${ok || fail ? `, +${ok} ok / +${fail} fail` : ""})`,
        );
      } else {
        this.setRecovery("route_mismatch", "reregister");
        this.log(`keep-alive → HTTP ${resp.status}`);
      }
    } catch {
      this.setRecovery("route_mismatch", "reregister");
      this.log("keep-alive failed (transient)");
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this._stopRequested && this._sessionToken) {
      let resp: Response;
      try {
        resp = await fetch(`${this.relayBase}/v1/relay/pull`, {
          headers: { Authorization: `Bearer ${this._sessionToken}` },
        });
      } catch {
        if (this._stopRequested) return;
        await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
        continue;
      }
      if (resp.status === 204) continue; // idle window — poll again
      if (resp.status === 401) {
        // Session displaced or GC'd — stop serving rather than fight over the id.
        this.setRecovery("operator_action_needed", "operator_endpoint_needed");
        this.log("relay session expired — stopping");
        await this.stop();
        this.setState("error");
        return;
      }
      if (!resp.ok) {
        await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
        continue;
      }
      const call = await resp.json();
      void this.serveCall(call);
    }
  }

  private async serveCall(call: { call_id: string; task: Record<string, unknown> }): Promise<void> {
    const task = call.task ?? {};
    const taskId = String(task.task_id ?? call.call_id);
    const intent = typeof task.intent === "string" ? task.intent : CHAT_INTENT;
    let result: Record<string, unknown>;
    const started = performance.now();
    try {
      let taskPayload: unknown = task.payload ?? {};
      if (task.iicp_conf && typeof task.iicp_conf === "object") {
        taskPayload = await decryptPayload(
          task.iicp_conf as Record<string, unknown>,
          this._cx.secretKey,
          taskId,
          intent,
        );
      }
      const payload = (taskPayload ?? {}) as {
        messages?: ChatMessage[];
        max_tokens?: number;
        temperature?: number;
      };
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const text = await this.runtime.chat(messages, {
        ...(payload.temperature !== undefined && { temperature: payload.temperature }),
        ...(payload.max_tokens !== undefined && { max_tokens: payload.max_tokens }),
      });
      // OpenAI-shape choices — exactly what SDK consumers' chat() parses.
      result = {
        generated_by_ai: true,
        result: {
          choices: [
            {
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          model: this.cfg.model,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
      };
      this._tasksServed += 1;
      this._okSinceBeat += 1;
      this._latencyMsSinceBeat += Math.max(1, Math.round(performance.now() - started));
      this.cfg.onTaskServed?.(this._tasksServed);
      this.log(`served task ${String(task.task_id ?? call.call_id)}`);
    } catch (err) {
      this._failSinceBeat += 1;
      this._latencyMsSinceBeat += Math.max(1, Math.round(performance.now() - started));
      result = {
        result: {
          error: {
            code: "IICP-E020",
            message: `browser inference failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
      };
      this.log(`task failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await fetch(`${this.relayBase}/v1/relay/result`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ call_id: call.call_id, result }),
      });
    } catch {
      this.log("result delivery failed — consumer will see a timeout");
    }
  }
}
