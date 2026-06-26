// @iicp/web-node — browser-native IICP node (consume AND serve), ESM, zero-config.
//
// The full browser node: a discovery-mesh CONSUMER (IicpBrowserClient) with MANDATORY
// end-to-end encryption (IICP-CX S.16 — WebCrypto X25519 + AES-256-GCM, no opt-out), a
// browser PROVIDER (BrowserNodeProvider — serve a model via WebLLM behind a relay), and
// the WebLLM runtime helpers. Discovery + consume work from any https:// page; serving
// needs a relay (see README). Parity with the Python/TS/Rust SDKs on the wire.
export * from "./iicpConsumer.js";
export * from "./cxConfidentiality.js";
export * from "./browserNodeProvider.js";
export * from "./webllmRuntime.js";
