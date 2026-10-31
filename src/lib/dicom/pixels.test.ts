import assert from "node:assert/strict";
import test from "node:test";
import { decodePixels } from "./pixels.ts";

test("16-bit little-endian unsigned with rescale decodes to real intensities", () => {
  const b = new Uint8Array([0x00, 0x01, 0xff, 0xff, 0x10, 0x00, 0x00, 0x00]);
  const r = decodePixels(b, { rows: 2, cols: 2, bitsAllocated: 16, pixelRepresentation: 0, littleEndian: true, slope: 2, intercept: -10 });
  assert.deepEqual(Array.from(r.pixels), [256 * 2 - 10, 65535 * 2 - 10, 16 * 2 - 10, -10]);
  assert.equal(r.warnings.length, 0);
});

test("signed 16-bit and big-endian are honoured; missing rescale is warned about, not assumed silently", () => {
  const le = decodePixels(new Uint8Array([0xff, 0xff, 0x01, 0x00]), { rows: 1, cols: 2, bitsAllocated: 16, pixelRepresentation: 1, littleEndian: true });
  assert.deepEqual(Array.from(le.pixels), [-1, 1]);
  assert.ok(le.warnings.some((w) => w.includes("rescale")));
  const be = decodePixels(new Uint8Array([0x01, 0x00, 0x00, 0x02]), { rows: 1, cols: 2, bitsAllocated: 16, pixelRepresentation: 0, littleEndian: false, slope: 1, intercept: 0 });
  assert.deepEqual(Array.from(be.pixels), [256, 2]);
});

test("short buffers, colour images and odd bit depths are refused", () => {
  assert.throws(() => decodePixels(new Uint8Array(3), { rows: 2, cols: 2, bitsAllocated: 16, pixelRepresentation: 0, littleEndian: true }), /needed/);
  assert.throws(() => decodePixels(new Uint8Array(12), { rows: 2, cols: 2, bitsAllocated: 8, pixelRepresentation: 0, littleEndian: true, samplesPerPixel: 3 }), /grayscale/);
  assert.throws(() => decodePixels(new Uint8Array(12), { rows: 2, cols: 2, bitsAllocated: 12 as unknown as 16, pixelRepresentation: 0, littleEndian: true }), /8- and 16-bit/);
});
