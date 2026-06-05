export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const PACKAGE_WARNING_BYTES = 2 * 1024 * 1024 * 1024;
export const PACKAGE_WARNING_ENTRIES = 2000;
export const CHUNK_BYTES = 64 * 1024;
export const DATA_CHANNEL_BUFFER_LIMIT = 8 * 1024 * 1024;
export const SIGNAL_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;

export type PublicJwk = JsonWebKey;

export interface RtcSessionDescriptionPayload {
  type: string;
  sdp?: string;
}

export interface RtcIceCandidatePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerPayload {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type TurnCredentialSource = "cloudflare" | "static" | "stun-only";

export interface PackageEntry {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mime: string;
  sha256: string;
  lastModified: number;
}

export interface PackageManifest {
  packageId: string;
  name: string;
  entries: PackageEntry[];
  totalBytes: number;
  createdAt: number;
  senderDeviceId: string;
}

export type DeliveryScope = "pair" | "room";

export interface RoomDevicePresence {
  deviceId: string;
  deviceName: string;
}

export interface DeviceRegistrationPayload {
  deviceId: string;
  deviceName: string;
  publicKey: PublicJwk;
}

export interface RoomSessionResponse {
  roomId: string;
  roomToken: string;
  deviceId: string;
}

export interface RoomInviteResponse {
  inviteToken: string;
  expiresAt: number;
  url: string;
}

export interface TextPayloadMessage {
  type: "text:payload";
  id: string;
  targetDeviceId: string;
  senderDeviceId: string;
  senderPublicKey: PublicJwk;
  iv: string;
  ciphertext: string;
  createdAt: number;
}

export interface TextOfferMessage {
  type: "text:offer";
  id: string;
  deliveryScope?: DeliveryScope;
  targetDeviceId?: string;
  senderDeviceId: string;
  senderPublicKey: PublicJwk;
  createdAt: number;
}

export interface TextAcceptMessage {
  type: "text:accept";
  id: string;
  targetDeviceId: string;
  receiverDeviceId: string;
  receiverPublicKey: PublicJwk;
}

export interface PackageOfferMessage {
  type: "package:offer";
  packageId: string;
  deliveryScope?: DeliveryScope;
  targetDeviceId?: string;
  senderDeviceId: string;
  senderPublicKey: PublicJwk;
  manifest: PackageManifest;
  createdAt: number;
}

export interface PackageAcceptMessage {
  type: "package:accept";
  packageId: string;
  targetDeviceId: string;
  receiverDeviceId: string;
  receiverPublicKey: PublicJwk;
}

export interface PackageRejectMessage {
  type: "package:reject";
  packageId: string;
  targetDeviceId: string;
  receiverDeviceId: string;
  reason?: string;
}

export interface RtcOfferMessage {
  type: "rtc:offer";
  packageId: string;
  targetDeviceId: string;
  senderDeviceId: string;
  description: RtcSessionDescriptionPayload;
}

export interface RtcAnswerMessage {
  type: "rtc:answer";
  packageId: string;
  targetDeviceId: string;
  receiverDeviceId: string;
  description: RtcSessionDescriptionPayload;
}

export interface RtcIceMessage {
  type: "rtc:ice";
  packageId: string;
  targetDeviceId: string;
  senderDeviceId: string;
  candidate: RtcIceCandidatePayload;
}

export interface TransferProgressMessage {
  type: "transfer:progress";
  packageId: string;
  bytesSent: number;
  totalBytes: number;
  currentPath?: string;
}

export interface TransferCompleteMessage {
  type: "transfer:complete";
  packageId: string;
}

export interface TransferCancelMessage {
  type: "transfer:cancel";
  packageId: string;
  targetDeviceId?: string;
  reason?: string;
}

export interface RoomPresenceMessage {
  type: "room:presence";
  onlineDevices: RoomDevicePresence[];
}

export type SignalMessage =
  | RoomPresenceMessage
  | TextPayloadMessage
  | TextOfferMessage
  | TextAcceptMessage
  | PackageOfferMessage
  | PackageAcceptMessage
  | PackageRejectMessage
  | RtcOfferMessage
  | RtcAnswerMessage
  | RtcIceMessage
  | TransferProgressMessage
  | TransferCompleteMessage
  | TransferCancelMessage;

export function parseSignalMessagePayload(payload: string): SignalMessage | null {
  if (payload.length > SIGNAL_MESSAGE_MAX_BYTES) return null;

  try {
    const value: unknown = JSON.parse(payload);
    return isSignalMessage(value) ? value : null;
  } catch {
    return null;
  }
}

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (!isRecord(value) || !isString(value.type)) return false;

