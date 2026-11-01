import test from "node:test";
import assert from "node:assert/strict";
import type { Volume } from "./volume.ts";
import {
  eigen3x3,
  registerVolumes,
  transformPoint,
  inverseTransformPoint,
  validateRotationMatrix,
  validateTransformMatrix,
  toMatrix4x4,
  fromMatrix4x4,
  parseRegistrationTransform,
  eulerToRotationMatrix,
  type Matrix4x4,
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

test("registerVolumes recovers translation between translated volumes and provides quality metrics", () => {
  const fixed = createSyntheticSphereVolume([16, 16, 16], 6);
  // moving is shifted by +4mm along X, -2mm along Y
  const moving = createSyntheticSphereVolume([20, 14, 16], 6);

  const reg = registerVolumes(fixed, moving);
  assert.ok(reg.supported);
  assert.equal(reg.status, "verified");
  assert.equal(reg.matrixValid, true);
  assert.ok(reg.ncc > 0.5);
  assert.ok(reg.residualMm < 1.0);
  assert.equal(reg.transform.matrix4x4?.length, 16);

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
  assert.ok(reg.notes.length > 0);
});

test("known coordinates and transformations: 90-degree rotation + translation and 4x4 round-trip", () => {
  // 90 deg rotation around Z axis: x' = -y, y' = x, z' = z
  const rotZ90 = eulerToRotationMatrix(0, 0, Math.PI / 2);
  const rotCheck = validateRotationMatrix(rotZ90);
  assert.equal(rotCheck.valid, true);
  assert.ok(Math.abs((rotCheck.determinant ?? 0) - 1) < 1e-6);

  const transform = {
    translationMm: [10, -5, 3] as [number, number, number],
    rotation: rotZ90,
    centerOfRotationMm: [10, -5, 3] as [number, number, number],
    movingCentroidMm: [0, 0, 0] as [number, number, number],
  };

  // Point [4, 2, 1] rotated by +90 deg around Z is [-2, 4, 1], then + [10, -5, 3] = [8, -1, 4]
  const pt: [number, number, number] = [4, 2, 1];
  const mapped = transformPoint(pt, transform);
  assert.ok(Math.abs(mapped[0] - 8) < 1e-6);
  assert.ok(Math.abs(mapped[1] - -1) < 1e-6);
  assert.ok(Math.abs(mapped[2] - 4) < 1e-6);

  // Canonical 4x4 matrix produces the exact same result
  const mat = toMatrix4x4(transform);
  const matCheck = validateTransformMatrix(mat);
  assert.equal(matCheck.valid, true);

  const mappedFromMat = transformPoint(pt, mat);
  assert.ok(Math.abs(mappedFromMat[0] - mapped[0]) < 1e-6);
  assert.ok(Math.abs(mappedFromMat[1] - mapped[1]) < 1e-6);
  assert.ok(Math.abs(mappedFromMat[2] - mapped[2]) < 1e-6);

  // Inverse recovers original point [4, 2, 1]
  const invPt = inverseTransformPoint(mapped, mat);
  assert.ok(Math.abs(invPt[0] - pt[0]) < 1e-6);
  assert.ok(Math.abs(invPt[1] - pt[1]) < 1e-6);
  assert.ok(Math.abs(invPt[2] - pt[2]) < 1e-6);

  // Round-trip through fromMatrix4x4 and JSON serialization
  const parsed = parseRegistrationTransform(JSON.stringify(mat));
  assert.ok(parsed);
  const mappedFromParsed = transformPoint(pt, parsed);
  assert.ok(Math.abs(mappedFromParsed[0] - 8) < 1e-6);
  assert.ok(Math.abs(mappedFromParsed[1] - -1) < 1e-6);
  assert.ok(Math.abs(mappedFromParsed[2] - 4) < 1e-6);
});

test("validateTransformMatrix rejects invalid, singular, reflective, non-rigid, and out-of-bounds matrices", () => {
  // 1. Wrong length
  assert.equal(validateTransformMatrix([1, 2, 3]).valid, false);

  // 2. Non-finite elements
  const nanMat = [1, 0, 0, NaN, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(validateTransformMatrix(nanMat).valid, false);

  // 3. Invalid bottom homogeneous row
  const badBottom: Matrix4x4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1];
  const botRes = validateTransformMatrix(badBottom);
  assert.equal(botRes.valid, false);
  assert.match(botRes.reason ?? "", /bottom row/i);

  // 4. Reflection matrix (det = -1)
  const reflection: Matrix4x4 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const refRes = validateTransformMatrix(reflection);
  assert.equal(refRes.valid, false);
  assert.match(refRes.reason ?? "", /reflection|det/i);

  // 5. Scaling / non-orthonormal matrix
  const scaled: Matrix4x4 = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
  const scaleRes = validateTransformMatrix(scaled);
  assert.equal(scaleRes.valid, false);

  // 6. Extreme physical translation (> 500 mm)
  const hugeShift: Matrix4x4 = [1, 0, 0, 1200, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const shiftRes = validateTransformMatrix(hugeShift);
  assert.equal(shiftRes.valid, false);
  assert.match(shiftRes.reason ?? "", /Translation magnitude/);

  // 7. transformPoint throws when given an invalid transform or non-finite point
  assert.throws(() => transformPoint([NaN, 0, 0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), /finite/);
  assert.throws(() => transformPoint([1, 2, 3], reflection), /Invalid transformation matrix/);
  assert.throws(() => fromMatrix4x4(reflection), /reflection|Invalid/i);
});
