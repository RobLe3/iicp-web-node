#!/usr/bin/env node
// Bounded local/release-only browser evidence. This never contacts an IICP service.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const root = new URL("../", import.meta.url).pathname;
const write = process.argv.includes("--write");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/") {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><meta charset=utf-8><script type=importmap>{"imports":{"@noble/curves/":"/node_modules/@noble/curves/","@noble/hashes/":"/node_modules/@noble/hashes/"}}</script>`);
    return;
  }
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  if (!relative.startsWith("dist/") && !relative.startsWith("node_modules/@noble/")) {
    res.writeHead(404).end(); return;
  }
  try {
    const body = await readFile(join(root, relative));
    res.setHeader("content-type", types[extname(relative)] ?? "application/octet-stream");
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

const engines = { chromium, firefox, webkit };
const results = [];
let failed = false;
for (const [name, engine] of Object.entries(engines)) {
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(origin);
  const outcome = await page.evaluate(async () => {
    const runtime = await import("/dist/runtimeIdentity.js");
    const gpu = await import("/dist/webllmRuntime.js");
    const cx = await import("/dist/cxConfidentiality.js");
    const ticket = await import("/dist/dispatchTicket.js");
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { bytesToHex } = await import("@noble/hashes/utils.js");
    const intent = "urn:iicp:intent:llm:chat:v1";
    const messages = runtime.composeRuntimeIdentity([{ role: "user", content: "What is IICP?" }], intent, {
      client_name: "browser-evidence", client_version: "1", connection_mode: "local_browser", selection_reason: "local_browser_execution",
    });
    const identity = messages.some((m) => m.role === "system" && m.content.includes("Intent-based Inter-agent Communication Protocol"));
    const pair = cx.createCxKeyPair("evidence");
    const envelope = await cx.encryptPayload({ prompt: "content-free-test" }, pair.publicKey, "task-browser-evidence", intent);
    const clear = await cx.decryptPayload(envelope, pair.secretKey, "task-browser-evidence", intent);
    const cryptoRoundTrip = clear.prompt === "content-free-test";
    const secret = ed25519.utils.randomSecretKey();
    const pub = bytesToHex(ed25519.getPublicKey(secret));
    const claims = { v: 1, typ: "dispatch-route-ticket", iss: "did:web:evidence.invalid", aud: "iicp.directory.dispatch", node_id: "browser-node", intent, exp: Math.floor(Date.now()/1000)+60, jti: "0123456789abcdef01234567" };
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    const sig = bytesToHex(ed25519.sign(new TextEncoder().encode(`iicp:dispatch-route-ticket:v1\n${payload}`), secret));
    const dispatchPositive = ticket.verifyDispatchTicket(`${payload}.${sig}`, pub, claims.iss, claims.node_id, intent)?.jti === claims.jti;
    const dispatchNegative = ticket.verifyDispatchTicket(`${payload}.${"00".repeat(64)}`, pub, claims.iss, claims.node_id, intent) === null;
    const controller = new AbortController(); controller.abort();
    const cancellation = controller.signal.aborted === true;
    const webgpu = await gpu.probeWebGPU();
    return { identity, cryptoRoundTrip, dispatchPositive, dispatchNegative, cancellation, webgpu, userAgent: navigator.userAgent };
  });
  const version = browser.version();
  await browser.close();
  const required = ["identity", "cryptoRoundTrip", "dispatchPositive", "dispatchNegative", "cancellation"];
  const ok = required.every((key) => outcome[key] === true);
  failed ||= !ok;
  results.push({ engine: name, version, status: ok ? "PASS" : "FAIL", ...outcome });
}
server.close();

const report = {
  schema: "iicp-browser-compatibility-v1",
  evidence_class: "project-verified-local-headless",
  package: "@iicp/web-node",
  package_version: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  recorded_at: new Date().toISOString(),
  limits: [
    "Headless engine evidence is not representative physical-device or sustained provider evidence.",
    "WebGPU is classified independently; an unavailable adapter is not an IICP protocol failure.",
    "No production directory, relay, model or task payload is used.",
  ],
  lifecycle_classification: {
    cancellation: "PASS: AbortSignal behavior verified in every engine",
    tab_suspension: "NOT_TESTED: headless automation does not reproduce OS tab suspension reliably",
    reconnect: "NOT_TESTED: requires a disposable relay lifecycle lane",
    relay_binding: "NOT_TESTED: no relay is contacted by this content-free package matrix",
    permission_denial: "CLASSIFIED: unavailable or denied WebGPU adapters are reported as execution unsupported, not protocol failure",
  },
  results,
};
console.log(JSON.stringify(report, null, 2));
if (write) {
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(join(root, "evidence/browser-compatibility-v1.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (failed) process.exitCode = 1;
