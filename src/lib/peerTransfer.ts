import {
  CHUNK_BYTES,
  DATA_CHANNEL_BUFFER_LIMIT,
  type PackageEntry,
  type PackageManifest,
  type RtcAnswerMessage,
  type RtcIceMessage,
  type RtcOfferMessage
} from "../shared/protocol";
import { packChunk, unpackChunk } from "./peerFrame";
import type { ReceiveSink } from "./receiveSink";
import { Sha256Incremental } from "./sha256Incremental";

type SendSignal = (message: RtcOfferMessage | RtcAnswerMessage | RtcIceMessage) => void;

interface ResumeState {
  entries: Record<string, number>;
}

type ControlMessage =
  | { kind: "manifest"; manifest: PackageManifest; resumable: true }
  | { kind: "resume"; state: ResumeState }
  | { kind: "file:start"; entryId: string; startIndex: number }
  | { kind: "file:done"; entryId: string }
  | { kind: "package:done" }
  | { kind: "package:ack"; packageId: string }
  | { kind: "package:error"; packageId: string; reason: string };

export interface ProgressEvent {
  packageId: string;
  bytes: number;
  totalBytes: number;
  currentPath?: string;
}

export type ConnectionRoute = "checking" | "lan" | "direct" | "relay";

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [900, 1600, 2800, 4600, 7000];
const RESUME_TIMEOUT_MS = 30000;
const COMPLETION_TIMEOUT_MS = 120000;
const CONNECTION_TIMEOUT_MS = 30000;

export class PackageSender {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private cancelled = false;
  private completed = false;
  private connectionRoute?: ConnectionRoute;
  private attempt = 0;
  private retryTimer?: number;
  private connectionTimer?: number;
  private sendingRun = 0;
  private pendingResume?: (state: ResumeState) => void;
  private rejectResume?: (error: Error) => void;
  private pendingComplete?: () => void;
  private rejectComplete?: (error: Error) => void;
  private pendingIce: RtcIceMessage[] = [];
  private closingPeer = false;

  constructor(
    private readonly options: {
      manifest: PackageManifest;
      files: Map<string, File>;
      aesKey: CryptoKey;
      targetDeviceId: string;
      senderDeviceId: string;
      iceServers: RTCIceServer[];
      signal: SendSignal;
      onProgress: (event: ProgressEvent) => void;
      onConnectionRoute?: (route: ConnectionRoute) => void;
      onRetry?: (attempt: number, delayMs: number, reason?: string) => void;
      onComplete: () => void;
      onError: (error: Error) => void;
    }
  ) {}

  async start(): Promise<void> {
    await this.startAttempt();
  }

