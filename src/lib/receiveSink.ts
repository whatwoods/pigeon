import type { PackageEntry, PackageManifest } from "../shared/protocol";

export interface ReceiveSink {
  startFile(entry: PackageEntry): Promise<void>;
  writeChunk(entry: PackageEntry, bytes: Uint8Array): Promise<void>;
  finishFile(entry: PackageEntry): Promise<void>;
  finishPackage(): Promise<void>;
}

export async function createReceiveSink(manifest: PackageManifest): Promise<{ sink: ReceiveSink; mode: "directory" | "download" }> {
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;

  if (picker) {
    try {
      const directory = await picker({ mode: "readwrite" });
      return { sink: new DirectoryReceiveSink(directory), mode: "directory" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
    }
  }

  // OOM block: check if multi-file package exceeds 500MB threshold in download fallback mode
  if (manifest.entries.length > 1 && manifest.totalBytes > 500 * 1024 * 1024) {
    throw new Error("由于您的浏览器不支持直接写入文件夹，且总大小超过 500MB，为防止内存崩溃，请使用 Chrome 等支持目录访问的桌面浏览器，或分开传输。");
  }

  return { sink: new DownloadReceiveSink(manifest), mode: "download" };
}

class DirectoryReceiveSink implements ReceiveSink {
  private writable?: FileSystemWritableFileStream;
  private currentPath?: string;

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async startFile(entry: PackageEntry): Promise<void> {
    if (this.writable && this.currentPath === entry.relativePath) return;
    await this.writable?.close();
    const fileHandle = await this.resolveFile(entry.relativePath);
    this.writable = await fileHandle.createWritable();
    this.currentPath = entry.relativePath;
  }

  async writeChunk(_entry: PackageEntry, bytes: Uint8Array): Promise<void> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await this.writable?.write(copy.buffer);
  }

  async finishFile(): Promise<void> {
    await this.writable?.close();
    this.writable = undefined;
    this.currentPath = undefined;
  }

  async finishPackage(): Promise<void> {
    await this.writable?.close();
    this.writable = undefined;
    this.currentPath = undefined;
  }

  private async resolveFile(path: string): Promise<FileSystemFileHandle> {
    const parts = path.split("/").filter(Boolean);
    const fileName = parts.pop() || "download";
    let directory = this.root;
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    return directory.getFileHandle(fileName, { create: true });
  }
}

class DownloadReceiveSink implements ReceiveSink {
  private fileDataMap = new Map<string, { entry: PackageEntry; data: Uint8Array }>();
  private chunks: Uint8Array[] = [];
  private current?: PackageEntry;

  constructor(private readonly manifest: PackageManifest) {}

  async startFile(entry: PackageEntry): Promise<void> {
    if (this.current?.id === entry.id) return;
    this.current = entry;
    this.chunks = [];
  }

  async writeChunk(_entry: PackageEntry, bytes: Uint8Array): Promise<void> {
    this.chunks.push(bytes);
  }

  async finishFile(entry: PackageEntry): Promise<void> {
    const totalLength = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const fileBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      fileBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    this.fileDataMap.set(entry.id, { entry, data: fileBytes });
    this.current = undefined;
    this.chunks = [];
  }

  async finishPackage(): Promise<void> {
    if (this.manifest.entries.length === 1) {
      const item = this.fileDataMap.values().next().value;
      if (item) {
        triggerDownload(
          new Blob([toArrayBuffer(item.data)], { type: item.entry.mime || "application/octet-stream" }),
          item.entry.name
        );
      }
      this.fileDataMap.clear();
    } else if (this.fileDataMap.size > 0) {
      const { zip } = await import("fflate");
      const zipObject: Record<string, Uint8Array> = {};
      for (const [_, item] of this.fileDataMap) {
        zipObject[item.entry.relativePath] = item.data;
      }

      await new Promise<void>((resolve, reject) => {
        zip(zipObject, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          triggerDownload(new Blob([toArrayBuffer(data)], { type: "application/zip" }), `${this.manifest.name}.zip`);
          resolve();
        });
      });

      this.fileDataMap.clear();
    }

    document.dispatchEvent(
      new CustomEvent("pigeon:download-complete", {
        detail: { packageId: this.manifest.packageId }
      })
    );
  }
}

function triggerDownload(blob: Blob, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 10_000);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
