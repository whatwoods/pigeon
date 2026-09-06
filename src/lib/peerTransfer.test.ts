// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackageReceiver, PackageSender } from "./peerTransfer";
import { packChunk } from "./peerFrame";
import { CHUNK_BYTES, type PackageEntry, type PackageManifest } from "../shared/protocol";
import type { ReceiveSink } from "./receiveSink";

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "arraybuffer";
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  messages: (string | ArrayBuffer)[] = [];
  partner?: Channel;
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("closed channel");
    this.messages.push(data);
    if (this.partner) queueMicrotask(() => this.partner?.onmessage?.({ data }));
  }
  deliver(data: object | ArrayBuffer) {
    this.onmessage?.({ data: data instanceof ArrayBuffer ? data : JSON.stringify(data) });
  }
  close() { this.readyState = "closed"; this.onclose?.(); }
  controls() { return this.messages.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m)); }
}

class Peer {
  static instances: Peer[] = [];
  channel = new Channel();
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  remoteDescription?: object;
  ondatachannel?: (event: { channel: Channel }) => void;
  constructor() { Peer.instances.push(this); }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "test" }; }
  async createAnswer() { return { type: "answer", sdp: "test" }; }
  async setLocalDescription() {}
  async setRemoteDescription(description: object) { this.remoteDescription = description; }
  close() { this.signalingState = "closed"; }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

let key: CryptoKey;
let entry: PackageEntry;
let manifest: PackageManifest;
let payload: Uint8Array;

beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("RTCPeerConnection", Peer);
  Peer.instances = [];
  key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  payload = new TextEncoder().encode("hello");
  entry = { id: "entry", name: "file.txt", relativePath: "file.txt", size: payload.length, mime: "text/plain", sha256: createHash("sha256").update(payload).digest("hex"), lastModified: 0 };
  manifest = { packageId: "package", entries: [entry], totalBytes: entry.size, name: "file.txt", senderDeviceId: "sender", createdAt: 0 };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function makeReceiver(overrides: Partial<ReceiveSink> = {}) {
  const sink = {
    startFile: vi.fn(async () => {}), writeChunk: vi.fn(async () => {}),
    finishFile: vi.fn(async () => {}), finishPackage: vi.fn(async () => {}), abort: vi.fn(async () => {}), ...overrides
  };
  const onComplete = vi.fn();
  const onError = vi.fn();
  const receiver = new PackageReceiver({ packageId: manifest.packageId, senderDeviceId: "sender", receiverDeviceId: "receiver", aesKey: key, iceServers: [], sink, signal: vi.fn(), onProgress: vi.fn(), onComplete, onError });
  const channel = new Channel();
  Peer.instances.at(-1)!.ondatachannel!({ channel });
  return { receiver, channel, sink, onComplete, onError };
}
function makeSender() {
  const onComplete = vi.fn();
  const onError = vi.fn();
  const onRetry = vi.fn();
  const sender = new PackageSender({ manifest, files: new Map([[entry.id, new File([new Uint8Array(payload).buffer], entry.name)]]), aesKey: key, targetDeviceId: "receiver", senderDeviceId: "sender", iceServers: [], signal: vi.fn(), onProgress: vi.fn(), onComplete, onError, onRetry });
  return { sender, onComplete, onError, onRetry };
}
function offerFile(channel: Channel) {
  channel.deliver({ kind: "manifest", manifest, resumable: true });
  channel.deliver({ kind: "file:start", entryId: entry.id, startIndex: 0 });
}

