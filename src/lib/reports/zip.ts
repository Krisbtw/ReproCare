/**
 * Minimal ZIP reader for DOCX ingestion. Reads the central directory, then inflates one named entry with the
 * platform DecompressionStream ("deflate-raw"), which exists in modern browsers and Node 22. No dependency.
 *
 * Guards: entry count, declared and actual uncompressed size (zip-bomb limit), unsupported methods and
 * encrypted entries are refused rather than guessed.
 */

export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function listZip(bytes: Uint8Array): ZipEntry[] {
  // End of central directory: signature 0x06054b50, at most 65535 + 22 bytes from the end.
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= stop; i -= 1) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP container (no end-of-central-directory record).");
  const count = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (count > MAX_ENTRIES) throw new Error("ZIP container has too many entries.");
  const out: ZipEntry[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new Error("ZIP central directory is damaged.");
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const uncompressedSize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localHeaderOffset = u32(bytes, p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("ZIP entry inflates beyond the size limit; refused.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function readZipEntry(bytes: Uint8Array, name: string, limit = MAX_ENTRY_BYTES): Promise<Uint8Array | null> {
  const entry = listZip(bytes).find((e) => e.name === name);
  if (!entry) return null;
  if (entry.encrypted) throw new Error("Encrypted document entries are not read.");
  if (entry.uncompressedSize > limit) throw new Error("Document entry is larger than the size limit; refused.");
  const lh = entry.localHeaderOffset;
  if (u32(bytes, lh) !== 0x04034b50) throw new Error("ZIP local header is damaged.");
  const start = lh + 30 + u16(bytes, lh + 26) + u16(bytes, lh + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.slice();
  if (entry.method === 8) return inflateRaw(data, limit);
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}
