import assert from "node:assert/strict";
import test from "node:test";
import {
  autoWindow,
  buildProcessingRecord,
  cropToBoundingBox,
  extractMaskSlice,
  extractSlice,
  histogram,
  maskCountsAlong,
  meshFromMask,
  pixelToVoxel,
  planeSize,
  renderSlice,
  voxelToPixel,
  voxelValue,
  type Axis,
} from "./lab.ts";
import { surfaceFromMask } from "./isosurface.ts";
import { meshQuality } from "./mesh.ts";
import { measureMask } from "./metrics.ts";
import { segmentFromSeed } from "./segment.ts";
import { ellipsoidMask, vIndex, type Mask, type Vec3, type Volume } from "./volume.ts";

/** Volume whose value encodes its own coordinates, so any plane mix-up is visible. */
function codedVolume(dims: Vec3 = [5, 7, 9], spacingMm: Vec3 = [0.5, 0.8, 3]): Volume {
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z += 1) for (let y = 0; y < dims[1]; y += 1) for (let x = 0; x < dims[0]; x += 1) data[vIndex(dims, x, y, z)] = x + 100 * y + 10000 * z;
  return { dims, spacingMm, data };
}

test("planes: size, mm per pixel and pixel↔voxel mapping agree on every axis", () => {
  const vol = codedVolume();
  const expectSize: Record<Axis, [number, number]> = { 0: [7, 9], 1: [5, 9], 2: [5, 7] };
  const expectMm: Record<Axis, [number, number]> = { 0: [0.8, 3], 1: [0.5, 3], 2: [0.5, 0.8] };
  for (const axis of [0, 1, 2] as Axis[]) {
    assert.deepEqual(planeSize(vol.dims, axis), expectSize[axis]);
    const index = 2;
    const s = extractSlice(vol, axis, index);
    assert.equal(s.width, expectSize[axis][0]);
    assert.equal(s.height, expectSize[axis][1]);
    assert.deepEqual(s.mmPerPx, expectMm[axis]);
    for (let row = 0; row < s.height; row += 1) {
      for (let col = 0; col < s.width; col += 1) {
        const v = pixelToVoxel(vol.dims, axis, index, col, row);
        assert.equal(s.data[row * s.width + col], voxelValue(vol, v), `axis ${axis} px ${col},${row}`);
        assert.equal(v[axis], index);
        const back = voxelToPixel(vol.dims, axis, v);
        assert.deepEqual([back.col, back.row], [col, row]);
      }
    }
  }
});

test("reformat planes put higher slice index higher on screen", () => {
  const vol = codedVolume();
  const s = extractSlice(vol, 1, 3);
  assert.equal(s.data[0], voxelValue(vol, [0, 3, 8]), "top row is the last slice");
  assert.equal(s.data[(s.height - 1) * s.width], voxelValue(vol, [0, 3, 0]), "bottom row is slice 0");
});

test("out-of-range slice requests clamp instead of reading outside the volume", () => {
  const vol = codedVolume();
  assert.equal(extractSlice(vol, 2, 99).index, 8);
  assert.equal(extractSlice(vol, 2, -4).index, 0);
  assert.equal(voxelValue(vol, [5, 0, 0]), null);
  assert.equal(voxelValue(vol, [0, -1, 0]), null);
});

test("mask slices follow the same plane mapping as image slices", () => {
  const vol = codedVolume();
  const mask: Mask = { dims: vol.dims, spacingMm: vol.spacingMm, data: new Uint8Array(vol.data.length) };
  mask.data[vIndex(vol.dims, 2, 4, 6)] = 1;
  for (const axis of [0, 1, 2] as Axis[]) {
    const m = extractMaskSlice(mask, axis, [2, 4, 6][axis]);
    const px = voxelToPixel(vol.dims, axis, [2, 4, 6]);
    const w = planeSize(vol.dims, axis)[0];
    assert.equal(m[px.row * w + px.col], 1);
    assert.equal(m.reduce((a, b) => a + b, 0), 1);
  }
});