  async handleAnswer(message: RtcAnswerMessage): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.signalingState === "closed") return;
    await pc.setRemoteDescription(message.description as RTCSessionDescriptionInit);
    await this.flushPendingIce(pc);
  }

  async handleIce(message: RtcIceMessage): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.signalingState === "closed") return;
    if (!pc.remoteDescription) {
      this.pendingIce.push(message);
      return;
    }
    await this.addIceCandidate(pc, message);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.closePeer();
  }

  private async startAttempt(): Promise<void> {
    if (this.cancelled || this.completed) return;

    this.attempt += 1;
    this.sendingRun += 1;
    const run = this.sendingRun;
    this.closePeer();

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    const channel = pc.createDataChannel(`pigeon:${this.options.manifest.packageId}`, { ordered: true });
    this.pc = pc;
    this.channel = channel;
    this.connectionRoute = undefined;
    this.pendingIce = [];

    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LIMIT / 2;
    channel.onmessage = (event) => {
      if (this.channel !== channel) return;
      try {
        this.handleControlMessage(event.data);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("无效的接收端响应"));
      }
    };
    channel.onopen = () => {
      this.clearConnectionTimer();
      this.updateConnectionRoute().catch(this.options.onError);
      this.sendPackage(run).catch((error) => {
        if (run === this.sendingRun) this.handleSendError(error);
      });
    };
    channel.onclose = () => this.scheduleRetry("传输通道已关闭");
    channel.onerror = () => this.scheduleRetry("传输通道出错");

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.options.signal({
        type: "rtc:ice",
        packageId: this.options.manifest.packageId,
        targetDeviceId: this.options.targetDeviceId,
        senderDeviceId: this.options.senderDeviceId,
        candidate: event.candidate.toJSON()
      });
    };
    pc.onicecandidateerror = (event) => {
      console.warn("[pigeon] ICE candidate error", {
        errorCode: event.errorCode,
        errorText: event.errorText,
        url: event.url
      });
    };
    pc.oniceconnectionstatechange = () => {
      this.updateConnectionRoute().catch(this.options.onError);
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        this.scheduleRetry(`ICE 连接${pc.iceConnectionState === "failed" ? "失败" : "已断开"}`);
      }
    };
    pc.onconnectionstatechange = () => {
      this.updateConnectionRoute().catch(this.options.onError);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        this.scheduleRetry(`WebRTC 连接${pc.connectionState === "failed" ? "失败" : pc.connectionState === "disconnected" ? "已断开" : "已关闭"}`);
      }
    };
    this.emitConnectionRoute("checking");
    this.startConnectionTimer(pc, channel, run);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.options.signal({
      type: "rtc:offer",
      packageId: this.options.manifest.packageId,
      targetDeviceId: this.options.targetDeviceId,
      senderDeviceId: this.options.senderDeviceId,
      description: offer
    });
  }

  private handleControlMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as ControlMessage;
    if (message.kind === "resume") {
      this.pendingResume?.(message.state);
    }
    if (message.kind === "package:ack" && message.packageId === this.options.manifest.packageId) {
      this.pendingComplete?.();
    }
    if (message.kind === "package:error" && message.packageId === this.options.manifest.packageId) {
      this.fail(new Error(message.reason));
    }
  }

  private async sendPackage(run: number): Promise<void> {
    const resume = await this.waitForResumeState();
    if (this.cancelled || this.completed || run !== this.sendingRun) return;

    let sent = bytesFromResume(this.options.manifest, resume);
    this.options.onProgress({
      packageId: this.options.manifest.packageId,
      bytes: sent,
      totalBytes: this.options.manifest.totalBytes
    });

    for (const entry of this.options.manifest.entries) {
      if (this.cancelled || this.completed || run !== this.sendingRun) return;
      const file = this.options.files.get(entry.id);
      if (!file) throw new Error(`缺少文件：${entry.relativePath}`);

      const startIndex = Math.min(resume.entries[entry.id] ?? 0, chunkCount(entry));
      this.sendControl({ kind: "file:start", entryId: entry.id, startIndex });
      let index = startIndex;
      for (let offset = startIndex * CHUNK_BYTES; offset < file.size; offset += CHUNK_BYTES) {
        if (this.cancelled || this.completed || run !== this.sendingRun) return;
        const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        await this.waitForBuffer();
        const frame = await packChunk(this.options.aesKey, entry.id, index, bytes);
        if (this.cancelled || run !== this.sendingRun) return;
        this.assertChannelOpen();
        this.channel?.send(frame);
        sent += bytes.byteLength;
        index += 1;
        this.options.onProgress({
          packageId: this.options.manifest.packageId,
          bytes: sent,
          totalBytes: this.options.manifest.totalBytes,
          currentPath: entry.relativePath
        });
      }
      this.sendControl({ kind: "file:done", entryId: entry.id });
    }

    await this.waitForCompletion();
    if (this.cancelled || run !== this.sendingRun) return;
    this.completed = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.options.onComplete();
    this.closePeer();
  }

  private waitForResumeState(): Promise<ResumeState> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.pendingResume = undefined;
        this.rejectResume = undefined;
      };
      this.rejectResume = (error) => { cleanup(); reject(error); };
      const timeout = window.setTimeout(() => this.rejectResume?.(new Error("等待断点状态超时")), RESUME_TIMEOUT_MS);
      this.pendingResume = (state) => {
        cleanup();
        resolve(normalizeResumeState(state));
      };
      try {
        this.sendControl({ kind: "manifest", manifest: this.options.manifest, resumable: true });
      } catch (error) {
        this.rejectResume?.(error instanceof Error ? error : new Error("无法发送清单"));
      }
    });
  }

  private waitForCompletion(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.pendingComplete = undefined;
        this.rejectComplete = undefined;
      };
      this.rejectComplete = (error) => { cleanup(); reject(error); };
      const timeout = window.setTimeout(() => this.rejectComplete?.(new Error("等待接收确认超时")), COMPLETION_TIMEOUT_MS);
      this.pendingComplete = () => { cleanup(); resolve(); };
      try {
        this.sendControl({ kind: "package:done" });
      } catch (error) {
        this.rejectComplete?.(error instanceof Error ? error : new Error("无法发送完成消息"));
      }
    });
  }

  private fail(error: Error): void {
    if (this.cancelled || this.completed) return;
    this.cancel();
    this.options.onError(error);
  }

  private sendControl(value: ControlMessage): void {
    this.assertChannelOpen();
    this.channel?.send(JSON.stringify(value));
  }

  private async waitForBuffer(): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.bufferedAmount < DATA_CHANNEL_BUFFER_LIMIT) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        channel.removeEventListener("bufferedamountlow", handleLow);
        channel.removeEventListener("error", handleError);
      };
      const handleLow = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("传输通道失败"));
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        resolve();
      }, 500);
      channel.addEventListener("bufferedamountlow", handleLow, { once: true });
      channel.addEventListener("error", handleError, { once: true });
    });
  }

  private startConnectionTimer(pc: RTCPeerConnection, channel: RTCDataChannel, run: number): void {
    this.clearConnectionTimer();
    this.connectionTimer = window.setTimeout(() => {
      if (this.cancelled || this.completed || run !== this.sendingRun || this.pc !== pc) return;
      if (channel.readyState === "open") return;
      console.warn("[pigeon] WebRTC connection timeout", {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState
      });
      this.scheduleRetry("连接超时，Data Channel 未打开");
    }, CONNECTION_TIMEOUT_MS);
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer) {
      window.clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
  }

  private assertChannelOpen(): void {
    if (!this.channel || this.channel.readyState !== "open") {
      throw new Error("传输通道已断开");
    }
  }

  private handleSendError(error: unknown): void {
    if (this.cancelled || this.completed) return;
    if (error instanceof Error && error.message.startsWith("缺少文件")) {
      this.fail(error);
      return;
    }
    this.scheduleRetry(error instanceof Error ? error.message : "传输失败");
  }

  private scheduleRetry(reason?: string): void {
    if (this.cancelled || this.completed || this.retryTimer || this.closingPeer) return;
    this.clearConnectionTimer();
    const retryAttempt = this.attempt;
    if (retryAttempt > MAX_RETRY_ATTEMPTS) {
      this.fail(new Error(describeConnectionFailure(this.options.iceServers, reason)));
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt - 1, RETRY_DELAYS_MS.length - 1)];
    this.options.onRetry?.(retryAttempt, delay, reason);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.startAttempt().catch(this.options.onError);
    }, delay);
  }

  private closePeer(): void {
    this.rejectResume?.(new Error("传输通道已断开"));
    this.rejectComplete?.(new Error("传输通道已断开"));
    this.pendingIce = [];
    this.clearConnectionTimer();
    this.closingPeer = true;
    this.channel?.close();
    this.pc?.close();
    this.channel = undefined;
    this.pc = undefined;
    window.setTimeout(() => {
      this.closingPeer = false;
    }, 0);
  }

  private async updateConnectionRoute(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (pc.connectionState === "new" || pc.connectionState === "connecting") {
      this.emitConnectionRoute("checking");
      return;
    }

    if (pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") return;
    const route = await detectConnectionRoute(pc);
    if (route) this.emitConnectionRoute(route);
  }

  private emitConnectionRoute(route: ConnectionRoute): void {
    if (this.connectionRoute === route) return;
    this.connectionRoute = route;
    this.options.onConnectionRoute?.(route);
  }

  private async flushPendingIce(pc: RTCPeerConnection): Promise<void> {
    const pending = this.pendingIce.splice(0);
    for (const message of pending) {
      if (this.pc !== pc || pc.signalingState === "closed") return;
      await this.addIceCandidate(pc, message);
    }
  }

  private async addIceCandidate(pc: RTCPeerConnection, message: RtcIceMessage): Promise<void> {
    await addIceCandidateWithDiagnostics(pc, message);
  }
}

