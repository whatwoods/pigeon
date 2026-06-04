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

const DB_NAME = "pigeon-identity-db";
const STORE_NAME = "identity-keys";

interface DBKeyPair {
  publicKey: JsonWebKey;
  privateKey: CryptoKey;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredKeyPair(): Promise<DBKeyPair | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get("keypair");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function saveKeyPair(keypair: DBKeyPair): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(keypair, "keypair");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Failed to save identity to IndexedDB", error);
  }
}

export async function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  const deviceId = getOrCreateDeviceId();

  // 1. Try reading from IndexedDB
  const idbKeyPair = await getStoredKeyPair();
  if (idbKeyPair) {
    return {
      deviceId,
      deviceName: getDeviceName(),
      publicKey: idbKeyPair.publicKey,
      privateKey: idbKeyPair.privateKey
    };
  }

  // 2. Try migration from localStorage
  const storedLocal = localStorage.getItem(DEVICE_KEYPAIR_KEY);
  if (storedLocal) {
    try {
      const parsed = JSON.parse(storedLocal) as StoredKeyPair;
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        parsed.privateKey,
        { name: "ECDH", namedCurve: "P-256" },
        false, // non-extractable
        ["deriveKey"]
      );
      const dbKeyPair: DBKeyPair = {
        publicKey: parsed.publicKey,
        privateKey
      };
      await saveKeyPair(dbKeyPair);
      localStorage.removeItem(DEVICE_KEYPAIR_KEY);
      return {
        deviceId,
        deviceName: getDeviceName(),
        publicKey: parsed.publicKey,
        privateKey
      };
    } catch (e) {
      console.error("Migration failed, generating new key pair", e);
    }
  }

  // 3. Generate new non-extractable key pair
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // non-extractable
    ["deriveKey"]
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const dbKeyPair: DBKeyPair = {
    publicKey,
    privateKey: pair.privateKey
  };
  await saveKeyPair(dbKeyPair);

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
