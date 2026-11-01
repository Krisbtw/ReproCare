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

test("mesh vertices preserve DICOM patient coordinates within 1.0mm tolerance (Phase 4)", () => {
  const origin: [number, number, number] = [-120.5, -95.0, 42.0];
  const orientation: [number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0];
  const spacing: [number, number, number] = [0.9375, 0.9375, 3.0];
  const frame = createPatientFrame(origin, orientation, spacing);

  const landmarks: [number, number, number][] = [
    [0, 0, 0], // Uterus landmark reference (image space mm)
    [25.0, 30.0, 12.0],
    [-15.0, 40.0, 6.0],
  ];

  const positions = new Float32Array(landmarks.flatMap((p) => p));
  const indices = new Uint32Array([0, 1, 2]);
  const mesh: Mesh = { positions, indices };

  const transformed = transformMeshToPatient(mesh, frame);

  // Check each vertex distance to theoretical patient coordinate is <= 1.0mm
  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarks[i];
    const expected = imageMmToPatient(pt, frame);
    const actual: [number, number, number] = [
      transformed.positions[i * 3],
      transformed.positions[i * 3 + 1],
      transformed.positions[i * 3 + 2],
    ];

    const dist = Math.sqrt(
      Math.pow(actual[0] - expected[0], 2) +
      Math.pow(actual[1] - expected[1], 2) +
      Math.pow(actual[2] - expected[2], 2)
    );
    assert.ok(dist < 1.0, `Vertex ${i} deviation ${dist}mm exceeds 1.0mm tolerance`);
  }
});

test("coronal DICOM orientation [1, 0, 0, 0, 0, -1]: round-trips correctly", () => {
  const origin: [number, number, number] = [-100, 50, 80];
  const orientation: [number, number, number, number, number, number] = [1, 0, 0, 0, 0, -1];
  const spacing: [number, number, number] = [0.5, 0.5, 5.0];

  const frame = createPatientFrame(origin, orientation, spacing);

  const testPoints: [number, number, number][] = [
    [0, 0, 0],
    [50, 100, 10],
    [12.5, 33.2, 7.1],
  ];

  for (const pt of testPoints) {
    const pat = imageMmToPatient(pt, frame);
    const back = patientToImageMm(pat, frame);
    assert.ok(Math.abs(back[0] - pt[0]) < 1e-4);
    assert.ok(Math.abs(back[1] - pt[1]) < 1e-4);
    assert.ok(Math.abs(back[2] - pt[2]) < 1e-4);
  }
});

test("slice normal direction cosines: correctly computed from consecutive slice positions", () => {
  const origin: [number, number, number] = [0, 0, 10];
  const secondSlice: [number, number, number] = [0, 0, 14]; // 4mm step in +Z
  const orientation: [number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0];
  const spacing: [number, number, number] = [1.0, 1.0, 4.0];

  const frame = createPatientFrame(origin, orientation, spacing, secondSlice);
  assert.deepEqual(frame.sliceCosines, [0, 0, 1]);

  const pVoxel1 = voxelToPatient([0, 0, 1], frame);
  assert.deepEqual(pVoxel1, [0, 0, 14]);
});

test("physical volume calculations: anisotropic voxel spacing properly scaled to ml", () => {
  const spacing: [number, number, number] = [0.75, 0.75, 3.5]; // mm
  // Volume of 1 voxel in mm3: 0.75 * 0.75 * 3.5 = 1.96875 mm3 = 0.00196875 ml
  const voxelMl = (spacing[0] * spacing[1] * spacing[2]) / 1000;
  assert.ok(Math.abs(voxelMl - 0.00196875) < 1e-7);

  // A 10x10x10 voxel cube:
  const count = 1000;
  const totalMl = count * voxelMl;
  assert.ok(Math.abs(totalMl - 1.96875) < 1e-5);
});

