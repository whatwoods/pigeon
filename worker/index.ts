import { Hono } from "hono";
import type { DeviceRegistrationPayload, IceServerPayload } from "../src/shared/protocol";
import { randomId, randomToken, sha256Hex } from "./crypto";
import { DeviceRoom, PairRoom } from "./durable";
import type { Env } from "./types";

export { DeviceRoom, PairRoom };

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  return c.json({ error: error.message || "服务器错误" }, 500);
});

app.all("/api/auth/*", (c) => c.json({ error: "账号功能已移除" }, 404));
app.all("/api/me", (c) => c.json({ error: "账号功能已移除" }, 404));
app.all("/api/devices", (c) => c.json({ error: "账号功能已移除" }, 404));

app.post("/api/rooms", async (c) => {
  const device = await readDeviceRegistration(c.req.raw);
  const now = Date.now();
  const roomId = randomId();
  const roomToken = randomToken(32);

  await c.env.DB.prepare("INSERT INTO rooms (id, created_at) VALUES (?, ?)")
    .bind(roomId, now)
    .run();
  await upsertRoomDevice(c.env, roomId, roomToken, device, now);

  return c.json({ roomId, roomToken, deviceId: device.deviceId });
});

app.post("/api/rooms/join", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body) || typeof body.inviteToken !== "string") {
    return c.json({ error: "邀请无效" }, 400);
  }

  const device = readDeviceRegistrationValue(body);
  if (!device) return c.json({ error: "设备信息无效" }, 400);

  const invite = await c.env.DB.prepare("SELECT room_id, expires_at FROM room_invites WHERE token_hash = ?")
    .bind(await sha256Hex(body.inviteToken))
    .first<{ room_id: string; expires_at: number }>();
  if (!invite || invite.expires_at < Date.now()) return c.json({ error: "邀请已失效" }, 404);

  const roomToken = randomToken(32);
  await upsertRoomDevice(c.env, invite.room_id, roomToken, device, Date.now());

  return c.json({ roomId: invite.room_id, roomToken, deviceId: device.deviceId });
});

app.post("/api/rooms/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body) || typeof body.roomId !== "string" || typeof body.roomToken !== "string" || typeof body.deviceId !== "string") {
    return c.json({ error: "参数无效" }, 400);
  }

  const device = await authenticateRoomDevice(c.env, body.roomId, body.roomToken, body.deviceId);
  return c.json({ valid: !!device });
});

app.post("/api/rooms/invites", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body) || typeof body.roomId !== "string" || typeof body.roomToken !== "string") {
    return c.json({ error: "房间凭证无效" }, 400);
  }

  const device = await authenticateRoomDevice(c.env, body.roomId, body.roomToken);
  if (!device) return c.json({ error: "房间凭证无效" }, 401);

  const inviteToken = randomToken(12);
  const expiresAt = Date.now() + 30 * 60 * 1000;
  await c.env.DB.prepare("INSERT INTO room_invites (token_hash, room_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(inviteToken), body.roomId, expiresAt, Date.now())
    .run();

  const origin = c.env.APP_ORIGIN || new URL(c.req.url).origin;
  return c.json({
    inviteToken,
    expiresAt,
    url: `${origin}/?roomInvite=${encodeURIComponent(inviteToken)}`
  });
});

app.post("/api/pairs", async (c) => {
  const code = createPairCode();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await c.env.DB.prepare("INSERT INTO pair_rooms (code, expires_at, created_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(code), expiresAt, Date.now())
    .run();

  // Async cleanup of expired records
  c.executionCtx.waitUntil(
    Promise.all([
      c.env.DB.prepare("DELETE FROM pair_rooms WHERE expires_at < ?").bind(Date.now()).run(),
      c.env.DB.prepare("DELETE FROM room_invites WHERE expires_at < ?").bind(Date.now()).run(),
      c.env.DB.prepare("DELETE FROM pair_attempts WHERE timestamp < ?").bind(Date.now() - 60000).run()
    ]).catch(() => {})
  );

  const origin = c.env.APP_ORIGIN || new URL(c.req.url).origin;
  return c.json({
    code,
    expiresAt,
    url: `${origin}/?code=${encodeURIComponent(code)}`
  });
});

app.get("/ws/room/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const deviceId = c.req.query("deviceId");
  const roomToken = c.req.query("token");
  if (!deviceId || !roomToken) return c.text("Missing room credentials", 400);

  const device = await authenticateRoomDevice(c.env, roomId, roomToken, deviceId);
  if (!device) return c.text("Room credentials invalid", 401);

  await c.env.DB.prepare("UPDATE room_devices SET last_seen = ? WHERE room_id = ? AND id = ?")
    .bind(Date.now(), roomId, deviceId)
    .run();

  const id = c.env.DEVICE_ROOM.idFromName(roomId);
  const stub = c.env.DEVICE_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

app.get("/api/turn", (c) => {
  const iceServers: IceServerPayload[] = [{ urls: "stun:stun.l.google.com:19302" }];
  if (c.env.TURN_URLS && c.env.TURN_USERNAME && c.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: c.env.TURN_URLS.split(",").map((value) => value.trim()),
      username: c.env.TURN_USERNAME,
      credential: c.env.TURN_CREDENTIAL
    });
  }
  return c.json({ iceServers });
});

