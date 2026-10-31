import test from "node:test";
import assert from "node:assert/strict";
import {
  cropAroundMask,
  gaussianSmooth,
  medianFilter,
  normalisePercentile,
  normaliseZScore,
  percentile,
  qualityIndicators,
  resampleMask,
  resampleVolume,
  sampleTrilinear,
} from "./preprocess.ts";
import { ellipsoidMask, maskVoxelCount, vIndex, voxelVolumeMl, type Vec3, type Volume } from "./volume.ts";

function ramp(dims: Vec3, spacing: Vec3): Volume {
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z += 1)
    for (let y = 0; y < dims[1]; y += 1)
      for (let x = 0; x < dims[0]; x += 1) data[vIndex(dims, x, y, z)] = x * spacing[0] + 2 * y * spacing[1] + 3 * z * spacing[2];
  return { dims, spacingMm: spacing, data };
}

function noisy(dims: Vec3, sd: number, seed = 7): Volume {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < data.length; i += 1) {
    // Box-Muller
    const u = Math.max(1e-12, rnd());
    const v = rnd();
    data[i] = 100 + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return { dims, spacingMm: [1, 1, 1], data };
}

test("percentile matches order statistics", () => {
  const d = Float32Array.from([5, 1, 4, 2, 3]);
  assert.equal(percentile(d, 0), 1);
  assert.equal(percentile(d, 50), 3);
  assert.equal(percentile(d, 100), 5);
  assert.equal(percentile(d, 25), 2);
  assert.deepEqual(Array.from(d), [5, 1, 4, 2, 3], "input not sorted in place");
});

test("percentile normalisation maps to [0,1] and never edits the input", () => {
  const v = ramp([10, 10, 4], [1, 1, 3]);
  const before = v.data.slice();
  const { volume, record } = normalisePercentile(v, 1, 99);
  assert.deepEqual(v.data, before);
  let mn = Infinity, mx = -Infinity;
  for (const x of volume.data) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
  assert.equal(mn, 0);
  assert.equal(mx, 1);
  assert.equal(record.op, "normalise_percentile");
  assert.ok(Number(record.params.high) > Number(record.params.low));
});

test("z-score gives mean 0 SD 1; flat volume gives zeros with a note", () => {
  const { volume, record } = normaliseZScore(noisy([16, 16, 8], 10));
  let m = 0;
  for (const x of volume.data) m += x;
  m /= volume.data.length;
  let sd = 0;
  for (const x of volume.data) sd += (x - m) ** 2;
  sd = Math.sqrt(sd / volume.data.length);
  assert.ok(Math.abs(m) < 1e-4);
  assert.ok(Math.abs(sd - 1) < 1e-3);
  assert.ok(Number(record.params.sd) > 8 && Number(record.params.sd) < 12);
  const flat = normaliseZScore({ dims: [2, 2, 2], spacingMm: [1, 1, 1], data: new Float32Array(8).fill(3) });
  assert.ok(flat.volume.data.every((x) => x === 0));
  assert.match(flat.record.note, /Zero variance/);
});

test("gaussian smoothing reduces noise SD, preserves the mean, records sigma per axis in voxels", () => {
  const v = noisy([24, 24, 12], 20);
  v.spacingMm = [1, 1, 4];
  const q0 = qualityIndicators(v).noiseSd;
  const { volume, record } = gaussianSmooth(v, 1.5);
  const q1 = qualityIndicators(volume).noiseSd;
  assert.ok(q1 < q0 * 0.5, `noise ${q0.toFixed(2)} -> ${q1.toFixed(2)}`);
  const mean = (d: Float32Array) => d.reduce((a, b) => a + b, 0) / d.length;
  assert.ok(Math.abs(mean(volume.data) - mean(v.data)) < 0.5);
  assert.deepEqual(record.params.sigmaVoxels, [1.5, 1.5, 0.375]);
});

test("median filter removes an isolated spike and keeps a flat region flat", () => {
  const dims: Vec3 = [5, 5, 5];
  const data = new Float32Array(125).fill(10);
  data[vIndex(dims, 2, 2, 2)] = 1000;
  const { volume } = medianFilter({ dims, spacingMm: [1, 1, 1], data });
  assert.ok(volume.data.every((x) => x === 10));
});

test("trilinear sampling is exact on a linear ramp; outside returns the fill value", () => {
  const v = ramp([6, 6, 6], [1, 1, 1]);
  assert.ok(Math.abs(sampleTrilinear(v, 2.5, 1.25, 3.75) - (2.5 + 2 * 1.25 + 3 * 3.75)) < 1e-4);
  assert.equal(sampleTrilinear(v, -1, 0, 0, -7), -7);
});

test("resampling keeps physical extent and values of a linear ramp; mask resampling keeps labels binary and volume close", () => {
  const v = ramp([20, 20, 6], [1, 1, 4]);
  const { volume, record } = resampleVolume(v, [2, 2, 2]);
  assert.deepEqual(volume.dims, [10, 10, 11]);
  assert.deepEqual(volume.spacingMm, [2, 2, 2]);
  // Physical position of voxel (3,4,5) is (6,8,10) mm; ramp value there = 6 + 16 + 30.
  assert.ok(Math.abs(volume.data[vIndex(volume.dims, 3, 4, 5)] - 52) < 1e-3);
  assert.equal(record.op, "resample_trilinear");
  const m = ellipsoidMask([60, 60, 20], [1, 1, 3], [15, 12, 18]);
  const r = resampleMask(m, [1.5, 1.5, 1.5]);
  assert.ok(r.mask.data.every((x) => x === 0 || x === 1));
  const ml0 = maskVoxelCount(m) * voxelVolumeMl(m.spacingMm);
  const ml1 = maskVoxelCount(r.mask) * voxelVolumeMl(r.mask.spacingMm);
  assert.ok(Math.abs(ml1 - ml0) / ml0 < 0.08, `${ml0.toFixed(2)} vs ${ml1.toFixed(2)}`);
  assert.throws(() => resampleVolume(v, [0, 1, 1]), /positive/);
});

test("crop around a mask keeps the structure plus margin and reports its origin", () => {
  const m = ellipsoidMask([40, 40, 10], [1, 1, 2], [5, 5, 4], [20, 20, 10]);
  const v = ramp([40, 40, 10], [1, 1, 2]);
  const c = cropAroundMask(v, m, 2)!;
  assert.ok(c.volume.dims[0] < 20 && c.volume.dims[0] >= 11);
  assert.equal(c.volume.data[0], v.data[vIndex(v.dims, ...c.originVoxels)]);
  assert.equal(cropAroundMask(v, { ...m, data: new Uint8Array(m.data.length) }, 2), null);
});

test("quality indicators: noise estimate tracks true SD; anisotropy flagged", () => {
  const v = noisy([40, 40, 10], 12);
  const q = qualityIndicators(v);
  assert.ok(q.noiseSd > 9 && q.noiseSd < 15, `noise ${q.noiseSd}`);
  const thick = { ...v, spacingMm: [0.8, 0.8, 5] as Vec3 };
  const q2 = qualityIndicators(thick);
  assert.ok(q2.anisotropy > 6);
  assert.ok(q2.flags.some((f) => /thicker/.test(f)));
});
