import test from "node:test";
import assert from "node:assert/strict";
import {
  TRANSFER_SYNTAX_REGISTRY,
  buildEncapsulatedCompressedDicom,
  buildImplicitVrDicom,
  buildRleLosslessDicom,
  buildSyntheticMrDicom,
  buildSyntheticMultiFrameDicom,
  readDicomBytes,
  registerCompressedDicomDecoder,
} from "./codec.ts";
import {
  analyzeSeries,
  buildVolume,
  expandMultiFrameDicomToSeries,
  geometryFromMetadata,
} from "../imaging/series.ts";
import { normalisePercentile } from "../imaging/preprocess.ts";
import { segmentFromSeed } from "../imaging/segment.ts";
import { surfaceFromMask } from "../imaging/isosurface.ts";
import {
  toPatientSpaceBinaryStl,
  toPatientSpaceObj,
  transformMeshToPatientSpace,
  validateExportedMeshGeometry,
} from "../imaging/mesh.ts";

test("Sprint 5 Task 1A: Explicit VR Little Endian 8-bit and 16-bit DICOM with RescaleSlope and RescaleIntercept", async () => {
  const raw8 = buildSyntheticMrDicom({
    rows: 16,
    cols: 16,
    bitsAllocated: 8,
  });
  const parsed8 = await readDicomBytes(raw8);
  assert.equal(parsed8.decodeStatus, "ok");
  assert.equal(parsed8.transferSyntax, "1.2.840.10008.1.2.1");
  assert.equal(parsed8.rows, 16);
  assert.equal(parsed8.cols, 16);
  assert.equal(parsed8.floatPixels?.length, 256);

  // 16-bit with RescaleSlope = 2, RescaleIntercept = -50
  const raw16 = buildSyntheticMrDicom({
    rows: 16,
    cols: 16,
    bitsAllocated: 16,
    rescaleSlope: 2,
    rescaleIntercept: -50,
  });
  const parsed16 = await readDicomBytes(raw16);
  assert.equal(parsed16.decodeStatus, "ok");
  assert.equal(parsed16.bitsAllocated, 16);
  assert.equal(parsed16.rescaleSlope, 2);
  assert.equal(parsed16.rescaleIntercept, -50);
  // Background raw 100 -> 100 * 2 - 50 = 150; foreground raw 800 -> 800 * 2 - 50 = 1550
  assert.equal(parsed16.floatPixels?.[0], 150);
  const maxVal = Math.max(...(parsed16.floatPixels ?? []));
  assert.equal(maxVal, 1550);
});

test("Sprint 5 Task 1A: Implicit VR Little Endian (1.2.840.10008.1.2) decoding and geometry extraction", async () => {
  const rawImplicit = buildImplicitVrDicom({
    rows: 16,
    cols: 16,
    imagePosition: "12.5\\-24.0\\40.0",
    imageOrientation: "1\\0\\0\\0\\1\\0",
    pixelSpacing: "1.25\\1.25",
  });
  const parsed = await readDicomBytes(rawImplicit);
  assert.equal(parsed.decodeStatus, "ok");
  assert.equal(parsed.transferSyntax, "1.2.840.10008.1.2");
  assert.equal(parsed.transferSyntaxName, "Implicit VR Little Endian");
  assert.equal(parsed.rows, 16);
  assert.equal(parsed.cols, 16);
  assert.equal(parsed.floatPixels?.[0], 0);
  assert.equal(parsed.floatPixels?.[3], 21);

  const geom = geometryFromMetadata("slice-imp-1", parsed.metadata, parsed.rows, parsed.cols);
  assert.deepEqual(geom.positionMm, [12.5, -24.0, 40.0]);
  assert.deepEqual(geom.pixelSpacingMm, [1.25, 1.25]);
});