test("autoWindow ignores a few extreme outliers; renderSlice maps window ends to black and white", () => {
  const dims: Vec3 = [20, 20, 5];
  const data = new Float32Array(20 * 20 * 5);
  for (let i = 0; i < data.length; i += 1) data[i] = 100 + (i % 100);
  data[0] = 60000;
  const vol: Volume = { dims, spacingMm: [1, 1, 1], data };
  const w = autoWindow(vol, 1, 99);
  assert.ok(w.center + w.width / 2 < 400, `window top ${w.center + w.width / 2}`);
  assert.equal(w.max, 60000);
  const slice = { axis: 2 as Axis, index: 0, width: 3, height: 1, data: new Float32Array([0, 50, 100]), mmPerPx: [1, 1] as [number, number] };
  const rgba = renderSlice(slice, { center: 50, width: 100 });
  assert.equal(rgba[0], 0);
  assert.ok(rgba[4] === 127 || rgba[4] === 128, `mid-gray ${rgba[4]}`);
  assert.equal(rgba[8], 255);
  assert.deepEqual([rgba[3], rgba[7], rgba[11]], [255, 255, 255]);
});

test("renderSlice tints only masked pixels", () => {
  const slice = { axis: 2 as Axis, index: 0, width: 2, height: 1, data: new Float32Array([100, 100]), mmPerPx: [1, 1] as [number, number] };
  const rgba = renderSlice(slice, { center: 100, width: 200 }, new Uint8Array([1, 0]), { r: 255, g: 0, b: 0, alpha: 0.5 });
  assert.ok(rgba[0] > rgba[4], "masked pixel is redder");
  assert.equal(rgba[4], rgba[5]);
  assert.equal(rgba[5], rgba[6]);
});

test("histogram bins sum to the sample and bracket the data", () => {
  const vol = codedVolume([10, 10, 10], [1, 1, 1]);
  const h = histogram(vol, 32);
  assert.equal(h.counts.length, 32);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 1000);
  assert.ok(h.hi > h.lo);
});

test("cropToBoundingBox keeps every voxel, reports its origin, and returns null for an empty mask", () => {
  const dims: Vec3 = [30, 30, 12];
  const full = ellipsoidMask(dims, [1, 1, 2], [5, 4, 6], [14, 12, 10]);
  const total = full.data.reduce((a, b) => a + b, 0);
  const c = cropToBoundingBox(full, 2)!;
  assert.equal(c.mask.data.reduce((a, b) => a + b, 0), total);
  assert.ok(c.mask.dims[0] < 30 && c.mask.dims[1] < 30);
  assert.equal(c.mask.data[vIndex(c.mask.dims, 14 - c.originVoxels[0], 12 - c.originVoxels[1], 5 - c.originVoxels[2])], 1);
  assert.equal(cropToBoundingBox({ dims, spacingMm: [1, 1, 2], data: new Uint8Array(30 * 30 * 12) }, 2), null);
});

function sortedVertices(positions: Float32Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1], positions[i + 2]].map((v) => v.toFixed(3)).join(","));
  return out.sort();
}

test("cropped meshing equals meshing the whole grid (interior lesion)", () => {
  const mask = ellipsoidMask([40, 36, 14], [0.8, 0.8, 3], [9, 7, 12], [16, 14, 21]);
  const whole = surfaceFromMask(mask, 1);
  const cropped = meshFromMask(mask, { blurIterations: 1 })!;
  assert.equal(cropped.mesh.indices.length, whole.indices.length);
  assert.deepEqual(sortedVertices(cropped.mesh.positions), sortedVertices(whole.positions));
  assert.equal(cropped.quality.watertight, true);
  const wholeMl = meshQuality(whole).enclosedVolumeMl!;
  // Shifting coordinates in float32 changes the signed volume by rounding noise only.
  assert.ok(Math.abs(cropped.quality.enclosedVolumeMl! - wholeMl) / wholeMl < 1e-5);
});