export class PackageReceiver {
  private pc?: RTCPeerConnection;
  private manifest?: PackageManifest;
  private entries = new Map<string, PackageEntry>();
  private currentEntry?: PackageEntry;
  private received = 0;
  private connectionRoute?: ConnectionRoute;
  private channel?: RTCDataChannel;
  private receivedChunks = new Map<string, number>();
  private finishedEntries = new Set<string>();
  private fileHashes = new Map<string, Sha256Incremental>();
  private pendingIce: RtcIceMessage[] = [];
  private dataQueue: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;
  private completed = false;

  constructor(
    private readonly options: {
      packageId: string;
      receiverDeviceId: string;
      senderDeviceId: string;
      aesKey: CryptoKey;
      iceServers: RTCIceServer[];
      sink: ReceiveSink;
      signal: SendSignal;
      onProgress: (event: ProgressEvent) => void;
      onConnectionRoute?: (route: ConnectionRoute) => void;
      onComplete: () => void;
      onError: (error: Error) => void;
    }
  ) {
    this.createPeer();
  }

  async handleOffer(message: RtcOfferMessage): Promise<void> {
    if (this.failed || this.closed || message.packageId !== this.options.packageId || message.senderDeviceId !== this.options.senderDeviceId) return;
    if (!this.pc || this.pc.signalingState === "closed" || this.pc.remoteDescription) {
      this.createPeer();
    }

    const pc = this.pc;
    if (!pc) return;
    await pc.setRemoteDescription(message.description as RTCSessionDescriptionInit);
    await this.flushPendingIce(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.options.signal({
      type: "rtc:answer",
      packageId: this.options.packageId,
      targetDeviceId: this.options.senderDeviceId,
      receiverDeviceId: this.options.receiverDeviceId,
      description: answer
    });
  }

  async handleIce(message: RtcIceMessage): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.signalingState === "closed") return;
    if (!pc.remoteDescription) {
      this.pendingIce.push(message);
      return;
    }
    await this.addIceCandidate(pc, message);
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.pc?.close();
    void this.dataQueue.then(() => this.options.sink.abort()).catch(() => {});
  }

  private createPeer(): void {
    this.channel?.close();
    this.pc?.close();
    this.pendingIce = [];
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    this.pc = pc;

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      this.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.onmessage = (message) => {
        // DataChannel ordering does not wait for asynchronous decryption or disk writes.
        this.dataQueue = this.dataQueue.then(async () => {
          if (!this.failed && !this.closed) await this.handleData(message.data);
        }).catch(async (error: unknown) => {
          if (this.failed || this.closed) return;
          this.failed = true;
          const failure = error instanceof Error ? error : new Error("接收失败");
          try {
            this.sendControl({ kind: "package:error", packageId: this.options.packageId, reason: failure.message });
          } catch {}
          await this.options.sink.abort().catch(() => {});
          this.options.onError(failure);
        });
      };
      channel.onerror = () => this.options.onError(new Error("接收通道出错，请重试传输"));
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.options.signal({
        type: "rtc:ice",
        packageId: this.options.packageId,
        targetDeviceId: this.options.senderDeviceId,
        senderDeviceId: this.options.receiverDeviceId,
        candidate: event.candidate.toJSON()
      });
    };
    pc.onicecandidateerror = (event) => {
      console.warn("[pigeon] ICE candidate error", {
        errorCode: event.errorCode,
        errorText: event.errorText,
        url: event.url
      });
    };
    pc.oniceconnectionstatechange = () => {
      this.updateConnectionRoute().catch(this.options.onError);
    };
    pc.onconnectionstatechange = () => {
      this.updateConnectionRoute().catch(this.options.onError);
    };
    this.emitConnectionRoute("checking");
  }

  private async handleData(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === "string") {
      await this.handleControl(JSON.parse(data) as ControlMessage);
      return;
    }

    const { header, bytes } = await unpackChunk(this.options.aesKey, data);
    if (this.closed) return;
    const entry = this.entries.get(header.entryId);
    if (!entry) throw new Error("收到未知文件分片");
    if (this.finishedEntries.has(entry.id)) return;
    if (this.currentEntry?.id !== entry.id) throw new Error("文件尚未准备好");

    const expectedIndex = this.receivedChunks.get(entry.id) ?? 0;
    if (header.index < expectedIndex) return;
    if (header.index > expectedIndex) {
      throw new Error("收到非连续文件分片，请重试传输");
    }
    const expectedBytes = Math.min(CHUNK_BYTES, entry.size - expectedIndex * CHUNK_BYTES);
    if (expectedBytes <= 0 || bytes.byteLength !== expectedBytes) throw new Error("文件分片大小无效");

    await this.options.sink.writeChunk(entry, bytes);
    this.ensureFileHash(entry.id).update(bytes);
    this.receivedChunks.set(entry.id, expectedIndex + 1);
    this.received += bytes.byteLength;
    this.options.onProgress({
      packageId: this.options.packageId,
      bytes: this.received,
      totalBytes: this.manifest?.totalBytes ?? this.received,
      currentPath: entry.relativePath
    });
  }

  private async handleControl(message: ControlMessage): Promise<void> {
    if (message.kind === "manifest") {
      if (message.manifest.packageId !== this.options.packageId) throw new Error("投递包不匹配");
      if (this.manifest && JSON.stringify(this.manifest) !== JSON.stringify(message.manifest)) {
        throw new Error("断点续传清单已变更");
      }
      this.manifest = message.manifest;
      this.entries = new Map(this.manifest.entries.map((entry) => [entry.id, entry]));
      this.received = bytesFromResume(this.manifest, this.currentResumeState());
      this.sendControl({ kind: "resume", state: this.currentResumeState() });
      return;
    }

    if (message.kind === "file:start") {
      const entry = this.entries.get(message.entryId);
      if (!entry) throw new Error("收到未知文件");
      if (this.finishedEntries.has(entry.id)) return;
      if (this.currentEntry && this.currentEntry.id !== entry.id) throw new Error("上一个文件尚未完成");
      if (message.startIndex !== (this.receivedChunks.get(entry.id) ?? 0)) throw new Error("断点位置不匹配");
      this.currentEntry = entry;
      this.ensureFileHash(entry.id);
      await this.options.sink.startFile(entry);
      return;
    }

    if (message.kind === "file:done") {
      const entry = this.entries.get(message.entryId);
      if (!entry) throw new Error("收到未知文件");
      if (this.finishedEntries.has(entry.id)) return;
      if (this.currentEntry?.id !== entry.id || (this.receivedChunks.get(entry.id) ?? 0) !== chunkCount(entry)) {
        throw new Error("文件尚未接收完整");
      }
      const actualHash = this.ensureFileHash(entry.id).digestHex();
      if (actualHash !== entry.sha256.toLowerCase()) {
        throw new Error(`文件校验失败：${entry.relativePath}`);
      }
      await this.options.sink.finishFile(entry);
      this.fileHashes.delete(entry.id);
      this.finishedEntries.add(entry.id);
      this.currentEntry = undefined;
      return;
    }

    if (message.kind === "package:done") {
      if (!this.manifest || this.currentEntry || this.manifest.entries.some((entry) => !this.finishedEntries.has(entry.id))) {
        throw new Error("投递包尚未接收完整");
      }
      if (!this.completed) {
        await this.options.sink.finishPackage();
        if (this.closed) return;
        this.completed = true;
        this.sendControl({ kind: "package:ack", packageId: this.options.packageId });
        this.options.onComplete();
      } else {
        this.sendControl({ kind: "package:ack", packageId: this.options.packageId });
      }
    }
  }

  private currentResumeState(): ResumeState {
    const entries: Record<string, number> = {};
    for (const [entryId, count] of this.receivedChunks) entries[entryId] = count;
    return { entries };
  }

  private ensureFileHash(entryId: string): Sha256Incremental {
    const existing = this.fileHashes.get(entryId);
    if (existing) return existing;
    const next = new Sha256Incremental();
    this.fileHashes.set(entryId, next);
    return next;
  }

  private sendControl(value: ControlMessage): void {
    if (this.channel?.readyState !== "open") return;
    this.channel.send(JSON.stringify(value));
  }

  private async updateConnectionRoute(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (pc.connectionState === "new" || pc.connectionState === "connecting") {
      this.emitConnectionRoute("checking");
      return;
    }

    if (pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") return;
    const route = await detectConnectionRoute(pc);
    if (route) this.emitConnectionRoute(route);
  }

  private emitConnectionRoute(route: ConnectionRoute): void {
    if (this.connectionRoute === route) return;
    this.connectionRoute = route;
    this.options.onConnectionRoute?.(route);
  }

  private async flushPendingIce(pc: RTCPeerConnection): Promise<void> {
    const pending = this.pendingIce.splice(0);
    for (const message of pending) {
      if (this.pc !== pc || pc.signalingState === "closed") return;
      await this.addIceCandidate(pc, message);
    }
  }

  private async addIceCandidate(pc: RTCPeerConnection, message: RtcIceMessage): Promise<void> {
    await addIceCandidateWithDiagnostics(pc, message);
  }
}

