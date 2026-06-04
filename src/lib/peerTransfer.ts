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

type SendSignal = (message: RtcOfferMessage | RtcAnswerMessage | RtcIceMessage) => void;

interface ResumeState {
  entries: Record<string, number>;
}

type ControlMessage =
  | { kind: "manifest"; manifest: PackageManifest; resumable: true }
  | { kind: "resume"; state: ResumeState }
  | { kind: "file:start"; entryId: string; startIndex: number }
  | { kind: "file:done"; entryId: string }
  | { kind: "package:done" };

export interface ProgressEvent {
  packageId: string;
  bytes: number;
  totalBytes: number;
  currentPath?: string;
}

export type ConnectionRoute = "checking" | "lan" | "direct" | "relay";

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [900, 1600, 2800, 4600, 7000];
const RESUME_TIMEOUT_MS = 2000;

export class PackageSender {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private cancelled = false;
  private completed = false;
  private connectionRoute?: ConnectionRoute;
  private attempt = 0;
  private retryTimer?: ReturnType<typeof window.setTimeout>;
  private sendingRun = 0;
  private pendingResume?: (state: ResumeState) => void;
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
      onRetry?: (attempt: number, delayMs: number) => void;
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
    channel.onmessage = (event) => this.handleControlMessage(event.data);
    channel.onopen = () => {
      this.updateConnectionRoute().catch(this.options.onError);
      this.sendPackage(run).catch((error) => this.handleSendError(error));
    };
    channel.onclose = () => this.scheduleRetry();
    channel.onerror = () => this.scheduleRetry();

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
    pc.oniceconnectionstatechange = () => {
      this.updateConnectionRoute().catch(this.options.onError);
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        this.scheduleRetry();
      }
    };
    pc.onconnectionstatechange = () => {
      this.updateConnectionRoute().catch(this.options.onError);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        this.scheduleRetry();
      }
    };
    this.emitConnectionRoute("checking");

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
      this.pendingResume = undefined;
    }
  }

  private async sendPackage(run: number): Promise<void> {
    this.sendControl({ kind: "manifest", manifest: this.options.manifest, resumable: true });
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
      if (startIndex >= chunkCount(entry)) continue;

      this.sendControl({ kind: "file:start", entryId: entry.id, startIndex });
      let index = startIndex;
      for (let offset = startIndex * CHUNK_BYTES; offset < file.size; offset += CHUNK_BYTES) {
        if (this.cancelled || this.completed || run !== this.sendingRun) return;
        const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        await this.waitForBuffer();
        this.assertChannelOpen();
        this.channel?.send(await packChunk(this.options.aesKey, entry.id, index, bytes));
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

    this.completed = true;
    this.sendControl({ kind: "package:done" });
    this.options.onComplete();
    this.closePeer();
  }

  private waitForResumeState(): Promise<ResumeState> {
    return new Promise((resolve) => {
      const fallback = window.setTimeout(() => {
        if (this.pendingResume) {
          this.pendingResume = undefined;
          resolve({ entries: {} });
        }
      }, RESUME_TIMEOUT_MS);
      this.pendingResume = (state) => {
        window.clearTimeout(fallback);
        resolve(normalizeResumeState(state));
      };
    });
  }

  private sendControl(value: ControlMessage): void {
    this.assertChannelOpen();
    this.channel?.send(JSON.stringify(value));
  }

  private async waitForBuffer(): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.bufferedAmount < DATA_CHANNEL_BUFFER_LIMIT) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(resolve, 500);
      channel.onbufferedamountlow = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      channel.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("传输通道失败"));
      };
    });
  }

  private assertChannelOpen(): void {
    if (!this.channel || this.channel.readyState !== "open") {
      throw new Error("传输通道已断开");
    }
  }

  private handleSendError(error: unknown): void {
    if (this.cancelled || this.completed) return;
    if (error instanceof Error && error.message.startsWith("缺少文件")) {
      this.options.onError(error);
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.cancelled || this.completed || this.retryTimer || this.closingPeer) return;
    const retryAttempt = this.attempt;
    if (retryAttempt > MAX_RETRY_ATTEMPTS) {
      this.options.onError(new Error("传输连接多次中断，已停止自动重试"));
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt - 1, RETRY_DELAYS_MS.length - 1)];
    this.options.onRetry?.(retryAttempt, delay);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.startAttempt().catch(this.options.onError);
    }, delay) as any;
  }

  private closePeer(): void {
    this.pendingResume = undefined;
    this.pendingIce = [];
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
    await pc.addIceCandidate(message.candidate as RTCIceCandidateInit).catch(() => undefined);
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
  private pendingIce: RtcIceMessage[] = [];

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
    this.channel?.close();
    this.pc?.close();
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
        this.handleData(message.data).catch(this.options.onError);
      };
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
    const entry = this.entries.get(header.entryId);
    if (!entry) throw new Error("收到未知文件分片");
    if (this.finishedEntries.has(entry.id)) return;

    const expectedIndex = this.receivedChunks.get(entry.id) ?? 0;
    if (header.index < expectedIndex) return;
    if (header.index > expectedIndex) {
      throw new Error("收到非连续文件分片，请重试传输");
    }

    await this.options.sink.writeChunk(entry, bytes);
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
      this.currentEntry = entry;
      await this.options.sink.startFile(entry);
      return;
    }

    if (message.kind === "file:done") {
      const entry = this.entries.get(message.entryId);
      if (entry && this.currentEntry?.id === entry.id) {
        await this.options.sink.finishFile(entry);
        this.finishedEntries.add(entry.id);
        this.currentEntry = undefined;
      }
      return;
    }

    if (message.kind === "package:done") {
      await this.options.sink.finishPackage();
      this.options.onComplete();
    }
  }

  private currentResumeState(): ResumeState {
    const entries: Record<string, number> = {};
    for (const [entryId, count] of this.receivedChunks) entries[entryId] = count;
    return { entries };
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
    await pc.addIceCandidate(message.candidate as RTCIceCandidateInit).catch(() => undefined);
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

interface CandidatePairStats extends RTCStats {
  localCandidateId: string;
  remoteCandidateId: string;
  nominated?: boolean;
  selected?: boolean;
  state?: string;
}
