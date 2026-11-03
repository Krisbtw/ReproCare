import test from "node:test";
import assert from "node:assert/strict";
import { syntheticIntensity, type SyntheticSeriesSpec } from "../dicom/series-writer.ts";
import { segmentFromSeed } from "./segment.ts";
import { findLesionSeed } from "./auto-seed.ts";
import type { Vec3, Volume } from "./volume.ts";

function volumeOf(spec: SyntheticSeriesSpec): Volume {
  const { cols, rows, slices } = spec;
  const data = new Float32Array(cols * rows * slices);
  for (let k = 0; k < slices; k++) for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) data[x + cols * (y + rows * k)] = syntheticIntensity(spec, x, y, k);
  return { dims: [cols, rows, slices], spacingMm: [spec.pixelSpacingMm[1], spec.pixelSpacingMm[0], spec.sliceStepMm] as Vec3, data };
}

// Same parameters as Volume Lab's "Load synthetic sample".
const SAMPLE = { cols: 96, rows: 96, slices: 28, pixelSpacingMm: [1.2, 1.2], sliceStepMm: 4, lesionRadiiMm: [20, 16, 28], noise: 14 } as SyntheticSeriesSpec;

test("auto seed lands inside the synthetic lesion and region growing is accepted", () => {
  const v = volumeOf(SAMPLE);
  const seed = findLesionSeed(v);
  const res = segmentFromSeed(v, { seed, seedRadiusVoxels: 2, kSigma: 2.5, closeIterations: 1 });
  assert.equal(res.accepted, true, `seed ${seed} rejected: ${JSON.stringify(res).slice(0, 300)}`);
  const ml = (res.voxelCount * 1.2 * 1.2 * 4) / 1000;
  const truth = ((4 / 3) * Math.PI * 20 * 16 * 28) / 1000;
  assert.ok(Math.abs(ml - truth) / truth < 0.35, `volume ${ml.toFixed(1)} mL vs analytic ${truth.toFixed(1)} mL`);
});

test("auto seed on a flat volume falls back to the centre without throwing", () => {
  const v: Volume = { dims: [10, 10, 10], spacingMm: [1, 1, 1], data: new Float32Array(1000) };
  assert.deepEqual(findLesionSeed(v), [5, 5, 5]);
});