app.get("/ws/pair/:code", async (c) => {
  const code = c.req.param("code").toUpperCase();
  const role = c.req.query("role");

  // Validate extracting code format
  if (!/^[2-9A-Z]{6}$/.test(code)) {
    return c.text("Invalid pair code format", 400);
  }

  const ip = c.req.header("CF-Connecting-IP") || "127.0.0.1";
  const now = Date.now();

  // Rate limiting lookup
  const attempts = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM pair_attempts WHERE ip = ? AND timestamp > ?"
  )
    .bind(ip, now - 60000)
    .first<{ count: number }>();

  if (attempts && attempts.count >= 5) {
    return c.text("Too many failed attempts. Please try again in a minute.", 429);
  }

  const codeHash = await sha256Hex(code);
  const row = await c.env.DB.prepare("SELECT expires_at FROM pair_rooms WHERE code = ?")
    .bind(codeHash)
    .first<{ expires_at: number }>();

  if (!row || row.expires_at < now) {
    // Record failed attempt
    await c.env.DB.prepare("INSERT INTO pair_attempts (ip, timestamp) VALUES (?, ?)")
      .bind(ip, now)
      .run();

    c.executionCtx.waitUntil(
      Promise.all([
        c.env.DB.prepare("DELETE FROM pair_rooms WHERE expires_at < ?").bind(now).run(),
        c.env.DB.prepare("DELETE FROM room_invites WHERE expires_at < ?").bind(now).run(),
        c.env.DB.prepare("DELETE FROM pair_attempts WHERE timestamp < ?").bind(now - 60000).run()
      ]).catch(() => {})
    );

    return c.text("Pair code expired", 404);
  }

  if (role !== "sender" && role !== "receiver") return c.text("Missing role", 400);

  c.executionCtx.waitUntil(
    Promise.all([
      c.env.DB.prepare("DELETE FROM pair_rooms WHERE expires_at < ?").bind(now).run(),
      c.env.DB.prepare("DELETE FROM room_invites WHERE expires_at < ?").bind(now).run(),
      c.env.DB.prepare("DELETE FROM pair_attempts WHERE timestamp < ?").bind(now - 60000).run()
    ]).catch(() => {})
  );

  const id = c.env.PAIR_ROOM.idFromName(codeHash);
  const stub = c.env.PAIR_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

app.notFound((c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Not found", 404);
});

function createPairCode(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}

async function readDeviceRegistration(request: Request): Promise<DeviceRegistrationPayload> {
  const value = await request.json().catch(() => null);
  const device = readDeviceRegistrationValue(value);
  if (!device) throw new Error("设备信息无效");
  return device;
}

function readDeviceRegistrationValue(value: unknown): DeviceRegistrationPayload | null {
  if (
    !isRecord(value) ||
    typeof value.deviceId !== "string" ||
    typeof value.deviceName !== "string" ||
    !isJsonWebKey(value.publicKey)
  ) {
    return null;
  }

  return {
    deviceId: value.deviceId,
    deviceName: value.deviceName.slice(0, 80),
    publicKey: value.publicKey as JsonWebKey
  };
}

function isJsonWebKey(value: unknown): value is JsonWebKey {
  return isRecord(value) && typeof value.kty === "string";
}

async function upsertRoomDevice(
  env: Env,
  roomId: string,
  roomToken: string,
  device: DeviceRegistrationPayload,
  now: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO room_devices
      (id, room_id, token_hash, name, public_key, last_seen, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      device.deviceId,
      roomId,
      await sha256Hex(roomToken),
      device.deviceName,
      JSON.stringify(device.publicKey),
      now,
      now
    )
    .run();
}

async function authenticateRoomDevice(
  env: Env,
  roomId: string,
  roomToken: string,
  deviceId?: string
): Promise<{ id: string; name: string } | null> {
  const query = deviceId
    ? env.DB.prepare("SELECT id, name FROM room_devices WHERE room_id = ? AND id = ? AND token_hash = ?")
        .bind(roomId, deviceId, await sha256Hex(roomToken))
    : env.DB.prepare("SELECT id, name FROM room_devices WHERE room_id = ? AND token_hash = ?")
        .bind(roomId, await sha256Hex(roomToken));
  return query.first<{ id: string; name: string }>();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default app;