async function addIceCandidateWithDiagnostics(pc: RTCPeerConnection, message: RtcIceMessage): Promise<void> {
  try {
    await pc.addIceCandidate(message.candidate as RTCIceCandidateInit);
  } catch (error) {
    console.warn("[pigeon] addIceCandidate failed", {
      message: error instanceof Error ? error.message : String(error),
      candidate: message.candidate
    });
  }
}

function normalizeResumeState(state: ResumeState): ResumeState {
  return { entries: { ...state.entries } };
}

function chunkCount(entry: PackageEntry): number {
  return Math.ceil(entry.size / CHUNK_BYTES);
}

function bytesFromResume(manifest: PackageManifest, resume: ResumeState): number {
  return manifest.entries.reduce((sum, entry) => {
    const chunks = Math.min(resume.entries[entry.id] ?? 0, chunkCount(entry));
    if (chunks === 0) return sum;
    const fullChunkBytes = Math.min(chunks * CHUNK_BYTES, entry.size);
    return sum + fullChunkBytes;
  }, 0);
}

async function detectConnectionRoute(pc: RTCPeerConnection): Promise<ConnectionRoute | null> {
  const stats = await pc.getStats();
  const selectedPair = findSelectedCandidatePair(stats);
  if (!selectedPair) return null;

  const local = stats.get(selectedPair.localCandidateId);
  const remote = stats.get(selectedPair.remoteCandidateId);
  const localType = getCandidateType(local);
  const remoteType = getCandidateType(remote);

  if (localType === "relay" || remoteType === "relay") return "relay";
  if (localType === "host" && remoteType === "host") return "lan";
  return "direct";
}

