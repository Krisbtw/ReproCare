import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSeries, buildVolume, geometryFromMetadata, type SliceGeometry } from "./series.ts";
import { boxBlur, extractIsosurface, surfaceFromMask } from "./isosurface.ts";
import { meshQuality, taubinSmooth, toBinaryStl, toObj } from "./mesh.ts";
import { keepLargestComponent, labelComponents, segmentFromSeed } from "./segment.ts";
import { dice, jaccard, measureMask, relativeVolumeDifferencePct, surfaceDistances } from "./metrics.ts";
import { ellipsoidMask, emptyMask, vIndex, type Mask, type Vec3, type Volume } from "./volume.ts";

function slice(i: number, z: number, extra: Partial<SliceGeometry> = {}): SliceGeometry {
  return {
    id: `s${i}`,
    seriesUid: "1.2.3",
    instanceNumber: i,
    positionMm: [0, 0, z],
    orientation: [1, 0, 0, 0, 1, 0],
    pixelSpacingMm: [0.8, 0.8],
    rows: 4,
    cols: 4,
    sliceThicknessMm: 4,
    ...extra,
  };
}

function regularSeries(n: number, step = 4): SliceGeometry[] {
  return Array.from({ length: n }, (_, i) => slice(i + 1, i * step));
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

test("series: shuffled complete series is ordered spatially and is volume-ready", () => {
  const shuffled = [4, 0, 3, 1, 2].map((i) => regularSeries(5)[i]);
  const r = analyzeSeries(shuffled);
  assert.deepEqual(r.orderedIds, ["s1", "s2", "s3", "s4", "s5"]);
  assert.equal(r.sliceSpacingMm, 4);
  assert.equal(r.volumeReady, true);
  assert.equal(r.issues.length, 0);
});

test("series: a missing slice is reported and blocks volume stacking", () => {
  const all = regularSeries(6);
  const r = analyzeSeries(all.filter((_, i) => i !== 3));
  assert.equal(r.volumeReady, false);
  const gap = r.issues.find((i) => i.code === "missing_slices");
  assert.ok(gap);
  assert.match(gap.message, /About 1 slice/);
  assert.throws(() => buildVolume(r, new Map()), /not volume-ready/);
});

test("series: duplicate positions, mixed orientation, mixed matrix, mixed series are errors", () => {
  const dup = analyzeSeries([slice(1, 0), slice(2, 0), slice(3, 4)]);
  assert.ok(dup.issues.some((i) => i.code === "duplicate_position"));
  const tilt = regularSeries(4);
  tilt[2] = slice(3, 8, { orientation: [1, 0, 0, 0, 0.9, 0.436] });
  assert.ok(analyzeSeries(tilt).issues.some((i) => i.code === "mixed_orientation"));
  const mat = regularSeries(3);
  mat[1] = slice(2, 4, { cols: 8 });
  assert.ok(analyzeSeries(mat).issues.some((i) => i.code === "mixed_matrix"));
  const uid = regularSeries(3);
  uid[1] = slice(2, 4, { seriesUid: "9.9" });
  assert.ok(analyzeSeries(uid).issues.some((i) => i.code === "mixed_series"));
});

test("series: non-orthogonal orientation and missing geometry are refused, not guessed", () => {
  const bad = analyzeSeries([slice(1, 0, { orientation: [1, 0, 0, 0.5, 0.5, 0] }), slice(2, 4, { orientation: [1, 0, 0, 0.5, 0.5, 0] })]);
  assert.ok(bad.issues.some((i) => i.code === "bad_orientation"));
  assert.equal(bad.volumeReady, false);
  const miss = analyzeSeries([slice(1, 0), slice(2, 4, { positionMm: null })]);
  assert.ok(miss.issues.some((i) => i.code === "missing_geometry"));
  assert.equal(miss.spatiallyOrdered, false);
  assert.equal(analyzeSeries([]).issues[0].code, "empty");
});

test("series: thickness mismatch and irregular spacing are warnings only", () => {
  const s = regularSeries(5, 4).map((x) => ({ ...x, sliceThicknessMm: 8 }));
  const r = analyzeSeries(s);
  assert.equal(r.volumeReady, true);
  assert.ok(r.issues.some((i) => i.code === "thickness_spacing_mismatch" && i.severity === "warning"));
  const irr = regularSeries(5, 4);
  irr[3] = slice(4, 13);
  const r2 = analyzeSeries(irr);
  assert.ok(r2.issues.some((i) => i.code === "irregular_spacing"));
});

test("series: geometryFromMetadata parses DICOM multi-value strings; buildVolume maps spacing x=column", () => {
  const g = geometryFromMetadata(
    "a",
    {
      "Image position patient": "-10.5\\-20\\5",
      "Image orientation patient": "1\\0\\0\\0\\1\\0",
      "Pixel spacing": "0.9\\0.7",
      "Slice thickness": "3",
      "Instance number": "7",
      "Series UID": "1.2",
    },
    2,
    3,
  );
  assert.deepEqual(g.positionMm, [-10.5, -20, 5]);
  assert.deepEqual(g.pixelSpacingMm, [0.9, 0.7]);
  assert.equal(g.instanceNumber, 7);
  const slices = [0, 1, 2].map((i) => ({ ...g, id: `k${i}`, positionMm: [0, 0, i * 3] as Vec3 }));
  const rep = analyzeSeries(slices);
  const px = new Map(slices.map((s, i) => [s.id, new Float32Array(6).fill(i)]));
  const vol = buildVolume(rep, px);
  assert.deepEqual(vol.dims, [3, 2, 3]);
  assert.deepEqual(vol.spacingMm, [0.7, 0.9, 3]);
  assert.equal(vol.data[vIndex(vol.dims, 1, 1, 2)], 2);
  assert.equal(geometryFromMetadata("b", {}, 2, 2).positionMm, null);
});

test("isosurface: ellipsoid mesh on an anisotropic grid is watertight, outward, and near analytic area/volume", () => {
  const radii: Vec3 = [20, 15, 12];
  const mask = ellipsoidMask([64, 56, 44], [1, 1, 1.5], radii);
  const mesh = surfaceFromMask(mask, 1);
  const q = meshQuality(mesh);
  assert.equal(q.watertight, true, JSON.stringify(q));
  assert.equal(q.componentCount, 1);
  assert.equal(q.eulerCharacteristic, 2);
  assert.equal(q.degenerateTriangles, 0);
  const analyticMl = ((4 / 3) * Math.PI * radii[0] * radii[1] * radii[2]) / 1000;
  assert.ok((q.enclosedVolumeMl as number) > 0, "normals must point outward so signed volume is positive");
  const volErr = Math.abs((q.enclosedVolumeMl as number) - analyticMl) / analyticMl;
  assert.ok(volErr < 0.08, `volume error ${volErr}`);
  // Knud Thomsen approximation, accurate to about 1%.
  const p = 1.6075;
  const [a, b, c] = radii;
  const analyticArea = 4 * Math.PI * Math.pow((Math.pow(a * b, p) + Math.pow(a * c, p) + Math.pow(b * c, p)) / 3, 1 / p);
  const areaErr = Math.abs(q.surfaceAreaMm2 - analyticArea) / analyticArea;
  assert.ok(areaErr < 0.12, `area error ${areaErr}`);
});

test("isosurface: two separate objects give two components; empty mask gives no triangles", () => {
  const dims: Vec3 = [40, 20, 20];
  const m = emptyMask(dims, [1, 1, 1]);
  const a = ellipsoidMask(dims, [1, 1, 1], [5, 5, 5], [10, 10, 10]);
  const b = ellipsoidMask(dims, [1, 1, 1], [5, 5, 5], [30, 10, 10]);
  for (let i = 0; i < m.data.length; i += 1) m.data[i] = a.data[i] | b.data[i];
  const q = meshQuality(surfaceFromMask(m, 1));
  assert.equal(q.componentCount, 2);
  assert.equal(q.watertight, true);
  const none = surfaceFromMask(emptyMask(dims, [1, 1, 1]), 1);
  assert.equal(none.indices.length, 0);
  assert.equal(meshQuality(none).watertight, false);
});

test("mesh: Taubin smoothing keeps volume within 6% and stays watertight; exporters have exact sizes", () => {
  const mask = ellipsoidMask([40, 40, 40], [1, 1, 1], [12, 10, 9]);
  const raw = surfaceFromMask(mask, 0);
  const sm = taubinSmooth(raw, 10);
  const qr = meshQuality(raw);
  const qs = meshQuality(sm);
  assert.equal(qs.watertight, true);
  assert.ok(Math.abs((qs.enclosedVolumeMl as number) - (qr.enclosedVolumeMl as number)) / (qr.enclosedVolumeMl as number) < 0.06);
  const stl = toBinaryStl(sm);
  assert.equal(stl.length, 84 + 50 * qs.triangleCount);
  assert.equal(new DataView(stl.buffer).getUint32(80, true), qs.triangleCount);
  const obj = toObj(sm).trim().split("\n");
  assert.equal(obj.filter((l) => l.startsWith("v ")).length, sm.positions.length / 3);
  assert.equal(obj.filter((l) => l.startsWith("f ")).length, qs.triangleCount);
});

function noisyVolume(truth: Mask, seed = 7): Volume {
  const rnd = lcg(seed);
  const data = new Float32Array(truth.data.length);
  for (let i = 0; i < data.length; i += 1) data[i] = (truth.data[i] ? 120 : 30) + rnd() * 16;
  return { dims: truth.dims, spacingMm: truth.spacingMm, data };
}

test("segmentation: seeded region growing recovers a noisy ellipsoid; Dice against known truth is measured, not assumed", () => {
  const truth = ellipsoidMask([48, 48, 30], [0.8, 0.8, 3], [14, 11, 18]);
  const vol = noisyVolume(truth);
  const seed: Vec3 = [24, 24, 15];
  const res = segmentFromSeed(vol, { seed });
  assert.equal(res.isLearnedModel, false);
  assert.equal(res.accepted, true);
  const d = dice(truth, res.mask) as number;
  assert.ok(d > 0.95, `dice ${d}`);
  assert.ok(res.steps.length >= 4);
  assert.equal(res.segmenter, "classical-region-growing-v1");
  const rv = relativeVolumeDifferencePct(truth, res.mask) as number;
  assert.ok(Math.abs(rv) < 5, `volume diff ${rv}%`);
  const sd = surfaceDistances(truth, res.mask);
  assert.ok(sd && sd.hd95Mm <= 3, JSON.stringify(sd));
});

test("segmentation: leakage into a window that covers everything is rejected", () => {
  const truth = ellipsoidMask([30, 30, 20], [1, 1, 1], [8, 8, 8]);
  const vol = noisyVolume(truth);
  const res = segmentFromSeed(vol, { seed: [15, 15, 10], window: { lower: 0, upper: 255 } });
  assert.equal(res.accepted, false);
  assert.ok(res.warnings.some((w) => w.includes("leakage")));
});

test("segmentation: seed outside window or outside volume does not fabricate a mask", () => {
  const truth = ellipsoidMask([30, 30, 20], [1, 1, 1], [8, 8, 8]);
  const vol = noisyVolume(truth);
  const res = segmentFromSeed(vol, { seed: [1, 1, 1], window: { lower: 100, upper: 140 } });
  assert.equal(res.voxelCount, 0);
  assert.equal(res.accepted, false);
  assert.throws(() => segmentFromSeed(vol, { seed: [99, 1, 1] }), /outside/);
});

test("components: labelling works on non-cubic grids and keepLargest drops the small one", () => {
  const dims: Vec3 = [30, 12, 10];
  const m = emptyMask(dims, [1, 1, 1]);
  const big = ellipsoidMask(dims, [1, 1, 1], [6, 5, 4], [8, 6, 5]);
  const small = ellipsoidMask(dims, [1, 1, 1], [2, 2, 2], [24, 6, 5]);
  for (let i = 0; i < m.data.length; i += 1) m.data[i] = big.data[i] | small.data[i];
  const { sizes } = labelComponents(m);
  assert.equal(sizes.length, 2);
  const kept = keepLargestComponent(m);
  assert.equal(labelComponents(kept).sizes.length, 1);
});

test("metrics: Dice and Jaccard on known overlaps; surface distance of a shifted mask equals the shift", () => {
  const dims: Vec3 = [40, 30, 30];
  const a = ellipsoidMask(dims, [1, 1, 1], [8, 8, 8], [15, 15, 15]);
  const b = ellipsoidMask(dims, [1, 1, 1], [8, 8, 8], [15, 15, 15]);
  assert.equal(dice(a, b), 1);
  assert.equal(jaccard(a, b), 1);
  const far = ellipsoidMask(dims, [1, 1, 1], [3, 3, 3], [35, 15, 15]);
  assert.equal(dice(a, far), 0);
  const shifted = ellipsoidMask(dims, [1, 1, 1], [8, 8, 8], [19, 15, 15]);
  const sd = surfaceDistances(a, shifted) as { hausdorffMm: number; hd95Mm: number };
  assert.ok(Math.abs(sd.hausdorffMm - 4) <= 1.5, `hausdorff ${sd.hausdorffMm}`);
  assert.ok(sd.hd95Mm <= sd.hausdorffMm);
});

test("metrics: refuse instead of inventing when masks are empty or grids differ", () => {
  const dims: Vec3 = [10, 10, 10];
  const e = emptyMask(dims, [1, 1, 1]);
  assert.equal(dice(e, e), null);
  assert.equal(jaccard(e, e), null);
  assert.equal(surfaceDistances(e, ellipsoidMask(dims, [1, 1, 1], [3, 3, 3])), null);
  assert.equal(relativeVolumeDifferencePct(e, ellipsoidMask(dims, [1, 1, 1], [3, 3, 3])), null);
  const other = emptyMask([10, 10, 11], [1, 1, 1]);
  assert.equal(dice(e, other), null);
  assert.equal(measureMask(e).axesMm, null);
});

test("measureMask: principal-axis extents of a rotated-free ellipsoid are near its true diameters and volume near analytic", () => {
  const radii: Vec3 = [20, 12, 8];
  const m = ellipsoidMask([70, 50, 40], [0.9, 0.9, 1.2], radii);
  const r = measureMask(m);
  const truth = [40, 24, 16];
  r.axesMm!.forEach((v, i) => assert.ok(Math.abs(v - truth[i]) < 3, `axis ${i}: ${v} vs ${truth[i]}`));
  const analyticMl = ((4 / 3) * Math.PI * radii[0] * radii[1] * radii[2]) / 1000;
  assert.ok(Math.abs(r.volumeMl - analyticMl) / analyticMl < 0.05);
  assert.equal(r.componentCount, 1);
  assert.ok(r.centroidMm && Math.abs(r.centroidMm[0] - 34.5 * 0.9) < 0.5);
});

test("extractIsosurface on a plain scalar field respects the iso value", () => {
  const dims: Vec3 = [20, 20, 20];
  const data = new Float32Array(8000);
  for (let z = 0; z < 20; z += 1) for (let y = 0; y < 20; y += 1) for (let x = 0; x < 20; x += 1) data[vIndex(dims, x, y, z)] = 10 - Math.hypot(x - 9.5, y - 9.5, z - 9.5);
  const q = meshQuality(extractIsosurface({ dims, spacingMm: [1, 1, 1], data }, 4));
  assert.equal(q.watertight, true);
  const analytic = (4 / 3) * Math.PI * 6 ** 3 / 1000;
  assert.ok(Math.abs((q.enclosedVolumeMl as number) - analytic) / analytic < 0.05);
});

test("segmentation: harder phantom with partial-volume blur and heavy noise gives a measured, imperfect Dice", () => {
  const truth = ellipsoidMask([48, 48, 30], [0.8, 0.8, 3], [14, 11, 18]);
  const soft = boxBlur({ dims: truth.dims, spacingMm: truth.spacingMm, data: Float32Array.from(truth.data) }, 1);
  const rnd = lcg(11);
  const data = new Float32Array(truth.data.length);
  for (let i = 0; i < data.length; i += 1) data[i] = 30 + 90 * soft.data[i] + rnd() * 50;
  const res = segmentFromSeed({ dims: truth.dims, spacingMm: truth.spacingMm, data }, { seed: [24, 24, 15], kSigma: 3 });
  const d = dice(truth, res.mask) as number;
  console.log(`harder phantom: dice=${d.toFixed(3)} accepted=${res.accepted} voxels=${res.voxelCount} truthVoxels=${truth.data.reduce((a, b) => a + b, 0)}`);
  assert.ok(d > 0.7, `dice ${d}`);
});
