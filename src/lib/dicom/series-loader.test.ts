import assert from "node:assert/strict";
import test from "node:test";
import type { DataSetLike } from "./codec.ts";
import { buildSyntheticSeries } from "./series-writer.ts";
import { loadSeries } from "./series-loader.ts";
import { segmentFromSeed } from "../imaging/segment.ts";
import { surfaceFromMask } from "../imaging/isosurface.ts";
import { meshQuality } from "../imaging/mesh.ts";
import { dice, measureMask } from "../imaging/metrics.ts";
import { ellipsoidMask } from "../imaging/volume.ts";

const LONG = new Set(["OB", "OW", "OF", "SQ", "UT", "UN", "UC", "UR", "OD", "OL", "OV"]);
const BINARY = new Set(["US", "UL", "OB", "OW", "SQ", "UN", "SS", "SL", "FL", "FD"]);

/** Minimal explicit-VR little-endian reader, only for these tests. dicom-parser is used in the app. */
function miniParse(bytes: Uint8Array): DataSetLike {
  if (bytes.length < 140 || String.fromCharCode(...bytes.subarray(128, 132)) !== "DICM") throw new Error("Not a DICOM Part 10 file.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const elements: Record<string, { dataOffset: number; length: number; vr?: string }> = {};
  let o = 132;
  while (o + 8 <= bytes.length) {
    const g = dv.getUint16(o, true);
    const e = dv.getUint16(o + 2, true);
    const vr = String.fromCharCode(bytes[o + 4], bytes[o + 5]);
    let len: number;
    let head: number;
    if (LONG.has(vr)) {
      len = dv.getUint32(o + 8, true);
      head = 12;
    } else {
      len = dv.getUint16(o + 6, true);
      head = 8;
    }
    const tag = `x${g.toString(16).padStart(4, "0")}${e.toString(16).padStart(4, "0")}`;
    elements[tag] = { dataOffset: o + head, length: len, vr };
    o += head + len;
  }
  return {
    elements,
    byteArray: bytes,
    string: (tag) => {
      const el = elements[tag];
      if (!el || (el.vr && BINARY.has(el.vr))) return undefined;
      return new TextDecoder().decode(bytes.subarray(el.dataOffset, el.dataOffset + el.length)).replace(/[\0 ]+$/, "");
    },
    uint16: (tag) => {
      const el = elements[tag];
      return el ? dv.getUint16(el.dataOffset, true) : undefined;
    },
  };
}

const SPEC = { cols: 24, rows: 24, slices: 14, pixelSpacingMm: [1, 1] as [number, number], sliceStepMm: 4, lesionRadiiMm: [8, 8, 12] as [number, number, number] };

test("synthetic 16-bit series → validated volume with rescale applied, in spatial order even if files are shuffled", () => {
  const files = buildSyntheticSeries(SPEC);
  const shuffled = [...files].reverse();
  const r = loadSeries(shuffled, miniParse);
  assert.equal(r.report.volumeReady, true, JSON.stringify(r.report.issues));
  assert.ok(r.volume);
  assert.deepEqual(r.volume.dims, [24, 24, 14]);
  assert.deepEqual(r.volume.spacingMm, [1, 1, 4]);
  assert.equal(r.calibrated, true);
  assert.equal(r.skipped.length, 0);
  const centre = r.volume.data[11 + 24 * (11 + 24 * 6)];
  const corner = r.volume.data[0];
  assert.equal(centre, 400);
  assert.equal(corner, 100);
});

test("full chain on the synthetic series: load → segment → mesh → measure agrees with the known lesion", () => {
  const r = loadSeries(buildSyntheticSeries(SPEC), miniParse);
  const vol = r.volume!;
  const res = segmentFromSeed(vol, { seed: [11, 11, 6], closeIterations: 0 });
  assert.equal(res.accepted, true);
  // Same lesion drawn directly on the same grid is the reference.
  const truth = ellipsoidMask(vol.dims, vol.spacingMm, [8, 8, 12], [11.5, 11.5, 26]);
  const d = dice(truth, res.mask) as number;
  assert.ok(d > 0.98, `dice ${d}`);
  const q = meshQuality(surfaceFromMask(res.mask, 1));
  assert.equal(q.watertight, true);
  const m = measureMask(res.mask);
  assert.equal(m.componentCount, 1);
  const analyticMl = ((4 / 3) * Math.PI * 8 * 8 * 12) / 1000;
  assert.ok(Math.abs(m.volumeMl - analyticMl) / analyticMl < 0.2, `volume ${m.volumeMl} vs ${analyticMl}`);
});

test("a dropped slice is detected and no volume is built", () => {
  const r = loadSeries(buildSyntheticSeries({ ...SPEC, dropSlices: [5] }), miniParse);
  assert.equal(r.volume, null);
  assert.ok(r.report.issues.some((i) => i.code === "missing_slices"));
});

test("unreadable files are skipped with a reason; the rest still load", () => {
  const files = buildSyntheticSeries(SPEC);
  files.push({ name: "notes.txt", bytes: new TextEncoder().encode("not dicom at all, just some text padded out to length ".repeat(4)) });
  const r = loadSeries(files, miniParse);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].name, "notes.txt");
  assert.equal(r.report.volumeReady, true);
});

test("patient name and ID from the headers never appear in the result", () => {
  const r = loadSeries(buildSyntheticSeries(SPEC), miniParse);
  const text = JSON.stringify({ ...r, volume: null });
  assert.equal(text.includes("SYNTHETIC^SERIES"), false);
  assert.equal(text.includes("SERIES-ONLY"), false);
});
