import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DeviceRegistrationPayload, IceServerPayload, TurnResponse } from "../src/shared/protocol";
import { randomId, randomToken, sha256Hex } from "./crypto";
import { DeviceRoom, PairRoom } from "./durable";
import type { Env } from "./types";

export { DeviceRoom, PairRoom };

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  return c.json({ error: error.message || "服务器错误" }, error instanceof HTTPException ? error.status : 500);
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
  try {
    await upsertRoomDevice(c.env, roomId, roomToken, device, now);
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId).run();
    throw error;
  }

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
  c.executionCtx.waitUntil(cleanupExpiredRecords(c.env, Date.now()));

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

app.get("/api/turn", async (c) => {
  c.header("Cache-Control", "no-store");
  const roomId = c.req.header("X-Room-Id");
  const deviceId = c.req.header("X-Device-Id");
  const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!roomId || !deviceId || !token || !(await authenticateRoomDevice(c.env, roomId, token, deviceId))) {
    return c.json({ error: "房间凭证无效" }, 401);
  }
  const now = Date.now();
  const ip = c.req.header("CF-Connecting-IP") || "127.0.0.1";
  if (!(await allowTurnRequest(c.env, deviceId, ip, now))) {
    c.header("Retry-After", "60");
    return c.json({ error: "中继凭证请求过于频繁，请稍后重试" }, 429);
  }
  c.executionCtx.waitUntil(
    c.env.DB.prepare("DELETE FROM turn_rate_limits WHERE window_start < ?").bind(now - 120000).run()
  );
  return c.json(await resolveIceServers(c.env));
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
  const attempts = await countRecentPairAttempts(c.env, ip, now - 60000);
  if (attempts >= 5) {
    return c.text("Too many failed attempts. Please try again in a minute.", 429);
  }

  const codeHash = await sha256Hex(code);
  const row = await c.env.DB.prepare("SELECT expires_at FROM pair_rooms WHERE code = ?")
    .bind(codeHash)
    .first<{ expires_at: number }>();

  if (!row || row.expires_at < now) {
    // Record failed attempt
    await recordFailedPairAttempt(c.env, ip, now);

    c.executionCtx.waitUntil(cleanupExpiredRecords(c.env, now));

    return c.text("Pair code expired", 404);
  }

  if (role !== "sender" && role !== "receiver") return c.text("Missing role", 400);

  c.executionCtx.waitUntil(cleanupExpiredRecords(c.env, now));

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

const DEFAULT_STUN_ICE_SERVERS: IceServerPayload[] = [{ urls: "stun:stun.l.google.com:19302" }];
const CLOUDFLARE_TURN_CREDENTIAL_URL = "https://rtc.live.cloudflare.com/v1/turn/keys";
const DEFAULT_TURN_TTL_SECONDS = 10 * 60;
const MAX_TURN_TTL_SECONDS = 60 * 60;

async function allowTurnRequest(env: Env, deviceId: string, ip: string, now: number): Promise<boolean> {
  const windowStart = Math.floor(now / 60000) * 60000;
  const limits = [
    { key: `device:${deviceId}`, limit: 12 },
    { key: `ip:${await sha256Hex(ip)}`, limit: 60 }
  ];
  const results = await env.DB.batch(limits.map(({ key, limit }) => env.DB.prepare(
    `INSERT INTO turn_rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     WHERE window_start != excluded.window_start OR count < ?
     RETURNING count`
  ).bind(key, windowStart, limit)));
  return results.every((result) => result.results.length > 0);
}

async function resolveIceServers(env: Env): Promise<TurnResponse> {
  const staticTurn = await createSharedSecretTurnIceServers(env);

  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const cloudflareIceServers = await fetchCloudflareTurnIceServers(env);
    if (cloudflareIceServers.length > 0) {
      const relayAvailable = hasRelayIceServer(cloudflareIceServers);
      return {
        iceServers: cloudflareIceServers,
        relayAvailable,
        source: "cloudflare",
        warning: relayAvailable ? undefined : "Cloudflare TURN 响应未包含中继地址，跨网络传输可能失败"
      };
    }

    if (staticTurn.length > 0) {
      const iceServers = [...DEFAULT_STUN_ICE_SERVERS, ...staticTurn];
      return {
        iceServers,
        relayAvailable: hasRelayIceServer(iceServers),
        source: "static",
        warning: "Cloudflare TURN 凭证获取失败，已使用静态 TURN 配置"
      };
    }

    return {
      iceServers: DEFAULT_STUN_ICE_SERVERS,
      relayAvailable: false,
      source: "stun-only",
      warning: "Cloudflare TURN 凭证获取失败，当前仅使用 STUN"
    };
  }

  if (staticTurn.length > 0) {
    const iceServers = [...DEFAULT_STUN_ICE_SERVERS, ...staticTurn];
    const relayAvailable = hasRelayIceServer(iceServers);
    return {
      iceServers,
      relayAvailable,
      source: "static",
      warning: relayAvailable ? undefined : "静态 TURN 配置未包含中继地址，跨网络传输可能失败"
    };
  }

  if (env.TURN_URLS || env.TURN_SHARED_SECRET || env.TURN_USERNAME || env.TURN_CREDENTIAL) {
    console.warn(JSON.stringify({ event: "turn_static_config_incomplete" }));
  }

  return {
    iceServers: DEFAULT_STUN_ICE_SERVERS,
    relayAvailable: false,
    source: "stun-only",
    warning: "未配置 TURN 中继，跨网络文件传输可能无法建立连接"
  };
}

