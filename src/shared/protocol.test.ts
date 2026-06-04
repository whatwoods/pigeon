import { describe, expect, it } from "vitest";
import { parseSignalMessagePayload, SIGNAL_MESSAGE_MAX_BYTES, type SignalMessage } from "./protocol";

describe("signal message parsing", () => {
  it("accepts a valid transfer cancel message", () => {
    const message: SignalMessage = {
      type: "transfer:cancel",
      packageId: "package-1",
      targetDeviceId: "device-2",
      reason: "用户取消"
    };

    expect(parseSignalMessagePayload(JSON.stringify(message))).toEqual(message);
  });

  it("accepts valid text pair messages", () => {
    const publicKey = { kty: "EC", crv: "P-256", x: "x", y: "y" };
    const offer: SignalMessage = {
      type: "text:offer",
      id: "text-1",
      targetDeviceId: "device-2",
      senderDeviceId: "device-1",
      senderPublicKey: publicKey,
      createdAt: 1
    };
    const accept: SignalMessage = {
      type: "text:accept",
      id: "text-1",
      targetDeviceId: "device-1",
      receiverDeviceId: "device-2",
      receiverPublicKey: publicKey
    };

    expect(parseSignalMessagePayload(JSON.stringify(offer))).toEqual(offer);
    expect(parseSignalMessagePayload(JSON.stringify(accept))).toEqual(accept);
  });

  it("accepts room presence and scoped package offers", () => {
    const publicKey = { kty: "EC", crv: "P-256", x: "x", y: "y" };
    const presence: SignalMessage = {
      type: "room:presence",
      onlineDevices: [{ deviceId: "device-1", deviceName: "Mac 上的 pigeon" }]
    };
    const offer: SignalMessage = {
      type: "package:offer",
      deliveryScope: "room",
      packageId: "package-1",
      senderDeviceId: "device-1",
      senderPublicKey: publicKey,
      manifest: {
        packageId: "package-1",
        name: "hello.txt",
        entries: [
          {
            id: "entry-1",
            name: "hello.txt",
            relativePath: "hello.txt",
            size: 1,
            mime: "text/plain",
            sha256: "a".repeat(64),
            lastModified: 1
          }
        ],
        totalBytes: 1,
        createdAt: 1,
        senderDeviceId: "device-1"
      },
      createdAt: 1
    };

    expect(parseSignalMessagePayload(JSON.stringify(presence))).toEqual(presence);
    expect(parseSignalMessagePayload(JSON.stringify(offer))).toEqual(offer);
  });

  it("rejects invalid json and unknown message shapes", () => {
    expect(parseSignalMessagePayload("{")).toBeNull();
    expect(parseSignalMessagePayload(JSON.stringify({ type: "rtc:offer" }))).toBeNull();
    expect(parseSignalMessagePayload(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("rejects oversized signal payloads", () => {
    expect(parseSignalMessagePayload("x".repeat(SIGNAL_MESSAGE_MAX_BYTES + 1))).toBeNull();
  });
});
