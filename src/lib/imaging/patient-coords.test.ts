import test from "node:test";
import assert from "node:assert/strict";
import {
  createPatientFrame,
  imageMmToPatient,
  patientToImageMm,
  voxelToPatient,
  patientToVoxel,
  transformMeshToPatient,
  meshBounds,
} from "./patient-coords.ts";
import type { Mesh } from "./isosurface.ts";

test("axial DICOM orientation [1, 0, 0, 0, 1, 0]: matches LPS axis mapping", () => {
  const origin: [number, number, number] = [-150, -180, 50];
  const orientation: [number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0];
  const spacing: [number, number, number] = [1.2, 1.2, 4.0];

  const frame = createPatientFrame(origin, orientation, spacing);

  // Voxel (0, 0, 0) is at origin
  const p0 = voxelToPatient([0, 0, 0], frame);
  assert.deepEqual(p0, origin);

  // Voxel (10, 20, 5)
  // x = -150 + 10 * 1.2 = -138
  // y = -180 + 20 * 1.2 = -156
  // z = 50 + 5 * 4.0 = 70
  const p1 = voxelToPatient([10, 20, 5], frame);
  assert.equal(Math.round(p1[0]), -138);
  assert.equal(Math.round(p1[1]), -156);
  assert.equal(Math.round(p1[2]), 70);

  // Round-trip back to voxel
  const v1 = patientToVoxel(p1, frame);
  assert.ok(Math.abs(v1[0] - 10) < 1e-4);
  assert.ok(Math.abs(v1[1] - 20) < 1e-4);
  assert.ok(Math.abs(v1[2] - 5) < 1e-4);
});

test("sagittal DICOM orientation: [0, 1, 0, 0, 0, -1]: round-trips correctly", () => {
  const origin: [number, number, number] = [20, -100, 150];
  const orientation: [number, number, number, number, number, number] = [0, 1, 0, 0, 0, -1];
  const spacing: [number, number, number] = [0.8, 0.8, 3.0];

  const frame = createPatientFrame(origin, orientation, spacing);

  const testPoints: [number, number, number][] = [
    [0, 0, 0],
    [15, 30, 45],
    [5.5, 12.3, 8.9],
  ];

  for (const pt of testPoints) {
    const pat = imageMmToPatient(pt, frame);
    const back = patientToImageMm(pat, frame);
    assert.ok(Math.abs(back[0] - pt[0]) < 1e-4);
    assert.ok(Math.abs(back[1] - pt[1]) < 1e-4);
    assert.ok(Math.abs(back[2] - pt[2]) < 1e-4);
  }
});

test("transformMeshToPatient transforms all vertices and preserves topology", () => {
  const origin: [number, number, number] = [100, 200, 300];
  const orientation: [number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0];
  const spacing: [number, number, number] = [1, 1, 1];
  const frame = createPatientFrame(origin, orientation, spacing);

  // Simple triangle mesh in image mm
  const mesh: Mesh = {
    positions: new Float32Array([
      0, 0, 0,
      10, 0, 0,
      0, 10, 0,
    ]),
    indices: new Uint32Array([0, 1, 2]),
  };

  const patMesh = transformMeshToPatient(mesh, frame);
  assert.equal(patMesh.indices.length, 3);
  assert.equal(patMesh.indices[0], 0);
  assert.equal(patMesh.indices[1], 1);
  assert.equal(patMesh.indices[2], 2);

  // V0: 100, 200, 300
  assert.equal(patMesh.positions[0], 100);
  assert.equal(patMesh.positions[1], 200);
  assert.equal(patMesh.positions[2], 300);

  // V1: 110, 200, 300
  assert.equal(patMesh.positions[3], 110);
  assert.equal(patMesh.positions[4], 200);
  assert.equal(patMesh.positions[5], 300);

  // Bounds
  const b = meshBounds(patMesh);
  assert.deepEqual(b.min, [100, 200, 300]);
  assert.deepEqual(b.max, [110, 210, 300]);
  assert.deepEqual(b.center, [105, 205, 300]);
});
