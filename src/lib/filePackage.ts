import {
  MAX_FILE_BYTES,
  PACKAGE_WARNING_BYTES,
  PACKAGE_WARNING_ENTRIES,
  type PackageEntry,
  type PackageManifest
} from "../shared/protocol";
import { hashFile } from "./fileHash";

export interface LocalPackage {
  manifest: PackageManifest;
  files: Map<string, File>;
  warnings: string[];
}

export async function createLocalPackage(fileList: FileList | File[], senderDeviceId: string): Promise<LocalPackage> {
  const files = Array.from(fileList);
  if (files.length === 0) {
    throw new Error("请选择文件");
  }

  const tooLarge = files.find((file) => file.size > MAX_FILE_BYTES);
  if (tooLarge) {
    throw new Error(`${tooLarge.name} 超过 512 MB，暂不能投递`);
  }

  const entries: PackageEntry[] = [];
  const fileMap = new Map<string, File>();

  for (const file of files) {
    const id = crypto.randomUUID();
    const relativePath = normalizeRelativePath(getRelativePath(file));
    const entry: PackageEntry = {
      id,
      name: file.name,
      relativePath,
      size: file.size,
      mime: file.type || "application/octet-stream",
      sha256: await hashFile(file),
      lastModified: file.lastModified
    };
    entries.push(entry);
    fileMap.set(id, file);
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const rootName = inferPackageName(entries);
  const warnings: string[] = [];
  if (totalBytes > PACKAGE_WARNING_BYTES) {
    warnings.push("投递包超过 2 GB，建议保持两个设备在前台并接入稳定网络");
  }
  if (entries.length > PACKAGE_WARNING_ENTRIES) {
    warnings.push("投递包项目很多，接收端写入可能需要更长时间");
  }

  return {
    manifest: {
      packageId: crypto.randomUUID(),
      name: rootName,
      entries,
      totalBytes,
      createdAt: Date.now(),
      senderDeviceId
    },
    files: fileMap,
    warnings
  };
}

export function normalizeRelativePath(value: string): string {
  return value
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function getRelativePath(file: File): string {
  const withDirectory = file as File & { webkitRelativePath?: string };
  return withDirectory.webkitRelativePath || file.name;
}

function inferPackageName(entries: PackageEntry[]): string {
  if (entries.length === 1) return entries[0].name;
  const roots = new Set(entries.map((entry) => entry.relativePath.split("/")[0]).filter(Boolean));
  if (roots.size === 1) return [...roots][0];
  return `${entries.length} 个项目`;
}
