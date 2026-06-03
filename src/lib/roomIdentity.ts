import type { DeviceIdentity } from "./deviceIdentity";

const ROOM_SESSION_KEY = "pigeon.roomSession.v1";

export interface StoredRoomSession {
  roomId: string;
  roomToken: string;
  deviceId: string;
}

export function loadRoomSession(identity: DeviceIdentity): StoredRoomSession | null {
  const stored = localStorage.getItem(ROOM_SESSION_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as Partial<StoredRoomSession>;
    if (
      parsed.roomId &&
      parsed.roomToken &&
      parsed.deviceId === identity.deviceId
    ) {
      return {
        roomId: parsed.roomId,
        roomToken: parsed.roomToken,
        deviceId: parsed.deviceId
      };
    }
  } catch {
    localStorage.removeItem(ROOM_SESSION_KEY);
  }

  return null;
}

export function saveRoomSession(session: StoredRoomSession): void {
  localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session));
}

export function clearRoomSession(): void {
  localStorage.removeItem(ROOM_SESSION_KEY);
}