test("Sprint 5 Task 1A: RLE Lossless (1.2.840.10008.1.2.5) encapsulated PackBits decoding (8-bit and 16-bit)", async () => {
  const rle8 = buildRleLosslessDicom({ rows: 16, cols: 16, bitsAllocated: 8 });
  const parsed8 = await readDicomBytes(rle8);
  assert.equal(parsed8.decodeStatus, "ok");
  assert.equal(parsed8.transferSyntax, "1.2.840.10008.1.2.5");
  assert.equal(parsed8.transferSyntaxName, "RLE Lossless");
  assert.equal(parsed8.floatPixels?.[0], 180);
  assert.equal(parsed8.floatPixels?.[16 * 2], 40);

  const rle16 = buildRleLosslessDicom({ rows: 16, cols: 16, bitsAllocated: 16 });
  const parsed16 = await readDicomBytes(rle16);
  assert.equal(parsed16.decodeStatus, "ok");
  assert.equal(parsed16.bitsAllocated, 16);
  assert.equal(parsed16.floatPixels?.[0], 720);
  assert.equal(parsed16.floatPixels?.[16 * 2], 160);
});

test("Sprint 5 Task 1A: Encapsulated JPEG (1.2.840.10008.1.2.4.50, .70) and JPEG 2000 (1.2.840.10008.1.2.4.90, .91) decoding and corruption diagnostics", async () => {
  for (const syntax of [
    "1.2.840.10008.1.2.4.50",
    "1.2.840.10008.1.2.4.70",
    "1.2.840.10008.1.2.4.90",
    "1.2.840.10008.1.2.4.91",
  ] as const) {
    assert.ok(TRANSFER_SYNTAX_REGISTRY[syntax]?.supportedByDefault, `Expected ${syntax} to be registered`);
    const raw = buildEncapsulatedCompressedDicom({
      transferSyntax: syntax,
      rows: 16,
      cols: 16,
    });
    const parsed = await readDicomBytes(raw);
    assert.equal(parsed.decodeStatus, "ok", `Expected syntax ${syntax} to decode cleanly`);
    assert.equal(parsed.transferSyntax, syntax);
    assert.equal(parsed.floatPixels?.length, 256);
    assert.equal(parsed.floatPixels?.[0], 30);
    assert.equal(parsed.floatPixels?.[1], 35);
  }

  // Corrupted compressed bitstream -> must report corrupted_pixel_data, never silent zeros
  const corruptedJpeg = buildEncapsulatedCompressedDicom({
    transferSyntax: "1.2.840.10008.1.2.4.50",
    rows: 16,
    cols: 16,
    corruptedStream: true,
  });
  const parsedCorrupt = await readDicomBytes(corruptedJpeg);
  assert.equal(parsedCorrupt.decodeStatus, "corrupted_pixel_data");
  assert.ok(parsedCorrupt.decodeError && parsedCorrupt.decodeError.length > 0);
  assert.equal(parsedCorrupt.floatPixels, null);

  // Unsupported transfer syntax -> must report unsupported_transfer_syntax with clear message
  const unsupportedRaw = buildEncapsulatedCompressedDicom({
    transferSyntax: "1.2.840.10008.1.2.4.999",
    rows: 16,
    cols: 16,
  });
  const parsedUnsupported = await readDicomBytes(unsupportedRaw);
  assert.equal(parsedUnsupported.decodeStatus, "unsupported_transfer_syntax");
  assert.match(parsedUnsupported.decodeError ?? "", /Unsupported transfer syntax/i);

  // Pluggable external codec registration
  registerCompressedDicomDecoder("1.2.840.10008.1.2.4.80", (_frag, info) => {
    return new Uint8Array(info.rows * info.cols).fill(99);
  });
  const customSyntaxRaw = buildEncapsulatedCompressedDicom({
    transferSyntax: "1.2.840.10008.1.2.4.80",
    rows: 8,
    cols: 8,
  });
  const parsedCustom = await readDicomBytes(customSyntaxRaw);
  assert.equal(parsedCustom.decodeStatus, "ok");
  assert.equal(parsedCustom.floatPixels?.[0], 99);
});

