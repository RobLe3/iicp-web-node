# Changelog

## [0.1.0] — 2026-06-13

Initial public release as **@iicp/web-node** — the browser-native IICP node.

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
