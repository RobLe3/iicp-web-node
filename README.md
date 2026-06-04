# @iicp/client-wasm

Browser-native, **consumer-only** client for the [IICP](https://iicp.network) discovery
mesh. Zero runtime dependencies, ESM, built on native `fetch` / `TextEncoder` /
`SubtleCrypto` — embeds directly into a web page (and runs in Node ≥18).

> **Naming:** despite the `-wasm` name (historical, from research issue #292), this is
> **TypeScript, not WebAssembly**. A Rust→WASM compile of the node was found infeasible
> (`tokio`/`reqwest` don't target `wasm32`); a tiny TS consumer is the right tool. See
> `research/wasm/WASM-1-feasibility.md`.

This is the **consumer subset** only — it discovers nodes and routes tasks. It never
registers as a provider and has no TCP / NAT / relay machinery (that's the full
[`@iicp/client`](https://www.npmjs.com/package/@iicp/client) Node SDK).

## Install

```bash
npm install @iicp/client-wasm
```

## Use (in a page or Node)

```ts
import { IicpBrowserClient } from "@iicp/client-wasm";

const iicp = new IicpBrowserClient(); // defaults to https://iicp.network

// Discover — works from any https:// page (iicp.network sends CORS headers)
const nodes = await iicp.discover("urn:iicp:intent:llm:chat:v1");
const stats = await iicp.stats(); // { mesh_health, server.active_nodes, ... }

// Route a chat to a node you can actually reach (see CORS reality below)
const reply = await iicp.chat(
  [{ role: "user", content: "hello" }],
  { endpoint: "http://localhost:11434" }, // local-with-Chrome-flag, or a CORS-enabled node
);
```

## CORS reality (read before wiring task routing)

From an `https://` page the browser **can** discover via iicp.network but **cannot**:

| Target | Browser reachable? | Why |
|---|---|---|
| `https://iicp.network` (discover/stats) | ✅ yes | CORS headers present |
| `http://localhost:11434` (Ollama / local LLM) | ⚠ Chrome 129+ flag only | HTTPS→HTTP mixed-content blocked elsewhere |
| arbitrary discovered node endpoint | ❌ no (unless it sends CORS) | no `Access-Control-Allow-Origin` |

So an in-page consumer reliably does **discovery + mesh visualisation** everywhere; **task
routing** works against CORS-enabled nodes or a local endpoint with the Chrome flag. In
**Node** there is no CORS restriction and everything works. (Tracking: #448.)

## License

Apache-2.0. Part of the IICP project — epic #446.
