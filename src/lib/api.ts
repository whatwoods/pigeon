import type {
  DeviceRegistrationPayload,
  PairCreateResponse,
  RoomInviteResponse,
  RoomSessionResponse,
  TurnResponse
} from "../shared/protocol";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "请求失败" }));
    throw new Error(body.error ?? "请求失败");
  }

  return response.json() as Promise<T>;
}

export const api = {
  createRoom(device: DeviceRegistrationPayload) {
    return request<RoomSessionResponse>("/api/rooms", {
      method: "POST",
      body: JSON.stringify(device)
    });
  },
  joinRoom(inviteToken: string, device: DeviceRegistrationPayload) {
    return request<RoomSessionResponse>("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ inviteToken, ...device })
    });
  },
  createRoomInvite(roomId: string, roomToken: string) {
    return request<RoomInviteResponse>("/api/rooms/invites", {
      method: "POST",
      body: JSON.stringify({ roomId, roomToken })
    });
  },
  verifyRoom(roomId: string, roomToken: string, deviceId: string) {
    return request<{ valid: boolean }>("/api/rooms/verify", {
      method: "POST",
      body: JSON.stringify({ roomId, roomToken, deviceId })
    });
  },
  createPair() {
    return request<PairCreateResponse>("/api/pairs", {
      method: "POST",
      body: "{}"
    });
  },
  turn() {
    return request<TurnResponse>("/api/turn", {
      method: "GET",
      headers: {}
    });
  }
};
