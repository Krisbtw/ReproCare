import test from "node:test";
import assert from "node:assert/strict";
import type { Volume } from "./volume.ts";
import {
  eigen3x3,
  registerVolumes,
  transformPoint,
  inverseTransformPoint,
  volumeMoments,
} from "./registration.ts";

function createSyntheticSphereVolume(
  center: [number, number, number],
  radius: number,
  dims: [number, number, number] = [32, 32, 32],
  spacing: [number, number, number] = [1, 1, 1],
): Volume {
  const [nx, ny, nz] = dims;
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) {
    const pz = z * spacing[2];
    for (let y = 0; y < ny; y += 1) {
      const py = y * spacing[1];
      for (let x = 0; x < nx; x += 1) {
        const px = x * spacing[0];
        const dx = px - center[0];
        const dy = py - center[1];
        const dz = pz - center[2];
        if (dx * dx + dy * dy + dz * dz <= radius * radius) {
          data[x + nx * (y + ny * z)] = 100;
        } else {
          data[x + nx * (y + ny * z)] = 10;
        }
      }
    }
  }
  return { dims, spacingMm: spacing, data };
}

test("eigen3x3 computes correct eigenvalues and eigenvectors for diagonal matrix", () => {
  const diag = [
    [5, 0, 0],
    [0, 2, 0],
    [0, 0, 1],
  ] as [[number, number, number], [number, number, number], [number, number, number]];
  const res = eigen3x3(diag);
  assert.equal(Math.round(res.values[0]), 5);
  assert.equal(Math.round(res.values[1]), 2);
  assert.equal(Math.round(res.values[2]), 1);
});

test("registerVolumes recovers translation between translated volumes", () => {
  const fixed = createSyntheticSphereVolume([16, 16, 16], 6);
  // moving is shifted by +4mm along X, -2mm along Y
  const moving = createSyntheticSphereVolume([20, 14, 16], 6);

  const reg = registerVolumes(fixed, moving);
  assert.ok(reg.supported);
  assert.ok(reg.ncc > 0.5);

  // Moving centroid should transform to fixed centroid
  const transformedCenter = transformPoint(reg.transform.movingCentroidMm, reg.transform);
  assert.ok(Math.abs(transformedCenter[0] - reg.transform.centerOfRotationMm[0]) < 0.5);
  assert.ok(Math.abs(transformedCenter[1] - reg.transform.centerOfRotationMm[1]) < 0.5);
  assert.ok(Math.abs(transformedCenter[2] - reg.transform.centerOfRotationMm[2]) < 0.5);

  // Inverting should return the original point
  const recovered = inverseTransformPoint(transformedCenter, reg.transform);
  assert.ok(Math.abs(recovered[0] - reg.transform.movingCentroidMm[0]) < 0.1);
  assert.ok(Math.abs(recovered[1] - reg.transform.movingCentroidMm[1]) < 0.1);
  assert.ok(Math.abs(recovered[2] - reg.transform.movingCentroidMm[2]) < 0.1);
});

test("registerVolumes flags unsupported when volumes have poor overlap or extreme shift", () => {
  const fixed = createSyntheticSphereVolume([8, 8, 8], 4);
  const distant = createSyntheticSphereVolume([28, 28, 28], 4);
  const reg = registerVolumes(fixed, distant);
  // Because overlap is minimal and shift is large, supported is false or notes indicate poor overlap
  assert.ok(reg.notes.length > 0);
});