describe("file transfer completion", () => {
  it("serializes slow file setup and writes before verifying, committing and acknowledging", async () => {
    const start = deferred();
    const write = deferred();
    const r = makeReceiver({ startFile: vi.fn(() => start.promise), writeChunk: vi.fn(() => write.promise) });
    offerFile(r.channel);
    r.channel.deliver(await packChunk(key, entry.id, 0, payload));
    r.channel.deliver({ kind: "file:done", entryId: entry.id });
    r.channel.deliver({ kind: "package:done" });
    await vi.waitFor(() => expect(r.sink.startFile).toHaveBeenCalledOnce());
    expect(r.sink.writeChunk).not.toHaveBeenCalled();
    expect(r.onComplete).not.toHaveBeenCalled();
    start.resolve();
    await vi.waitFor(() => expect(r.sink.writeChunk).toHaveBeenCalledOnce());
    expect(r.sink.finishFile).not.toHaveBeenCalled();
    write.resolve();
    await vi.waitFor(() => expect(r.onComplete).toHaveBeenCalledOnce());
    expect(r.sink.finishFile).toHaveBeenCalledOnce();
    expect(r.onError).not.toHaveBeenCalled();
    expect(r.channel.controls().at(-1)).toEqual({ kind: "package:ack", packageId: manifest.packageId });
    r.receiver.close();
  });

  it("aborts a bad hash without committing, downloading or reporting success", async () => {
    const r = makeReceiver();
    entry.sha256 = "0".repeat(64);
    offerFile(r.channel);
    r.channel.deliver(await packChunk(key, entry.id, 0, payload));
    r.channel.deliver({ kind: "file:done", entryId: entry.id });
    r.channel.deliver({ kind: "package:done" });
    await vi.waitFor(() => expect(r.onError).toHaveBeenCalledOnce());
    expect(r.sink.abort).toHaveBeenCalledOnce();
    expect(r.sink.finishFile).not.toHaveBeenCalled();
    expect(r.sink.finishPackage).not.toHaveBeenCalled();
    expect(r.onComplete).not.toHaveBeenCalled();
    expect(r.channel.controls().at(-1).kind).toBe("package:error");
    r.receiver.close();
  });

  it("rejects package completion while a file is missing", async () => {
    const r = makeReceiver();
    offerFile(r.channel);
    r.channel.deliver({ kind: "package:done" });
    await vi.waitFor(() => expect(r.onError).toHaveBeenCalledOnce());
    expect(r.onComplete).not.toHaveBeenCalled();
    r.receiver.close();
  });

  it("waits for the matching receiver ACK and ignores unrelated confirmations", async () => {
    const s = makeSender();
    await s.sender.start();
    const channel = Peer.instances.at(-1)!.channel;
    channel.onopen!();
    channel.deliver({ kind: "resume", state: { entries: {} } });
    await vi.waitFor(() => expect(channel.controls().at(-1).kind).toBe("package:done"));
    expect(s.onComplete).not.toHaveBeenCalled();
    expect(channel.readyState).toBe("open");
    channel.deliver({ kind: "package:ack", packageId: "other" });
    expect(s.onComplete).not.toHaveBeenCalled();
    channel.deliver({ kind: "package:ack", packageId: manifest.packageId });
    await vi.waitFor(() => expect(s.onComplete).toHaveBeenCalledOnce());
    expect(channel.readyState).toBe("closed");
  });

  it("reports receiver errors without retrying or claiming delivery", async () => {
    const s = makeSender();
    await s.sender.start();
    const channel = Peer.instances.at(-1)!.channel;
    channel.onopen!();
    channel.deliver({ kind: "package:error", packageId: manifest.packageId, reason: "disk full" });
    await vi.waitFor(() => expect(s.onError).toHaveBeenCalledOnce());
    expect(s.onComplete).not.toHaveBeenCalled();
    expect(s.onRetry).not.toHaveBeenCalled();
    expect(channel.readyState).toBe("closed");
  });

  it("retries an unacknowledged completion instead of marking it delivered", async () => {
    vi.useFakeTimers();
    payload = new Uint8Array();
    entry.size = 0;
    manifest.totalBytes = 0;
    const s = makeSender();
    await s.sender.start();
    const channel = Peer.instances.at(-1)!.channel;
    channel.onopen!();
    channel.deliver({ kind: "resume", state: { entries: {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.controls().at(-1).kind).toBe("package:done");
    await vi.advanceTimersByTimeAsync(120000);
    expect(s.onRetry).toHaveBeenCalledOnce();
    expect(s.onComplete).not.toHaveBeenCalled();
    s.sender.cancel();
  });

  it("cancels queued work without committing a partially received file", async () => {
    const start = deferred();
    const r = makeReceiver({ startFile: vi.fn(() => start.promise) });
    offerFile(r.channel);
    r.channel.deliver(await packChunk(key, entry.id, 0, payload));
    r.channel.deliver({ kind: "file:done", entryId: entry.id });
    r.channel.deliver({ kind: "package:done" });
    await vi.waitFor(() => expect(r.sink.startFile).toHaveBeenCalledOnce());
    r.receiver.close();
    start.resolve();
    await vi.waitFor(() => expect(r.sink.abort).toHaveBeenCalledOnce());
    expect(r.sink.writeChunk).not.toHaveBeenCalled();
    expect(r.sink.finishFile).not.toHaveBeenCalled();
    expect(r.onComplete).not.toHaveBeenCalled();
  });

  it("creates and verifies an empty file on both ends before sender success", async () => {
    payload = new Uint8Array();
    entry.size = 0;
    entry.sha256 = createHash("sha256").update(payload).digest("hex");
    manifest.totalBytes = 0;
    const finish = deferred();
    const r = makeReceiver({ finishPackage: vi.fn(() => finish.promise) });
    const s = makeSender();
    await s.sender.start();
    const channel = Peer.instances.at(-1)!.channel;
    channel.partner = r.channel;
    r.channel.partner = channel;
    channel.onopen!();
    await vi.waitFor(() => expect(r.sink.finishFile).toHaveBeenCalledOnce());
    expect(r.sink.startFile).toHaveBeenCalledWith(entry);
    expect(s.onComplete).not.toHaveBeenCalled();
    finish.resolve();
    await vi.waitFor(() => expect(s.onComplete).toHaveBeenCalledOnce());
    expect(r.onComplete).toHaveBeenCalledOnce();
    expect(r.onError).not.toHaveBeenCalled();
    r.receiver.close();
  });

  it("finishes a resumed file whose last chunk arrived before disconnect", async () => {
    const s = makeSender();
    await s.sender.start();
    const channel = Peer.instances.at(-1)!.channel;
    channel.onopen!();
    channel.deliver({ kind: "resume", state: { entries: { [entry.id]: Math.ceil(entry.size / CHUNK_BYTES) } } });
    await vi.waitFor(() => expect(channel.controls().at(-1).kind).toBe("package:done"));
    expect(channel.controls().map((m) => m.kind)).toContain("file:done");
    expect(channel.messages.some((m) => m instanceof ArrayBuffer)).toBe(false);
    s.sender.cancel();
  });
});
