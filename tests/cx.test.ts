// IICP-CX S.16 — browser CX-Consumer/Provider encryption (mandatory). Envelope-shape,
// property, and decrypt tests. Cross-language interop (this envelope ↔ adapter decrypt_cx_payload)
// is verified in the main repo's reports/verifications/.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  createCxKeyPair,
  decryptPayload,
  encryptPayload,
  nodeCxKey,
  type CxPublicKey,
} from "../src/cxConfidentiality.js";

function freshKey(): CxPublicKey {
  const pub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const b64url = Buffer.from(pub).toString("base64url");
  return { algorithm: "X25519", key: b64url, key_id: "cx-1" };
}

describe("IICP-CX browser consumer/provider encryption", () => {
  it("produces a complete iicp_conf envelope", async () => {
    const env = await encryptPayload({ messages: [{ role: "user", content: "hi" }] }, freshKey(), "t1", "urn:iicp:intent:llm:chat:v1");
    assert.deepEqual(
      Object.keys(env).sort(),
      ["aad", "encrypted_body", "kem_ciphertext", "nonce", "plaintext_size", "recipient_key_id", "version"],
    );
    assert.equal(env["recipient_key_id"], "cx-1");
    assert.equal(env["version"], 1);
  });

  it("is non-deterministic (fresh ephemeral + nonce per call)", async () => {
    const k = freshKey();
    const a = await encryptPayload({ x: 1 }, k, "t1", "urn:iicp:intent:llm:chat:v1");
    const b = await encryptPayload({ x: 1 }, k, "t1", "urn:iicp:intent:llm:chat:v1");
    assert.notEqual(a["encrypted_body"], b["encrypted_body"]);
    assert.notEqual(a["kem_ciphertext"], b["kem_ciphertext"]);
  });

  it("decrypts a browser-provider envelope with the generated secret key", async () => {
    const kp = createCxKeyPair("browser-test");
    const payload = { messages: [{ role: "user", content: "serve this" }], temperature: 0.2 };
    const env = await encryptPayload(payload, kp.publicKey, "task-1", "urn:iicp:intent:llm:chat:v1");
    assert.deepEqual(await decryptPayload(env, kp.secretKey, "task-1", "urn:iicp:intent:llm:chat:v1"), payload);
  });

  it("rejects AAD tampering during decrypt", async () => {
    const kp = createCxKeyPair("browser-test");
    const env = await encryptPayload({ x: 1 }, kp.publicKey, "task-1", "urn:iicp:intent:llm:chat:v1");
    await assert.rejects(() => decryptPayload({ ...env, aad: "tampered" }, kp.secretKey, "task-1", "urn:iicp:intent:llm:chat:v1"));
  });

  it("rejects a non-X25519 key", async () => {
    await assert.rejects(() => encryptPayload({}, { algorithm: "RSA", key: "x", key_id: "k" }, "t", "urn:iicp:intent:llm:chat:v1"));
  });

  it("nodeCxKey reads canonical cx_public_key and deprecated public_key from discover records", () => {
    const k = freshKey();
    assert.equal(nodeCxKey({ cx_public_key: k })?.key, k.key);
    assert.equal(nodeCxKey({ public_key: k })?.key, k.key);
    assert.equal(nodeCxKey({ node_id: "n" }), null);
  });
});
