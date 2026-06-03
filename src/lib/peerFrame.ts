import { decryptBytes, encryptBytes } from "./crypto";

const MAGIC = 0x70;
const VERSION = 1;
const TYPE_CHUNK = 1;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export interface ChunkHeader {
  entryId: string;
  index: number;
  iv: string;
  plainBytes: number;
}

export async function packChunk(
  key: CryptoKey,
  entryId: string,
  index: number,
  bytes: Uint8Array
): Promise<ArrayBuffer> {
  const encrypted = await encryptBytes(bytes, key);
  const header: ChunkHeader = {
    entryId,
    index,
    iv: btoa(String.fromCharCode(...encrypted.iv)),
    plainBytes: bytes.byteLength
  };
  const headerBytes = ENCODER.encode(JSON.stringify(header));
  const frame = new Uint8Array(7 + headerBytes.byteLength + encrypted.ciphertext.byteLength);
  frame[0] = MAGIC;
  frame[1] = VERSION;
  frame[2] = TYPE_CHUNK;
  new DataView(frame.buffer).setUint32(3, headerBytes.byteLength, false);
  frame.set(headerBytes, 7);
  frame.set(encrypted.ciphertext, 7 + headerBytes.byteLength);
  return frame.buffer;
}

export async function unpackChunk(key: CryptoKey, frame: ArrayBuffer): Promise<{ header: ChunkHeader; bytes: Uint8Array }> {
  const view = new DataView(frame);
  if (view.getUint8(0) !== MAGIC || view.getUint8(1) !== VERSION || view.getUint8(2) !== TYPE_CHUNK) {
    throw new Error("无法识别的传输分片");
  }
  const headerLength = view.getUint32(3, false);
  const bytes = new Uint8Array(frame);
  const header = JSON.parse(DECODER.decode(bytes.slice(7, 7 + headerLength))) as ChunkHeader;
  const iv = Uint8Array.from(atob(header.iv), (char) => char.charCodeAt(0));
  const ciphertext = bytes.slice(7 + headerLength);
  return {
    header,
    bytes: await decryptBytes(iv, ciphertext, key)
  };
}
