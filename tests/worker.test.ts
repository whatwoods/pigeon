// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/types";
import type { RoomSessionResponse } from "../src/shared/protocol";

vi.mock("../worker/durable", () => ({ DeviceRoom: class {}, PairRoom: class {} }));
import app from "../worker/index";

let sqlite: DatabaseSync;
let env: Env;
let work: Promise<unknown>[];
const registration = { deviceId: "original-device", deviceName: "Original", publicKey: { kty: "EC", crv: "P-256", x: "fixture", y: "fixture" } };

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  for (const name of ["0003_rooms.sql", "0005_turn_rate_limits.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const prepare = (sql: string) => {
    let bindings: SQLInputValue[] = [];
    return {
      bind(...args: SQLInputValue[]) { bindings = args; return this; },
      async first() { return sqlite.prepare(sql).get(...bindings) ?? null; },
      async run() { const result = sqlite.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...bindings) }; }
    };
  };
  env = { DB: { prepare, batch: (statements: ReturnType<typeof prepare>[]) => Promise.all(statements.map((statement) => statement.all())) } } as unknown as Env;
  work = [];
});
afterEach(async () => { await Promise.all(work); sqlite.close(); vi.unstubAllGlobals(); });

async function request(path: string, body?: object, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`https://pigeon.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined
  }), env, { waitUntil: (promise: Promise<unknown>) => work.push(promise) } as ExecutionContext);
}
async function create(device = registration): Promise<RoomSessionResponse> {
  const response = await request("/api/rooms", device);
  expect(response.status).toBe(200);
  return response.json();
}
function auth(session: RoomSessionResponse, ip = "192.0.2.1") {
  return { Authorization: `Bearer ${session.roomToken}`, "X-Room-Id": session.roomId, "X-Device-Id": session.deviceId, "CF-Connecting-IP": ip };
}

describe("device ownership", () => {
  it("refuses anonymous or invalid-token replacement without changing the existing device", async () => {
    const original = await create();
    for (const previousRoomToken of [undefined, "wrong-token"]) {
      const attack = await request("/api/rooms", { ...registration, deviceName: "Attacker", previousRoomToken });
      expect(attack.status).toBe(409);
    }
    expect(await (await request("/api/rooms/verify", original)).json()).toEqual({ valid: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM rooms").get()?.count).toBe(1);
  });

  it("requires the old credential even when joining with a valid invitation", async () => {
    const original = await create();
    const host = await create({ ...registration, deviceId: "host-device" });
    const invite = await (await request("/api/rooms/invites", host)).json() as { inviteToken: string };
    expect((await request("/api/rooms/join", { ...registration, ...invite })).status).toBe(409);
    const joined = await request("/api/rooms/join", { ...registration, ...invite, previousRoomToken: original.roomToken });
    expect(joined.status).toBe(200);
    const next = await joined.json() as RoomSessionResponse;
    expect(next.roomId).toBe(host.roomId);
    expect(await (await request("/api/rooms/verify", next)).json()).toEqual({ valid: true });
    expect(await (await request("/api/rooms/verify", original)).json()).toEqual({ valid: false });
  });

  it("lets the owner create a fresh room and rotates its credential", async () => {
    const original = await create();
    const response = await request("/api/rooms", { ...registration, previousRoomToken: original.roomToken });
    expect(response.status).toBe(200);
    const next = await response.json() as RoomSessionResponse;
    expect(next.roomId).not.toBe(original.roomId);
    expect(next.roomToken).not.toBe(original.roomToken);
    expect(await (await request("/api/rooms/verify", next)).json()).toEqual({ valid: true });
  });
});

describe("TURN credentials", () => {
  it("rejects anonymous and mismatched device credentials before contacting TURN", async () => {
    const mint = vi.fn();
    vi.stubGlobal("fetch", mint);
    const session = await create();
    expect((await request("/api/turn")).status).toBe(401);
    expect((await request("/api/turn", undefined, { ...auth(session), "X-Device-Id": "different" })).status).toBe(401);
    expect(mint).not.toHaveBeenCalled();
  });

  it("issues expiring coturn credentials without returning the shared secret", async () => {
    const session = await create();
    env.TURN_URLS = "turn:relay.test:3478";
    env.TURN_SHARED_SECRET = "fixture-secret";
    const response = await request("/api/turn", undefined, auth(session));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain(env.TURN_SHARED_SECRET);
    const server = JSON.parse(text).iceServers[1];
    const expires = Number(server.username.split(":")[0]);
    expect(expires).toBeGreaterThan(Date.now() / 1000);
    expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
    expect(server.credential).toBe(createHmac("sha1", env.TURN_SHARED_SECRET).update(server.username).digest("base64"));
  });

  it("does not publish legacy permanent credentials", async () => {
    const session = await create();
    env.TURN_URLS = "turn:relay.test:3478";
    env.TURN_USERNAME = "permanent-user";
    env.TURN_CREDENTIAL = "permanent-password";
    const response = await request("/api/turn", undefined, auth(session));
    const text = await response.text();
    expect(text).not.toContain("permanent");
    expect(JSON.parse(text).relayAvailable).toBe(false);
  });

  it("limits requests per device and resets the counter in a new minute", async () => {
    const session = await create();
    const clock = vi.spyOn(Date, "now").mockReturnValue(180000);
    try {
      const responses = await Promise.all(Array.from({ length: 14 }, () => request("/api/turn", undefined, auth(session))));
      expect(responses.filter((r) => r.status === 200)).toHaveLength(12);
      expect(responses.filter((r) => r.status === 429)).toHaveLength(2);
      expect(responses.find((r) => r.status === 429)?.headers.get("Retry-After")).toBe("60");
      clock.mockReturnValue(240000);
      expect((await request("/api/turn", undefined, auth(session))).status).toBe(200);
    } finally { clock.mockRestore(); }
  });

  it("limits one IP even when it creates additional devices", async () => {
    for (let device = 0; device < 5; device++) {
      const session = await create({ ...registration, deviceId: `device-${device}` });
      for (let count = 0; count < 12; count++) expect((await request("/api/turn", undefined, auth(session))).status).toBe(200);
    }
    const extra = await create({ ...registration, deviceId: "extra-device" });
    expect((await request("/api/turn", undefined, auth(extra))).status).toBe(429);
    expect((await request("/api/turn", undefined, auth(extra, "192.0.2.2"))).status).toBe(200);
  });

  it("caps Cloudflare credential lifetime and only calls the provider for authenticated requests", async () => {
    const session = await create();
    env.TURN_KEY_ID = "fixture-key-id";
    env.TURN_KEY_API_TOKEN = "fixture-api-token";
    env.TURN_TTL_SECONDS = "86400";
    const mint = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ iceServers: [{ urls: "turn:relay.test:3478", username: "temporary", credential: "temporary" }] }));
    vi.stubGlobal("fetch", mint);
    expect((await request("/api/turn", undefined, auth(session))).status).toBe(200);
    expect(mint).toHaveBeenCalledOnce();
    expect(JSON.parse(mint.mock.calls[0][1]!.body as string)).toEqual({ ttl: 3600 });
  });
});
