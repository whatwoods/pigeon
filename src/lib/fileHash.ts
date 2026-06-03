import { sha256Blob } from "./sha256Incremental";

interface PendingHash {
  resolve: (hash: string) => void;
  reject: (error: Error) => void;
}

interface HashWorkerResponse {
  id: string;
  sha256?: string;
  error?: string;
}

let worker: Worker | null = null;
const pending = new Map<string, PendingHash>();

export async function hashFile(file: File): Promise<string> {
  if (!canHashInWorker()) return sha256Blob(file);

  try {
    return await hashFileInWorker(file);
  } catch {
    return sha256Blob(file);
  }
}

function hashFileInWorker(file: File): Promise<string> {
  const id = crypto.randomUUID();
  const hashWorker = ensureWorker();

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    hashWorker.postMessage({ id, file });
  });
}

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./fileHash.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<HashWorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;

    pending.delete(response.id);
    if (response.sha256) {
      request.resolve(response.sha256);
      return;
    }

    request.reject(new Error(response.error || "无法计算文件指纹"));
  });
  worker.addEventListener("error", () => rejectAllPending("文件指纹 Worker 失败"));
  worker.addEventListener("messageerror", () => rejectAllPending("文件指纹消息无法读取"));

  return worker;
}

function rejectAllPending(message: string): void {
  for (const request of pending.values()) {
    request.reject(new Error(message));
  }
  pending.clear();
  worker?.terminate();
  worker = null;
}

function canHashInWorker(): boolean {
  return typeof Worker !== "undefined" && typeof URL !== "undefined";
}
