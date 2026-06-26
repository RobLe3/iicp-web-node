// IICP-CX S.16 Tier-1 confidentiality — BROWSER CX-Consumer (mandatory, no opt-out).
// Byte-compatible with the node/adapter decrypt: X25519 (@noble/curves) +
// HKDF-SHA256 (@noble/hashes) + AES-256-GCM (WebCrypto, universally available).
// The browser SDK can't use Node-crypto; this is the WebCrypto/noble equivalent.
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export interface CxPublicKey {
  algorithm: string;
  encoding?: string;
  key: string; // base64url raw 32-byte X25519 public key
  key_id: string;
}

export interface CxKeyPair {
  publicKey: CxPublicKey;
  secretKey: Uint8Array;
}

function b64urlEncode(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cxInfo(taskId: string, intent: string): Uint8Array {
  return new TextEncoder().encode(`IICP-CX-v1${taskId}${intent}`);
}

function cxAad(taskId: string, intent: string): Uint8Array {
  return new TextEncoder().encode(`${taskId}|${intent}`);
}

/** Generate a browser-provider X25519 key pair suitable for directory advertisement. */
export function createCxKeyPair(prefix = "cx-browser"): CxKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKeyBytes = x25519.getPublicKey(secretKey);
  const fingerprint = b64urlEncode(sha256(publicKeyBytes)).slice(0, 12);

  return {
    secretKey,
    publicKey: {
      algorithm: "X25519",
      encoding: "base64url",
      key: b64urlEncode(publicKeyBytes),
      key_id: `${prefix}-${fingerprint}`,
    },
  };
}

/**
 * Encrypt a task payload to the node's advertised X25519 key, producing an `iicp_conf`
 * envelope identical to what the SDKs send and the adapter decrypts (IICP-CX §5):
 * ephemeral X25519 → HKDF-SHA256(salt=nonce, info="IICP-CX-v1"+task_id+intent) →
 * AES-256-GCM(aad=task_id+"|"+intent). The caller omits `payload` when `iicp_conf` is present.
 */
export async function encryptPayload(
  payload: unknown,
  cx: CxPublicKey,
  taskId: string,
  intent: string,
): Promise<Record<string, unknown>> {
  if (cx.algorithm !== "X25519") {
    throw new Error(`Unsupported cx_public_key algorithm: ${cx.algorithm}`);
  }
  const nodePub = b64urlDecode(cx.key);
  const ephemPriv = x25519.utils.randomSecretKey();
  const ephemPub = x25519.getPublicKey(ephemPriv);
  const shared = x25519.getSharedSecret(ephemPriv, nodePub);

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const info = cxInfo(taskId, intent);
  const keyBytes = hkdf(sha256, shared, nonce, info, 32);
  const aad = cxAad(taskId, intent);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const key = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: new Uint8Array(aad) },
      key,
      new Uint8Array(plaintext),
    ),
  );

  return {
    version: 1,
    recipient_key_id: cx.key_id,
    kem_ciphertext: b64urlEncode(ephemPub),
    encrypted_body: b64urlEncode(ct), // WebCrypto AES-GCM output = ciphertext || 16-byte tag
    nonce: b64urlEncode(nonce),
    aad: b64urlEncode(aad),
    plaintext_size: plaintext.length,
  };
}

/**
 * Decrypt an IICP-CX envelope for a browser provider node.  This is the mirror
 * of encryptPayload(), used only after the tab explicitly starts serving via a
 * relay and has advertised its generated cx_public_key to the directory.
 */
export async function decryptPayload(
  envelope: Record<string, unknown>,
  secretKey: Uint8Array,
  taskId: string,
  intent: string,
): Promise<unknown> {
  if (envelope.version !== 1) {
    throw new Error(`Unsupported iicp_conf version: ${String(envelope.version)}`);
  }
  const kem = envelope.kem_ciphertext;
  const encryptedBody = envelope.encrypted_body;
  const nonceRaw = envelope.nonce;
  if (typeof kem !== "string" || typeof encryptedBody !== "string" || typeof nonceRaw !== "string") {
    throw new Error("Malformed iicp_conf envelope");
  }

  const aad = cxAad(taskId, intent);
  if (typeof envelope.aad === "string" && !constantTimeEqual(envelope.aad, b64urlEncode(aad))) {
    throw new Error("iicp_conf AAD does not match task identity");
  }

  const shared = x25519.getSharedSecret(secretKey, b64urlDecode(kem));
  const nonce = b64urlDecode(nonceRaw);
  const keyBytes = hkdf(sha256, shared, nonce, cxInfo(taskId, intent), 32);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: new Uint8Array(aad) },
    key,
    new Uint8Array(b64urlDecode(encryptedBody)),
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** Read a node's canonical `cx_public_key`; accept deprecated `public_key` alias during migration. */
export function nodeCxKey(node: Record<string, unknown>): CxPublicKey | null {
  const raw = (node["cx_public_key"] ?? node["public_key"]) as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object" && raw["algorithm"] === "X25519" && typeof raw["key"] === "string") {
    return { algorithm: "X25519", key: String(raw["key"]), key_id: String(raw["key_id"] ?? "cx-1") };
  }
  return null;
}
