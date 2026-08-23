# Changelog

## Unreleased

## 0.2.6 — 2026-08-23

- Refuse browser private, federated-private and local-only modes that the experimental browser node cannot enforce, rather than silently using public semantics.
- Keep the browser node experimental and preserve public-mode behavior.

## 0.2.5 — 2026-08-15

- Make the bounded runtime identity capsule the default for compatible browser chat calls while retaining explicit disabled and required modes.
- Add browser package identity, authoritative advertised model/capability facts and control-character bounds without exposing private route data.
- Preserve non-chat inputs and raw envelope helpers unchanged.

## 0.2.4 — 2026-08-14

- Verify directory-signed dispatch tickets in the browser consumer before exposing route material.
- Fail closed on invalid or missing ticket evidence without silently downgrading to legacy discovery.
- Consume the canonical dispatch-ticket fixture used by the three server SDKs.
- Add the shared effective-capability-v1 parser, matcher and explicit provider variants.
- Add opt-in, chat-only runtime identity composition without changing disabled or non-chat requests.
- Advance the browser provider compatibility declaration to SDK contract `0.7.102`.

## 0.2.3 — 2026-08-02

- Separate the browser implementation/package version from its IICP SDK compatibility version.
- Register additive `implementation_name`, `implementation_version`, and
  `sdk_compatibility_version` fields while retaining `sdk_version` for older directories.
- Add one bounded quality workflow and a content-free build provenance manifest.
- No task payload, encryption, relay, or browser execution semantics changed.

## 0.2.2 — 2026-07-10

- Fix browser-provider relay ticket issuance for opaque node credentials by sending the required `X-Node-Id` subject hint.

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