function findSelectedCandidatePair(stats: RTCStatsReport): CandidatePairStats | null {
  let nominatedPair: CandidatePairStats | null = null;

  for (const stat of stats.values()) {
    if (!isCandidatePairStats(stat)) continue;
    if (stat.selected) return stat;
    if (stat.nominated && stat.state === "succeeded") nominatedPair = stat;
  }

  return nominatedPair;
}

function isCandidatePairStats(value: RTCStats): value is CandidatePairStats {
  const pair = value as Partial<CandidatePairStats>;
  return value.type === "candidate-pair" && typeof pair.localCandidateId === "string" && typeof pair.remoteCandidateId === "string";
}

function getCandidateType(value: RTCStats | undefined): string | undefined {
  const candidate = value as { candidateType?: string } | undefined;
  return candidate?.candidateType;
}

function describeConnectionFailure(iceServers: RTCIceServer[], reason?: string): string {
  const detail = reason ? `${reason}。` : "";
  if (!hasRelayIceServer(iceServers)) {
    return `${detail}无法建立文件传输连接：当前没有 TURN 中继，跨网络或移动网络下可能停在 0%。请配置 TURN 后重试。`;
  }
  return `${detail}无法建立文件传输连接，请检查两端网络或 TURN 凭证是否可用。`;
}

function hasRelayIceServer(iceServers: RTCIceServer[]): boolean {
  return iceServers.some((server) => toUrlList(server.urls).some((url) => /^turns?:/i.test(url)));
}

function toUrlList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

interface CandidatePairStats extends RTCStats {
  localCandidateId: string;
  remoteCandidateId: string;
  nominated?: boolean;
  selected?: boolean;
  state?: string;
}