test("Sprint 5 Task 1B: Multi-frame DICOM (NumberOfFrames + GridFrameOffsetVector) 3D volume reconstruction and non-volumetric rejection", async () => {
  const rawMf = buildSyntheticMultiFrameDicom({
    numberOfFrames: 6,
    rows: 16,
    cols: 16,
    pixelSpacing: "1.25\\1.25",
    sliceThickness: 3.0,
    spacingBetweenSlices: 3.0,
    originMm: [10, -20, 35],
    orientation: [1, 0, 0, 0, 1, 0],
  });
  const parsedMf = await readDicomBytes(rawMf);
  assert.equal(parsedMf.decodeStatus, "ok");
  assert.equal(parsedMf.multiFrameVolumetricReady, true);
  assert.equal(parsedMf.numberOfFrames, 6);
  assert.equal(parsedMf.frameFloatPixels.length, 6);
  assert.equal(parsedMf.frameSpacingMm, 3.0);
  assert.equal(parsedMf.framePositionsMm.length, 6);
  assert.deepEqual(parsedMf.framePositionsMm[0], [10, -20, 35]);
  assert.deepEqual(parsedMf.framePositionsMm[5], [10, -20, 50]);

  const { slices, pixelsById } = expandMultiFrameDicomToSeries("mf-pelvis", parsedMf);
  assert.equal(slices.length, 6);
  const report = analyzeSeries(slices);
  assert.equal(report.volumeReady, true);
  assert.equal(report.sliceSpacingMm, 3.0);

  const volume = buildVolume(report, pixelsById);
  assert.deepEqual(volume.dims, [16, 16, 6]);
  assert.deepEqual(volume.spacingMm, [1.25, 1.25, 3.0]);
  assert.deepEqual(volume.geometry?.originMm, [10, -20, 35]);
  assert.equal(volume.geometry?.coordinateSystem, "DICOM_LPS");

  // Multi-frame file without inter-frame spatial offsets -> must not be volumeReady
  const rawCine = buildSyntheticMultiFrameDicom({
    numberOfFrames: 4,
    rows: 16,
    cols: 16,
    omitFrameSpacing: true,
  });
  const parsedCine = await readDicomBytes(rawCine);
  assert.equal(parsedCine.multiFrameVolumetricReady, false);
  const expandedCine = expandMultiFrameDicomToSeries("cine", parsedCine);
  const cineReport = analyzeSeries(expandedCine.slices);
  assert.equal(cineReport.volumeReady, false);
  assert.throws(() => buildVolume(cineReport, expandedCine.pixelsById), /Series is not volume-ready/);
});

test("Sprint 5 Task 1C: Series consistency validation catches duplicate SOP instances, mixed transfer syntax, mixed patient position, missing slices, and irregular spacing", async () => {
  const s1 = await readDicomBytes(
    buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      sopInstanceUid: "1.2.826.0.1.3680043.10.543.dup",
      seriesUid: "1.2.826.0.1.3680043.10.543.seriesA",
      instanceNumber: 1,
      imagePosition: "0\\0\\0",
      patientPosition: "HFS",
    }),
  );
  const s2 = await readDicomBytes(
    buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      sopInstanceUid: "1.2.826.0.1.3680043.10.543.dup", // duplicate SOP UID!
      seriesUid: "1.2.826.0.1.3680043.10.543.seriesA",
      instanceNumber: 2,
      imagePosition: "0\\0\\3",
      patientPosition: "FFS", // conflicting PatientPosition!
    }),
  );
  const s3 = await readDicomBytes(
    buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      sopInstanceUid: "1.2.826.0.1.3680043.10.543.s3",
      seriesUid: "1.2.826.0.1.3680043.10.543.seriesA",
      instanceNumber: 3,
      imagePosition: "0\\0\\6",
      patientPosition: "HFS",
    }),
  );
  const s4 = await readDicomBytes(
    buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      sopInstanceUid: "1.2.826.0.1.3680043.10.543.s4",
      seriesUid: "1.2.826.0.1.3680043.10.543.seriesA",
      instanceNumber: 4,
      imagePosition: "0\\0\\15", // 9mm gap vs 3mm median step -> missing slices!
      patientPosition: "HFS",
    }),
  );

  const g1 = geometryFromMetadata("s1", s1.metadata, s1.rows, s1.cols);
  const g2 = {
    ...geometryFromMetadata("s2", s2.metadata, s2.rows, s2.cols),
    transferSyntax: "1.2.840.10008.1.2", // mixed transfer syntax
  };
  const g3 = geometryFromMetadata("s3", s3.metadata, s3.rows, s3.cols);
  const g4 = geometryFromMetadata("s4", s4.metadata, s4.rows, s4.cols);

  const report = analyzeSeries([g1, g2, g3, g4]);
  assert.equal(report.volumeReady, false);
  const codes = report.issues.map((i) => i.code);
  assert.ok(codes.includes("duplicate_sop_instance"));
  assert.ok(codes.includes("mixed_transfer_syntax"));
  assert.ok(codes.includes("mixed_patient_position"));
  assert.ok(codes.includes("missing_slices"));
});

