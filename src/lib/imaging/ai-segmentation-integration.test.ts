import test from "node:test";
import assert from "node:assert/strict";
import {
  extractClassMaskFromVolume,
  parseSegmentationResponse,
  validateSegmentationGeometryAlignment,
  type SourceScanGeometry,
} from "./service-client.ts";
import { measureMask } from "./metrics.ts";
import { meshFromMask } from "./lab.ts";
import { createPatientFrame, transformMeshToPatient, imageMmToPatient } from "./patient-coords.ts";
import { versionFromLab } from "./finding-link.ts";
import { vIndex } from "./volume.ts";

const sampleSegmentationPayload = {
  model_id: "umd_monai_fibroid",
  model: {
    id: "umd_monai_fibroid",
    name: "UMD Uterine Myoma (SimpleUnet3D Custom 3D U-Net)",
    is_learned_model: true,
    architecture: "SimpleUnet3D (custom 3D U-Net — PyTorch/NumPy, MONAI not used)",
    model_version: "1.0.0-sprint2",
    dataset_version: "UMD-v1",
    checkpoint_sha256: "ed311f35eb6fb6c6abb808681da70d754719fa4c85f3aca3beee2eff7af6789c",
    training_mode: "synthetic_phantom_verification",
    is_clinical_grade: false,
  },
  shape_zyx: [12, 24, 24],
  spacing_zyx_mm: [3.5, 0.85, 0.85],
  origin_lps_mm: [-42.5, -68.25, 15.0],
  direction_cosines: [0, 1, 0, 0, 0, -1, -1, 0, 0],
  frame_of_reference_uid: "1.2.826.0.1.3680043.8.498.777777",
  label_map: {
    "0": "background",
    "1": "uterine_wall",
    "2": "cavity",
    "3": "myoma",
    "4": "nabothian",
  },
  labels: {
    "0": "background",
    "1": "uterine_wall",
    "2": "cavity",
    "3": "myoma",
    "4": "nabothian",
  },
  dtype: "uint8",
  encoding: "zlib+base64",
  mask: "eJwLAAAAAAE=",
  mask_b64_zlib: "eJwLAAAAAAE=",
  note: "Experimental learned model output (SimpleUnet3D). Not clinically validated; requires clinician verification.",
};

test("parseSegmentationResponse parses valid payload and rejects malformed or missing-mask responses", () => {
  const parsed = parseSegmentationResponse(sampleSegmentationPayload);
  assert.ok(parsed);
  assert.equal(parsed.modelId, "umd_monai_fibroid");
  assert.equal(parsed.modelVersion, "1.0.0-sprint2");
  assert.ok(parsed.architecture.includes("SimpleUnet3D"));
  assert.ok(parsed.architecture.includes("MONAI not used"));
  assert.equal(parsed.isClinicalGrade, false);
  assert.deepEqual(parsed.shapeZyx, [12, 24, 24]);
  assert.deepEqual(parsed.spacingZyxMm, [3.5, 0.85, 0.85]);
  assert.deepEqual(parsed.originLpsMm, [-42.5, -68.25, 15.0]);
  assert.equal(parsed.frameOfReferenceUid, "1.2.826.0.1.3680043.8.498.777777");

  // Rejects missing mask, invalid dimensions, or empty labels
  assert.equal(parseSegmentationResponse(null), null);
  assert.equal(parseSegmentationResponse({}), null);
  assert.equal(parseSegmentationResponse({ ...sampleSegmentationPayload, mask: "", mask_b64_zlib: "" }), null);
  assert.equal(parseSegmentationResponse({ ...sampleSegmentationPayload, shape_zyx: [0, 24, 24] }), null);
  assert.equal(parseSegmentationResponse({ ...sampleSegmentationPayload, spacing_zyx_mm: [-1, 1, 1] }), null);
});

