# @iicp/web-node

Browser-native **IICP node** for the [IICP](https://iicp.network) mesh — **consume** AI
from the network *and* **serve** a model from a browser tab. ESM, built on the platform's
native `fetch` / `SubtleCrypto` / WebGPU (and runs in Node ≥18). End-to-end payload
encryption is **mandatory** and on by default.

```
npm install @iicp/web-node
```

## Consume — call the mesh

```ts
import { IicpBrowserClient, nodeCxKey } from "@iicp/web-node";

const client = new IicpBrowserClient(); // defaults to https://iicp.network
const nodes = await client.discover("urn:iicp:intent:llm:chat:v1");

const node = nodes[0];
const reply = await client.chat(
  [{ role: "user", content: "Hello!" }],
  { endpoint: node.endpoint, model: "llama3", cxPublicKey: nodeCxKey(node) },
);
```

When the chosen node advertises an encryption key (`nodeCxKey(node)`), the payload is
**sealed end-to-end** — the directory, relays, and network see only ciphertext. There is
no opt-out; a node not yet advertising a key triggers a loud transitional plaintext
warning during the mesh rollout.

## Serve — be a node from the browser

```ts
import { BrowserNodeProvider, WEBLLM_MODELS, assessDevice } from "@iicp/web-node";
// Loads a small model in-tab via WebLLM (WebGPU/WASM) and serves it behind a relay.
```

Serving requires WebLLM — add it alongside this package:

```
npm install @mlc-ai/web-llm   # peer dependency, only needed to serve
```

## Encryption

IICP-CX (S.16) Tier-1: ephemeral **X25519** key agreement → **HKDF-SHA256** →
**AES-256-GCM** authenticated encryption, computed with `@noble/curves` + `@noble/hashes`
and the platform's `SubtleCrypto`. The envelope is wire-compatible with the Python,
TypeScript, and Rust IICP clients and the provider/adapter that decrypts it.

## CORS reality

Discovery (`GET /api/v1/discover`) works from any `https://` page because `iicp.network`
sends CORS headers. Routing a task to a discovered node is subject to the browser's CORS
and mixed-content policy: an `https://` page cannot reach an `http://localhost` model, a
node without CORS headers, or an IPv6-firewalled node. In **Node** there is no CORS
restriction and everything works.

## License

Apache-2.0. Part of the open [IICP protocol](https://github.com/RobLe3/IICP).
