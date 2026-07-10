# Changelog

## 0.2.1 — 2026-07-10

- Browser providers now register first, request a short-lived worker/relay-scoped bind ticket,
  and present it to the relay before serving.
- Authentication, ticket, and bind failures fail closed and clean up temporary directory
  registrations; compatibility fallback is limited to explicitly older directories.
- The website integration now passes the discovered relay node ID for audience-scoped tickets.

## 0.2.0 — 2026-07-10

- Prefer short-lived ticketed dispatch with controlled legacy-directory fallback.
- Add strict region and policy-manifest routing guards, redacted receipts, intent-risk refusal,
  and explicit AI-generated response metadata.
- Align browser-provider registration with the directory backend taxonomy (`custom`).
- Add deterministic provider recovery diagnostics and ticketed relay discovery.
- Preserve the existing fail-closed IICP-CX behavior and task-envelope compatibility helper.

## [0.1.0] — 2026-06-13

Initial public release as **@iicp/web-node** — the browser-native IICP node.

### Pre-publish alignment — 2026-06-26
- Ported the current iicp.network vendored browser implementation back into the package repo.
- Consumer `chat()` now fails closed when a node has no `cx_public_key`/`public_key`, matching the current Python/TypeScript/Rust privacy baseline.
- `discover()` filters to browser-usable HTTPS/loopback routes by default, with `browser_usable_only: false` for Node/full-route callers.
- Browser providers now advertise `cx_public_key`, `exposure_mode=relay_required`, `backend=webllm`, and `sdk_version=0.7.71-browser`, decrypt incoming `iicp_conf` tasks, and heartbeat success/failure/latency metrics.
- Added regression tests for fail-closed CX, browser route filtering, relay selection, provider registration, provider decrypt, and heartbeat metrics.

### Added
- **Consume**: `IicpBrowserClient` — discover mesh nodes and route chat tasks from a
  browser tab or Node (`discover`, `chat`, `stats`, `registry`).
- **Mandatory E2E encryption** (IICP-CX S.16, no opt-out): `chat()` seals the payload to a
  node's advertised X25519 key (ephemeral X25519 → HKDF-SHA256 → AES-256-GCM via
  `@noble/curves`/`@noble/hashes` + `SubtleCrypto`). Wire-compatible with the Python /
  TypeScript / Rust clients and the decrypting provider.
- **Serve**: `BrowserNodeProvider` + WebLLM runtime helpers (`WEBLLM_MODELS`,
  `assessDevice`) to serve a model in-tab behind a relay (`@mlc-ai/web-llm` peer dependency).
- `cipConsumerEnvelope` + `nodeCxKey` + `maskTunnelUrl` helpers.