test("validateSegmentationGeometryAlignment accepts aligned scan and rejects any dimension, spacing, origin, orientation, or frame mismatch", () => {
  const parsed = parseSegmentationResponse(sampleSegmentationPayload)!;
  const alignedSource: SourceScanGeometry = {
    dims: [24, 24, 12],
    spacingMm: [0.85, 0.85, 3.5],
    originLpsMm: [-42.5, -68.25, 15.0],
    directionCosines: [0, 1, 0, 0, 0, -1, -1, 0, 0],
    frameOfReferenceUid: "1.2.826.0.1.3680043.8.498.777777",
  };

  const okCheck = validateSegmentationGeometryAlignment(alignedSource, parsed);
  assert.equal(okCheck.aligned, true);
  assert.deepEqual(okCheck.problems, []);

  // 1. Dimension mismatch
  const badDims = validateSegmentationGeometryAlignment({ ...alignedSource, dims: [24, 24, 10] }, parsed);
  assert.equal(badDims.aligned, false);
  assert.ok(badDims.problems.some((p) => p.includes("Dimension mismatch")));

  // 2. Voxel spacing mismatch
  const badSpacing = validateSegmentationGeometryAlignment({ ...alignedSource, spacingMm: [1.0, 1.0, 3.5] }, parsed);
  assert.equal(badSpacing.aligned, false);
  assert.ok(badSpacing.problems.some((p) => p.includes("Voxel spacing mismatch")));

  // 3. Origin mismatch
  const badOrigin = validateSegmentationGeometryAlignment(
    { ...alignedSource, originLpsMm: [-10.0, -68.25, 15.0] },
    parsed,
  );
  assert.equal(badOrigin.aligned, false);
  assert.ok(badOrigin.problems.some((p) => p.includes("Origin mismatch")));

  // 4. Orientation cosines mismatch
  const badOrientation = validateSegmentationGeometryAlignment(
    { ...alignedSource, directionCosines: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    parsed,
  );
  assert.equal(badOrientation.aligned, false);
  assert.ok(badOrientation.problems.some((p) => p.includes("Orientation mismatch")));

  // 5. Coordinate frame UID mismatch
  const badFrame = validateSegmentationGeometryAlignment(
    { ...alignedSource, frameOfReferenceUid: "1.2.826.0.1.3680043.8.498.DIFFERENT" },
    parsed,
  );
  assert.equal(badFrame.aligned, false);
  assert.ok(badFrame.problems.some((p) => p.includes("Coordinate frame mismatch")));
});

test("extractClassMaskFromVolume extracts individual UMD structures, preserves geometry into 3D mesh/LPS export, and requires clinician confirmation", () => {
  const shapeZyx: [number, number, number] = [10, 20, 20];
  const spacingZyxMm: [number, number, number] = [3.0, 1.0, 1.0];
  const [nz, ny, nx] = shapeZyx;
  const dims: [number, number, number] = [nx, ny, nz];
  const rawLabels = new Uint8Array(nx * ny * nz);

  let expectedMyomaVoxels = 0;
  let expectedWallVoxels = 0;
  for (let z = 2; z <= 7; z++) {
    for (let y = 5; y <= 14; y++) {
      for (let x = 5; x <= 14; x++) {
        const idx = vIndex(dims, x, y, z);
        if (z >= 3 && z <= 6 && y >= 7 && y <= 12 && x >= 7 && x <= 12) {
          rawLabels[idx] = 3; // myoma
          expectedMyomaVoxels++;
        } else {
          rawLabels[idx] = 1; // uterine_wall
          expectedWallVoxels++;
        }
      }
    }
  }

  // Extract Class 3 (myoma)
  const myomaRes = extractClassMaskFromVolume(
    rawLabels,
    shapeZyx,
    spacingZyxMm,
    3,
    sampleSegmentationPayload.labels,
  );
  assert.equal(myomaRes.voxelCount, expectedMyomaVoxels);
  assert.deepEqual(myomaRes.mask.dims, [20, 20, 10]);
  assert.deepEqual(myomaRes.mask.spacingMm, [1.0, 1.0, 3.0]);
  assert.equal(myomaRes.classVoxelCounts["3"], expectedMyomaVoxels);
  assert.equal(myomaRes.classVoxelCounts["1"], expectedWallVoxels);

  // Extract Class 0 (all foreground = wall + myoma)
  const allFgRes = extractClassMaskFromVolume(
    rawLabels,
    shapeZyx,
    spacingZyxMm,
    0,
    sampleSegmentationPayload.labels,
  );
  assert.equal(allFgRes.voxelCount, expectedMyomaVoxels + expectedWallVoxels);

  // Measure and mesh the AI-segmented myoma mask, then transform to Patient LPS coordinates
  const measurement = measureMask(myomaRes.mask);
  assert.equal(measurement.voxelCount, expectedMyomaVoxels);
  assert.ok(Math.abs(measurement.volumeMl - (expectedMyomaVoxels * 3.0) / 1000) < 1e-4);

  const builtMesh = meshFromMask(myomaRes.mask, { blurIterations: 1, taubinIterations: 5 });
  assert.ok(builtMesh);
  assert.ok(builtMesh!.mesh.indices.length > 0);

  const patientFrame = createPatientFrame(
    [-50, -60, 10],
    [1, 0, 0, 0, 1, 0],
    [1.0, 1.0, 3.0],
    [-50, -60, 13],
    "1.2.826.0.1.3680043.8.498.777777",
  );
  const lpsMesh = transformMeshToPatient(builtMesh!.mesh, patientFrame);
  assert.equal(lpsMesh.positions.length, builtMesh!.mesh.positions.length);
  const patientCentroid = imageMmToPatient(measurement.centroidMm!, patientFrame);
  assert.ok(Math.abs(patientCentroid[0] - (measurement.centroidMm![0] - 50)) < 1e-4);

  // Recording as a finding version must refuse without clinician confirmation and succeed with confirmation
  const unconfirmed = versionFromLab({
    accepted: true,
    isLearnedModel: true,
    clinicianConfirmed: false,
    modelId: "umd_monai_fibroid",
    measurement,
    seed: [10, 10, 5],
    recordHash: "deadbeef",
    seriesDescription: "T2W Sagittal",
    source: "upload",
    reason: "AI fibroid contour reviewed on sagittal T2W MRI",
    patientCentroidMm: patientCentroid,
    frame: "dicom_lps",
  });
  assert.equal(unconfirmed.ok, false);

  const confirmed = versionFromLab({
    accepted: true,
    isLearnedModel: true,
    clinicianConfirmed: true,
    modelId: "umd_monai_fibroid",
    measurement,
    seed: [10, 10, 5],
    recordHash: "deadbeef",
    seriesDescription: "T2W Sagittal",
    source: "upload",
    reason: "AI fibroid contour reviewed on sagittal T2W MRI",
    patientCentroidMm: patientCentroid,
    frame: "dicom_lps",
  });
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) {
    assert.equal(confirmed.fields.modelId, "umd_monai_fibroid");
    assert.equal(confirmed.fields.frame, "dicom_lps");
    assert.deepEqual(confirmed.fields.centroidMm, patientCentroid);
  }
});
