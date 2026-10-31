/**
 * The loader tests in series-loader.test.ts use a tiny stand-in parser. These run the same chain through the real
 * dicom-parser library, which is what the browser uses, including dicom-parser reading explicit-VR files in any order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import dicomParser from "dicom-parser";
import type { DataSetLike } from "./codec.ts";
import { buildSyntheticSeries } from "./series-writer.ts";
import { loadSeries } from "./series-loader.ts";
import { segmentFromSeed } from "../imaging/segment.ts";
import { meshFromMask } from "../imaging/lab.ts";
import { measureMask } from "../imaging/metrics.ts";

const parse = (b: Uint8Array) => dicomParser.parseDicom(b) as unknown as DataSetLike;
const SPEC = { cols: 40, rows: 36, slices: 16, pixelSpacingMm: [0.8, 0.8] as [number, number], sliceStepMm: 4, lesionRadiiMm: [10, 8, 16] as [number, number, number] };

test("real dicom-parser: shuffled 16-bit series becomes a calibrated, correctly spaced volume", () => {
  const files = buildSyntheticSeries(SPEC).reverse();
  const r = loadSeries(files, parse);
  assert.equal(r.report.volumeReady, true, JSON.stringify(r.report.issues));
  assert.ok(r.volume);
  assert.deepEqual(r.volume.dims, [40, 36, 16]);
  assert.deepEqual(r.volume.spacingMm, [0.8, 0.8, 4]);
  assert.equal(r.calibrated, true);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.modality, "MR");
  const mid = r.volume.data[20 + 40 * (18 + 36 * 8)];
  assert.equal(mid, 400);
  assert.equal(r.volume.data[0], 100);
});

test("real dicom-parser: a missing slice is reported and no volume is stacked", () => {
  const r = loadSeries(buildSyntheticSeries({ ...SPEC, dropSlices: [7] }), parse);
  assert.equal(r.volume, null);
  assert.ok(r.report.issues.some((i) => i.code === "missing_slices"));
});

test("real dicom-parser: non-DICOM files are skipped with a reason and the rest still load", () => {
  const files = buildSyntheticSeries(SPEC);
  files.push({ name: "notes.txt", bytes: new TextEncoder().encode("this is not a DICOM file ".repeat(20)) });
  files.push({ name: "empty.dcm", bytes: new Uint8Array(0) });
  const r = loadSeries(files, parse);
  assert.equal(r.skipped.length, 2);
  assert.equal(r.report.volumeReady, true);
  assert.ok(r.warnings.some((w) => /not used/.test(w)));
});

test("real dicom-parser: patient name and ID never reach the result", () => {
  const r = loadSeries(buildSyntheticSeries(SPEC), parse);
  const text = JSON.stringify({ ...r, volume: null });
  assert.equal(text.includes("SYNTHETIC^SERIES"), false);
  assert.equal(text.includes("SERIES-ONLY"), false);
});

test("real dicom-parser: load → segment → mesh → measure recovers the known lesion", () => {
  const r = loadSeries(buildSyntheticSeries(SPEC), parse);
  const vol = r.volume!;
  const seg = segmentFromSeed(vol, { seed: [20, 18, 8], closeIterations: 0 });
  assert.equal(seg.accepted, true);
  assert.equal(seg.isLearnedModel, false);
  const m = measureMask(seg.mask);
  assert.equal(m.componentCount, 1);
  const analyticMl = ((4 / 3) * Math.PI * 10 * 8 * 16) / 1000;
  assert.ok(Math.abs(m.volumeMl - analyticMl) / analyticMl < 0.2, `volume ${m.volumeMl} vs ${analyticMl}`);
  const mesh = meshFromMask(seg.mask, { blurIterations: 1 })!;
  assert.equal(mesh.quality.watertight, true);
  assert.equal(mesh.quality.componentCount, 1);
});
