import { arrayBufferToBase64, base64ToArrayBuffer, bytesToBase64, copyToArrayBuffer } from "./base64";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function importPublicKey(publicKey: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", publicKey, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

export async function deriveAesKey(privateKey: CryptoKey, publicKey: JsonWebKey): Promise<CryptoKey> {
  const imported = await importPublicKey(publicKey);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: imported },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptText(value: string, key: CryptoKey): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, TEXT_ENCODER.encode(value));
  return {
    iv: bytesToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext)
  };
}

export async function decryptText(iv: string, ciphertext: string, key: CryptoKey): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToArrayBuffer(iv) },
    key,
    base64ToArrayBuffer(ciphertext)
  );
  return TEXT_DECODER.decode(decrypted);
}

export async function encryptBytes(bytes: Uint8Array, key: CryptoKey): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, copyToArrayBuffer(bytes));
  return { iv, ciphertext: new Uint8Array(encrypted) };
}

export async function decryptBytes(iv: Uint8Array, ciphertext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: copyToArrayBuffer(iv) }, key, copyToArrayBuffer(ciphertext));
  return new Uint8Array(decrypted);
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
