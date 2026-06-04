import { describe, expect, it, beforeEach } from "vitest";
import { ensureDeviceIdentity } from "./deviceIdentity";

describe("deviceIdentity", () => {
  beforeEach(() => {
    localStorage.clear();

    // Mock indexedDB unconditionally for Vitest test runs to avoid buggy JSDOM native implementation
    const mockStore: Record<string, any> = {};
    const mockDb = {
      objectStoreNames: {
        contains: () => false
      },
      createObjectStore: () => {},
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            const req: any = {};
            setTimeout(() => {
              req.result = mockStore["keypair"];
              req.onsuccess?.();
            }, 0);
            return req;
          },
          put: (val: any) => {
            const req: any = {};
            setTimeout(() => {
              mockStore["keypair"] = val;
              req.onsuccess?.();
            }, 0);
            return req;
          }
        })
      })
    };
    
    (globalThis as any).indexedDB = {
      open: () => {
        const req: any = {};
        setTimeout(() => {
          req.result = mockDb;
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      }
    };
  });

  it("generates a device identity with non-extractable private key", async () => {
    const identity = await ensureDeviceIdentity();
    expect(identity.deviceId).toBeDefined();
    expect(identity.deviceName).toBeDefined();
    expect(identity.publicKey).toBeDefined();
    expect(identity.privateKey).toBeDefined();
    expect(identity.privateKey.extractable).toBe(false);
  });
});