async function fetchCloudflareTurnIceServers(env: Env): Promise<IceServerPayload[]> {
  const keyId = env.TURN_KEY_ID;
  const apiToken = env.TURN_KEY_API_TOKEN;
  if (!keyId || !apiToken) return [];

  const response = await fetch(
    `${CLOUDFLARE_TURN_CREDENTIAL_URL}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl: normalizeTurnTtl(env.TURN_TTL_SECONDS) })
    }
  ).catch((error) => {
    logTurnIssue("cloudflare_turn_fetch_failed", error);
    return null;
  });

  if (!response) return [];
  if (!response.ok) {
    logTurnIssue("cloudflare_turn_response_failed", { status: response.status });
    return [];
  }

  const body = await response.json().catch((error) => {
    logTurnIssue("cloudflare_turn_json_failed", error);
    return null;
  });
  if (!isRecord(body) || !Array.isArray(body.iceServers)) {
    logTurnIssue("cloudflare_turn_payload_invalid");
    return [];
  }

  const iceServers = body.iceServers.filter(isIceServerPayload);
  if (iceServers.length === 0) logTurnIssue("cloudflare_turn_ice_servers_empty");
  return iceServers;
}

async function createSharedSecretTurnIceServers(env: Env): Promise<IceServerPayload[]> {
  const urls = parseCsv(env.TURN_URLS);
  if (urls.length === 0) return [];
  if (!env.TURN_SHARED_SECRET) {
    console.warn(JSON.stringify({ event: "turn_static_credentials_missing" }));
    return [];
  }

  const expiresAt = Math.floor(Date.now() / 1000) + normalizeTurnTtl(env.TURN_TTL_SECONDS);
  const username = `${expiresAt}:${randomId()}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TURN_SHARED_SECRET), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  return [{
    urls,
    username,
    credential: btoa(String.fromCharCode(...new Uint8Array(signature)))
  }];
}

function normalizeTurnTtl(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TURN_TTL_SECONDS;
  return Math.min(MAX_TURN_TTL_SECONDS, Math.max(60, parsed));
}

function hasRelayIceServer(iceServers: IceServerPayload[]): boolean {
  return iceServers.some((server) => toUrlList(server.urls).some((url) => /^turns?:/i.test(url)));
}

function isIceServerPayload(value: unknown): value is IceServerPayload {
  if (!isRecord(value)) return false;
  const urls = value.urls;
  return (
    (typeof urls === "string" || (Array.isArray(urls) && urls.every((url) => typeof url === "string" && url.length > 0))) &&
    (value.username === undefined || typeof value.username === "string") &&
    (value.credential === undefined || typeof value.credential === "string")
  );
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function toUrlList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function logTurnIssue(event: string, detail?: unknown): void {
  const payload: Record<string, unknown> = { event };
  if (detail instanceof Error) payload.message = detail.message;
  if (isRecord(detail) && typeof detail.status === "number") payload.status = detail.status;
  console.warn(JSON.stringify(payload));
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
    !isJsonWebKey(value.publicKey) ||
    (value.previousRoomToken !== undefined && typeof value.previousRoomToken !== "string")
  ) {
    return null;
  }

  return {
    deviceId: value.deviceId,
    deviceName: value.deviceName.slice(0, 80),
    publicKey: value.publicKey as JsonWebKey,
    previousRoomToken: value.previousRoomToken as string | undefined
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
  const registered = await env.DB.prepare(
    `INSERT INTO room_devices
      (id, room_id, token_hash, name, public_key, last_seen, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        room_id = excluded.room_id, token_hash = excluded.token_hash,
        name = excluded.name, public_key = excluded.public_key,
        last_seen = excluded.last_seen
      WHERE room_devices.token_hash = ?
      RETURNING id`
  )
    .bind(
      device.deviceId,
      roomId,
      await sha256Hex(roomToken),
      device.deviceName,
      JSON.stringify(device.publicKey),
      now,
      now,
      device.previousRoomToken ? await sha256Hex(device.previousRoomToken) : null
    )
    .first<{ id: string }>();
  if (!registered) throw new HTTPException(409, { message: "设备已注册，请使用原房间凭证迁移设备" });
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

async function countRecentPairAttempts(env: Env, ip: string, since: number): Promise<number> {
  try {
    const attempts = await env.DB.prepare("SELECT COUNT(*) as count FROM pair_attempts WHERE ip = ? AND timestamp > ?")
      .bind(ip, since)
      .first<{ count: number }>();
    return attempts?.count ?? 0;
  } catch (error) {
    if (isMissingPairAttemptsTable(error)) return 0;
    throw error;
  }
}

async function recordFailedPairAttempt(env: Env, ip: string, timestamp: number): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO pair_attempts (ip, timestamp) VALUES (?, ?)")
      .bind(ip, timestamp)
      .run();
  } catch (error) {
    if (!isMissingPairAttemptsTable(error)) throw error;
  }
}

function cleanupExpiredRecords(env: Env, now: number): Promise<unknown> {
  return Promise.all([
    env.DB.prepare("DELETE FROM pair_rooms WHERE expires_at < ?").bind(now).run(),
    env.DB.prepare("DELETE FROM room_invites WHERE expires_at < ?").bind(now).run(),
    deleteExpiredPairAttempts(env, now - 60000)
  ]).catch(() => {});
}

async function deleteExpiredPairAttempts(env: Env, cutoff: number): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM pair_attempts WHERE timestamp < ?").bind(cutoff).run();
  } catch (error) {
    if (!isMissingPairAttemptsTable(error)) throw error;
  }
}

function isMissingPairAttemptsTable(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*pair_attempts/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default app;
