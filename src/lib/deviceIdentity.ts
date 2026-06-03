const DEVICE_ID_KEY = "pigeon.deviceId.v1";
const DEVICE_KEYPAIR_KEY = "pigeon.ecdhKeyPair.v1";

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  publicKey: JsonWebKey;
  privateKey: CryptoKey;
}

interface StoredKeyPair {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

export async function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  const deviceId = getOrCreateDeviceId();
  const stored = localStorage.getItem(DEVICE_KEYPAIR_KEY);

  if (stored) {
    const parsed = JSON.parse(stored) as StoredKeyPair;
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      parsed.privateKey,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );
    return {
      deviceId,
      deviceName: getDeviceName(),
      publicKey: parsed.publicKey,
      privateKey
    };
  }

  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  localStorage.setItem(DEVICE_KEYPAIR_KEY, JSON.stringify({ publicKey, privateKey: privateKeyJwk }));

  return {
    deviceId,
    deviceName: getDeviceName(),
    publicKey,
    privateKey: pair.privateKey
  };
}

function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, next);
  return next;
}

function getDeviceName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || "Web";
  return `${platform} 上的 pigeon`;
}
