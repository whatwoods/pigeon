import { sha256Blob } from "./sha256Incremental";

interface HashRequest {
  id: string;
  file: File;
}

type HashResponse =
  | {
      id: string;
      sha256: string;
    }
  | {
      id: string;
      error: string;
    };

const workerScope = globalThis as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<HashRequest>) => void): void;
  postMessage(message: HashResponse): void;
};

workerScope.addEventListener("message", (event) => {
  void hashAndReply(event.data);
});

async function hashAndReply(request: HashRequest): Promise<void> {
  try {
    workerScope.postMessage({
      id: request.id,
      sha256: await sha256Blob(request.file)
    });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "无法计算文件指纹"
    });
  }
}
