import { DurableObject } from "cloudflare:workers";
import {
  parseSignalMessagePayload,
  SIGNAL_MESSAGE_MAX_BYTES,
  type SignalMessage
} from "../src/shared/protocol";
import type { Env } from "./types";

interface Attachment {
  deviceId: string;
  role?: "sender" | "receiver";
  deviceName?: string;
}

export class PairRoom extends DurableObject<Env> {
  private acceptedPackages = new Set<string>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const deviceId = url.searchParams.get("deviceId") || crypto.randomUUID();
    if (role !== "sender" && role !== "receiver") return new Response("Missing role", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment({ deviceId, role } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = ws.deserializeAttachment() as Attachment;
    const parsed = readSignalMessage(ws, message);
    if (!parsed) return;
    const enriched = { ...parsed, senderDeviceId: attachment.deviceId } as SignalMessage;
    await this.route(attachment, enriched);
  }

  private async route(attachment: Attachment, message: SignalMessage): Promise<void> {
    if (!isAllowedPairMessage(attachment, message)) return;

    const sockets = this.ctx.getWebSockets();
    if (message.type === "package:offer") {
      await this.releasePackage(message.packageId);
    }
    if (message.type === "package:accept") {
      if (!(await this.claimPackage(message.packageId, attachment.deviceId))) return;
    }

    const targetDeviceId =
      "targetDeviceId" in message && message.targetDeviceId ? message.targetDeviceId : undefined;
    for (const socket of sockets) {
      const target = socket.deserializeAttachment() as Attachment;
      if (target.deviceId === attachment.deviceId) continue;
      if (targetDeviceId && target.deviceId !== targetDeviceId) continue;

      if (message.type === "package:offer" && target.role === "receiver") {
        socket.send(JSON.stringify(message));
        continue;
      }

      if (message.type !== "package:offer") {
        socket.send(JSON.stringify(message));
      }
    }
  }

  private async claimPackage(packageId: string, deviceId: string): Promise<boolean> {
    if (this.acceptedPackages.has(packageId)) return false;

    const key = acceptedPackageKey(packageId);
    const acceptedBy = await this.ctx.storage.get<string>(key);
    if (acceptedBy || this.acceptedPackages.has(packageId)) return false;

    this.acceptedPackages.add(packageId);
    await this.ctx.storage.put(key, deviceId);
    return true;
  }

  private async releasePackage(packageId: string): Promise<void> {
    this.acceptedPackages.delete(packageId);
    await this.ctx.storage.delete(acceptedPackageKey(packageId));
  }
}

export class DeviceRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId") || "";
    const deviceName = url.searchParams.get("deviceName") || "pigeon device";
    if (!deviceId) return new Response("Missing device", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment({ deviceId, deviceName } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = ws.deserializeAttachment() as Attachment;
    const parsed = readSignalMessage(ws, message);
    if (!parsed || !isAllowedRoomMessage(parsed)) return;

    const enriched = { ...parsed, senderDeviceId: attachment.deviceId } as SignalMessage;
    this.route(ws, attachment, enriched);
  }

  webSocketClose(): void {
    this.broadcastPresence();
  }

  webSocketError(): void {
    this.broadcastPresence();
  }

  private route(source: WebSocket, attachment: Attachment, message: SignalMessage): void {
    const sockets = this.ctx.getWebSockets();
    const targetDeviceId =
      "targetDeviceId" in message && message.targetDeviceId ? message.targetDeviceId : undefined;

    for (const socket of sockets) {
      if (socket === source) continue;
      const target = socket.deserializeAttachment() as Attachment;
      if (target.deviceId === attachment.deviceId) continue;
      if (targetDeviceId && target.deviceId !== targetDeviceId) continue;

      try {
        socket.send(JSON.stringify(message));
      } catch {
        socket.close(1011, "Route failed");
      }
    }
  }

  private broadcastPresence(): void {
    const seen = new Set<string>();
    const onlineDevices = this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (!attachment.deviceId || seen.has(attachment.deviceId)) return [];
      seen.add(attachment.deviceId);
      return [{ deviceId: attachment.deviceId, deviceName: attachment.deviceName || "pigeon device" }];
    });
    const message = JSON.stringify({ type: "room:presence", onlineDevices } satisfies SignalMessage);

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Presence failed");
      }
    }
  }
}

function readSignalMessage(ws: WebSocket, payload: string): SignalMessage | null {
  if (payload.length > SIGNAL_MESSAGE_MAX_BYTES) {
    ws.close(1009, "Message too large");
    return null;
  }

  const message = parseSignalMessagePayload(payload);
  if (!message) {
    ws.close(1003, "Invalid message");
    return null;
  }

  return message;
}

function isAllowedPairMessage(attachment: Attachment, message: SignalMessage): boolean {
  if (attachment.role === "sender") {
    return (
      message.type === "package:offer" ||
      message.type === "text:offer" ||
      message.type === "text:payload" ||
      message.type === "rtc:offer" ||
      message.type === "rtc:ice" ||
      message.type === "transfer:progress" ||
      message.type === "transfer:complete" ||
      message.type === "transfer:cancel"
    );
  }

  if (attachment.role === "receiver") {
    return (
      message.type === "package:accept" ||
      message.type === "package:reject" ||
      message.type === "text:accept" ||
      message.type === "rtc:answer" ||
      message.type === "rtc:ice" ||
      message.type === "transfer:cancel"
    );
  }

  return false;
}

function isAllowedRoomMessage(message: SignalMessage): boolean {
  return (
    message.type === "package:offer" ||
    message.type === "package:accept" ||
    message.type === "package:reject" ||
    message.type === "text:offer" ||
    message.type === "text:accept" ||
    message.type === "text:payload" ||
    message.type === "rtc:offer" ||
    message.type === "rtc:answer" ||
    message.type === "rtc:ice" ||
    message.type === "transfer:cancel"
  );
}

function acceptedPackageKey(packageId: string): string {
  return `accepted:${packageId}`;
}
