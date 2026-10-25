import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, so hashes and signatures are stable. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// Raw 32-byte ed25519 keys are carried as base64url; Node wants DER, so we
// wrap them with the fixed ASN.1 prefixes for SPKI / PKCS#8.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateAgentKeys(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  return { publicKey: pub.toString("base64url"), privateKey: priv.toString("base64url") };
}

export function signMessage(privateKey: string, message: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKey, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(message), key).toString("base64url");
}

export function verifyMessage(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64url")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Short human-checkable key fingerprint, SSH style. */
export function fingerprint(publicKey: string): string {
  const digest = sha256(Buffer.from(publicKey, "base64url"));
  return digest
    .slice(0, 16)
    .match(/.{2}/g)!
    .join(":")
    .toUpperCase();
}

/** EVM-shaped wallet address derived from the agent key (sandbox: not a real chain account). */
export function walletFromKey(publicKey: string): string {
  return `0x${sha256(Buffer.from(publicKey, "base64url")).slice(0, 40)}`;
}

/** What an agent signs to authenticate an API request. */
export function requestSigningPayload(timestamp: string, method: string, path: string, body: string): string {
  return `clearance-v1\n${timestamp}\n${method.toUpperCase()}\n${path}\n${sha256(body)}`;
}

/** What an agent signs to authorize an x402 payment (stands in for an EIP-3009 signature in the sandbox). */
export function x402AuthorizationMessage(auth: Record<string, string>): string {
  return `x402-exact\n${canonical(auth)}`;
}