test("Sprint 5 Task 1D & 1E: End-to-end DICOM LPS patient-space geometry preservation through volume build, preprocessing, segmentation, isosurface, and STL/OBJ export", async () => {
  const slices = [];
  const pixelsById = new Map<string, Float32Array>();

  for (let z = 0; z < 8; z++) {
    const raw = buildSyntheticMrDicom({
      rows: 24,
      cols: 24,
      sopInstanceUid: `1.2.826.0.1.3680043.10.543.geom.${z + 1}`,
      seriesUid: "1.2.826.0.1.3680043.10.543.geom.series",
      instanceNumber: z + 1,
      imagePosition: `-30.5\\-45.25\\${(15.0 + z * 2.5).toFixed(2)}`,
      imageOrientation: "1\\0\\0\\0\\1\\0",
      pixelSpacing: "1.5\\1.5",
      sliceThickness: "2.5",
      patientPosition: "HFS",
    });
    const parsed = await readDicomBytes(raw);
    const id = `slice-${z + 1}`;
    slices.push(geometryFromMetadata(id, parsed.metadata, parsed.rows, parsed.cols));
    pixelsById.set(id, parsed.floatPixels!);
  }

  const report = analyzeSeries(slices);
  assert.equal(report.volumeReady, true);

  const volume = buildVolume(report, pixelsById);
  assert.deepEqual(volume.geometry?.originMm, [-30.5, -45.25, 15.0]);
  assert.deepEqual(volume.spacingMm, [1.5, 1.5, 2.5]);
  assert.equal(volume.geometry?.patientPosition, "HFS");
  assert.equal(volume.geometry?.coordinateSystem, "DICOM_LPS");

  // Preprocessing preserves geometry
  const prepResult = normalisePercentile(volume);
  assert.deepEqual(prepResult.volume.geometry, volume.geometry);

  // Segmentation preserves geometry
  const seg = segmentFromSeed(prepResult.volume, { seed: [12, 12, 4] });
  assert.deepEqual(seg.mask.geometry, volume.geometry);

  // Mesh extraction + patient-space LPS transformation & export validation
  const localMesh = surfaceFromMask(seg.mask);
  assert.ok(localMesh.indices.length > 0);

  const patientMesh = transformMeshToPatientSpace(localMesh, volume.geometry!);
  assert.equal(patientMesh.coordinateSpace, "patient_lps_mm");

  const stlBytes = toPatientSpaceBinaryStl(localMesh, volume.geometry!);
  const stlValidation = validateExportedMeshGeometry(localMesh, stlBytes, volume.geometry!);
  assert.equal(stlValidation.valid, true);
  assert.equal(stlValidation.format, "stl");
  assert.ok(stlValidation.maxCoordinateErrorMm <= 1e-2);

  const objText = toPatientSpaceObj(localMesh, volume.geometry!, "uterine_fibroid");
  assert.match(objText, /space: DICOM_LPS_mm/);
  const objValidation = validateExportedMeshGeometry(localMesh, objText, volume.geometry!);
  assert.equal(objValidation.valid, true);
  assert.equal(objValidation.format, "obj");
  assert.ok(objValidation.maxCoordinateErrorMm <= 1e-2);
});
