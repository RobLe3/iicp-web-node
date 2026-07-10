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
// By default, discover() keeps only browser-usable HTTPS/loopback endpoints.
// Pass { browser_usable_only: false } if you are running in Node and want all routes.

const node = nodes[0];
const reply = await client.chat(
  [{ role: "user", content: "Hello!" }],
  { endpoint: node.endpoint, model: "llama3", cxPublicKey: nodeCxKey(node) },
);
```

The client prefers short-lived dispatch tickets, falls back only when an older directory
does not support them, and can enforce strict region and signed-policy-manifest constraints
before a prompt is sent. Declared prohibited or high-risk public-mesh intents are refused
locally. Successful routing receipts exclude prompt, response, token, and endpoint content.

When the chosen node advertises an encryption key (`nodeCxKey(node)`), the payload is
**sealed end-to-end** — the directory, relays, and network see only ciphertext. There is
no opt-out. A node that does not advertise `cx_public_key`/`public_key` is refused before
any network send so browser use cannot silently fall back to plaintext.

## Serve — be a node from the browser

```ts
import { BrowserNodeProvider, WEBLLM_MODELS, assessDevice } from "@iicp/web-node";
// Loads a small model in-tab via WebLLM (WebGPU/WASM) and serves it behind a relay.
```

Browser providers advertise a generated `cx_public_key`, decrypt incoming `iicp_conf`
payloads locally, report task success/failure/latency in heartbeats, and use a relay path
because browser tabs cannot accept raw inbound TCP.

Startup is intentionally ticketed: the provider registers, requests a short-lived relay
bind ticket scoped to its worker and selected relay, and presents that ticket when it binds.
Authentication or validation failures stop serving and clean up the temporary directory
registration instead of silently falling back to an unsigned bind. Compatibility fallback
is limited to directories that explicitly report that the ticket service is unavailable.

Provider state includes deterministic recovery diagnostics (`stable`, `tunnel_starting`,
`route_mismatch`, `operator_action_needed`, or `unavailable`) so a host page can explain
whether it is directory-listed and relay-bound. Browser lifetime still matters: closing or
suspending the tab stops the in-browser provider.

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

Public discovery and ticketed dispatch work from approved browser origins because
`iicp.network` sends CORS headers. Routing a task to a selected node is subject to the browser's CORS
and mixed-content policy: an `https://` page cannot reach an `http://localhost` model, a
node without CORS headers, or an IPv6-firewalled node. In **Node** there is no CORS
restriction and everything works.

## License

Apache-2.0. Part of the open [IICP protocol](https://github.com/RobLe3/IICP).
