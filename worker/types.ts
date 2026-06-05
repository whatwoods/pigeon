export interface Env {
  DB: D1Database;
  PAIR_ROOM: DurableObjectNamespace;
  DEVICE_ROOM: DurableObjectNamespace;
  ASSETS?: Fetcher;
  APP_ORIGIN?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
}