  switch (value.type) {
    case "room:presence":
      return Array.isArray(value.onlineDevices) && value.onlineDevices.every(isRoomDevicePresence);
    case "text:payload":
      return (
        isString(value.id) &&
        isString(value.targetDeviceId) &&
        isString(value.senderDeviceId) &&
        isRecord(value.senderPublicKey) &&
        isString(value.iv) &&
        isString(value.ciphertext) &&
        isNumber(value.createdAt)
      );
    case "text:offer":
      return (
        isString(value.id) &&
        isOptionalDeliveryScope(value.deliveryScope) &&
        isOptionalString(value.targetDeviceId) &&
        isString(value.senderDeviceId) &&
        isRecord(value.senderPublicKey) &&
        isNumber(value.createdAt)
      );
    case "text:accept":
      return (
        isString(value.id) &&
        isString(value.targetDeviceId) &&
        isString(value.receiverDeviceId) &&
        isRecord(value.receiverPublicKey)
      );
    case "package:offer":
      return (
        isString(value.packageId) &&
        isOptionalDeliveryScope(value.deliveryScope) &&
        isOptionalString(value.targetDeviceId) &&
        isString(value.senderDeviceId) &&
        isRecord(value.senderPublicKey) &&
        isPackageManifest(value.manifest) &&
        isNumber(value.createdAt)
      );
    case "package:accept":
      return (
        isString(value.packageId) &&
        isString(value.targetDeviceId) &&
        isString(value.receiverDeviceId) &&
        isRecord(value.receiverPublicKey)
      );
    case "package:reject":
      return (
        isString(value.packageId) &&
        isString(value.targetDeviceId) &&
        isString(value.receiverDeviceId) &&
        isOptionalString(value.reason)
      );
    case "rtc:offer":
      return (
        isString(value.packageId) &&
        isString(value.targetDeviceId) &&
        isString(value.senderDeviceId) &&
        isSessionDescription(value.description)
      );
    case "rtc:answer":
      return (
        isString(value.packageId) &&
        isString(value.targetDeviceId) &&
        isString(value.receiverDeviceId) &&
        isSessionDescription(value.description)
      );
    case "rtc:ice":
      return (
        isString(value.packageId) &&
        isString(value.targetDeviceId) &&
        isString(value.senderDeviceId) &&
        isIceCandidate(value.candidate)
      );
    case "transfer:progress":
      return (
        isString(value.packageId) &&
        isNumber(value.bytesSent) &&
        isNumber(value.totalBytes) &&
        isOptionalString(value.currentPath)
      );
    case "transfer:complete":
      return isString(value.packageId);
    case "transfer:cancel":
      return isString(value.packageId) && isOptionalString(value.targetDeviceId) && isOptionalString(value.reason);
    default:
      return false;
  }
}

function isRoomDevicePresence(value: unknown): value is RoomDevicePresence {
  return isRecord(value) && isString(value.deviceId) && isString(value.deviceName);
}

function isOptionalDeliveryScope(value: unknown): value is DeliveryScope | undefined {
  return value === undefined || value === "pair" || value === "room";
}

function isPackageManifest(value: unknown): value is PackageManifest {
  if (!isRecord(value) || !Array.isArray(value.entries)) return false;
  return (
    isString(value.packageId) &&
    isString(value.name) &&
    isNumber(value.totalBytes) &&
    isNumber(value.createdAt) &&
    isString(value.senderDeviceId) &&
    value.entries.every(isPackageEntry)
  );
}

function isPackageEntry(value: unknown): value is PackageEntry {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.name) &&
    isString(value.relativePath) &&
    isNumber(value.size) &&
    value.size >= 0 &&
    value.size <= MAX_FILE_BYTES &&
    isString(value.mime) &&
    isString(value.sha256) &&
    value.sha256.length === 64 &&
    isNumber(value.lastModified)
  );
}

function isSessionDescription(value: unknown): value is RtcSessionDescriptionPayload {
  return isRecord(value) && isString(value.type) && isOptionalString(value.sdp);
}

function isIceCandidate(value: unknown): value is RtcIceCandidatePayload {
  return (
    isRecord(value) &&
    isOptionalString(value.candidate) &&
    isOptionalStringOrNull(value.sdpMid) &&
    isOptionalNumberOrNull(value.sdpMLineIndex) &&
    isOptionalStringOrNull(value.usernameFragment)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalNumberOrNull(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || isNumber(value);
}

export interface PairCreateResponse {
  code: string;
  expiresAt: number;
  url: string;
}

export interface TurnResponse {
  iceServers: IceServerPayload[];
  relayAvailable: boolean;
  source: TurnCredentialSource;
  warning?: string;
}
