import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../shared/protocol";
import { createLocalPackage, normalizeRelativePath } from "./filePackage";
import { Sha256Incremental } from "./sha256Incremental";

describe("file package", () => {
  it("keeps safe relative paths and hashes files", async () => {
    const file = createTestFile("hello", "note.txt", "text/plain");
    const local = await createLocalPackage([file], "device-1");

    expect(local.manifest.entries).toHaveLength(1);
    expect(local.manifest.entries[0].relativePath).toBe("note.txt");
    expect(local.manifest.entries[0].sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(local.manifest.totalBytes).toBe(5);
  });

  it("hashes incrementally across chunk boundaries", () => {
    const bytes = new TextEncoder().encode("hello");
    const hash = new Sha256Incremental().update(bytes.subarray(0, 2)).update(bytes.subarray(2)).digestHex();

    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("rejects files over the first-version limit", async () => {
    const file = createTestFile("x", "large.bin");
    Object.defineProperty(file, "size", { value: MAX_FILE_BYTES + 1 });

    await expect(createLocalPackage([file], "device-1")).rejects.toThrow("超过 512 MB");
  });

  it("normalizes dangerous directory segments", () => {
    expect(normalizeRelativePath("../a/./b.txt")).toBe("a/b.txt");
  });
});

function createTestFile(content: string, name: string, type = "application/octet-stream"): File {
  const bytes = new TextEncoder().encode(content);
  const file = new File([content], name, { type, lastModified: 1 });
  Object.defineProperty(file, "arrayBuffer", {
    value: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  });
  return file;
}