test("cropped meshing equals meshing the whole grid when the lesion touches the grid edge", () => {
  const mask = ellipsoidMask([24, 24, 10], [1, 1, 2], [9, 9, 8], [4, 12, 0]);
  const whole = surfaceFromMask(mask, 1);
  const cropped = meshFromMask(mask, { blurIterations: 1 })!;
  assert.equal(cropped.mesh.indices.length, whole.indices.length);
  assert.deepEqual(sortedVertices(cropped.mesh.positions), sortedVertices(whole.positions));
});

test("meshFromMask returns null for an empty mask and applies optional smoothing", () => {
  const empty: Mask = { dims: [8, 8, 8], spacingMm: [1, 1, 1], data: new Uint8Array(512) };
  assert.equal(meshFromMask(empty), null);
  const mask = ellipsoidMask([40, 36, 14], [0.8, 0.8, 3], [9, 7, 12], [16, 14, 21]);
  const raw = meshFromMask(mask, { taubinIterations: 0 })!;
  const smooth = meshFromMask(mask, { taubinIterations: 10 })!;
  assert.equal(smooth.taubinIterations, 10);
  assert.equal(smooth.quality.watertight, true);
  assert.notDeepEqual(Array.from(smooth.mesh.positions.slice(0, 30)), Array.from(raw.mesh.positions.slice(0, 30)));
  assert.ok(Math.abs(smooth.quality.enclosedVolumeMl! - raw.quality.enclosedVolumeMl!) / raw.quality.enclosedVolumeMl! < 0.06);
});

test("maskCountsAlong sums to the voxel count on each axis", () => {
  const mask = ellipsoidMask([20, 18, 10], [1, 1, 2], [6, 5, 8], [9, 8, 9]);
  const total = mask.data.reduce((a, b) => a + b, 0);
  for (const axis of [0, 1, 2] as Axis[]) assert.equal(maskCountsAlong(mask, axis).reduce((a, b) => a + b, 0), total);
});

test("processing record carries provenance but no file names or identifiers", () => {
  const dims: Vec3 = [30, 30, 12];
  const vol: Volume = { dims, spacingMm: [1, 1, 2], data: new Float32Array(30 * 30 * 12).fill(100) };
  const truth = ellipsoidMask(dims, [1, 1, 2], [6, 6, 8], [14.5, 14.5, 11]);
  for (let i = 0; i < vol.data.length; i += 1) if (truth.data[i]) vol.data[i] = 400;
  const result = segmentFromSeed(vol, { seed: [14, 14, 5], closeIterations: 0 });
  const record = buildProcessingRecord({
    now: new Date("2026-10-31T12:00:00Z"),
    modality: "MR",
    seriesDescription: "Synthetic",
    calibrated: true,
    report: {
      orderedIds: ["JANE_DOE_001.dcm", "JANE_DOE_002.dcm"],
      spatiallyOrdered: true,
      normal: [0, 0, 1],
      sliceSpacingMm: 2,
      pixelSpacingMm: [1, 1],
      rows: 30,
      cols: 30,
      issues: [{ code: "missing_slices", severity: "error", message: "About 1 slice appears to be missing.", sliceIds: ["JANE_DOE_002.dcm"] }],
      volumeReady: false,
    },
    volume: vol,
    skippedFileCount: 1,
    seed: [14, 14, 5],
    seedValue: 400,
    result,
    measurement: measureMask(result.mask),
    mesh: null,
  });
  const text = JSON.stringify(record);
  assert.equal(text.includes("JANE_DOE"), false);
  assert.equal(record.segmentation.isLearnedModel, false);
  assert.equal(record.segmentation.segmenter, "classical-region-growing-v1");
  assert.match(record.notice, /not a trained model/i);
  assert.deepEqual(record.segmentation.seedVoxel, [14, 14, 5]);
  assert.ok(record.segmentation.steps.length >= 3);
  assert.equal(record.source.seriesIssues[0].code, "missing_slices");
});
