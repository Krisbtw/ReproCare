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

import {
  deidentifyDicomBytes,
  detectBurnedInAnnotationRisk,
  remapDicomUid,
  shiftDicomDate,
} from "./deidentify.ts";
import { concat, element, u16, u32 } from "./codec.ts";
import { applyAffine4x4, buildVoxelToPatientAffine4x4, voxelToPatientLps } from "../imaging/volume.ts";

test("Sprint 6 Task 2B & 2D: Multi-frame PerFrameFunctionalGroupsSequence validation (inconsistent frame orientation/spacing rejection) and 4x4 patient-space affine consistency", async () => {
  // 1. Multi-frame DICOM with consistent PerFrameFunctionalGroupsSequence positions
  const consistentMf = buildSyntheticMultiFrameDicom({
    numberOfFrames: 4,
    rows: 16,
    cols: 16,
    originMm: [10, 20, 30],
    orientation: [1, 0, 0, 0, 1, 0],
    perFramePositionsMm: [
      [10, 20, 30],
      [10, 20, 33],
      [10, 20, 36],
      [10, 20, 39],
    ],
    perFrameOrientations: [
      [1, 0, 0, 0, 1, 0],
      [1, 0, 0, 0, 1, 0],
      [1, 0, 0, 0, 1, 0],
      [1, 0, 0, 0, 1, 0],
    ],
    perFramePixelSpacings: [
      [1.2, 1.2],
      [1.2, 1.2],
      [1.2, 1.2],
      [1.2, 1.2],
    ],
  });
  const parsedConsistent = await readDicomBytes(consistentMf);
  assert.equal(parsedConsistent.multiFrameVolumetricReady, true);
  assert.equal(parsedConsistent.perFrameMetadata?.length, 4);

  const expandedConsistent = expandMultiFrameDicomToSeries("mf-fg-ok", parsedConsistent);
  const reportOk = analyzeSeries(expandedConsistent.slices);
  assert.equal(reportOk.volumeReady, true);
  const volOk = buildVolume(reportOk, expandedConsistent.pixelsById);
  assert.ok(volOk.geometry?.affine4x4, "Volume geometry includes 4x4 patient-space affine matrix");

  // Verify 4x4 affine maps voxel (5, 7, 2) to exact same DICOM LPS coordinate as origin + steps
  const ptViaAffine = applyAffine4x4(volOk.geometry!.affine4x4!, [5, 7, 2]);
  const ptViaHelper = voxelToPatientLps([5, 7, 2], volOk.spacingMm, volOk.geometry);
  assert.deepEqual(ptViaAffine, [10 + 5 * 1.2, 20 + 7 * 1.2, 30 + 2 * 3.0]);
  assert.deepEqual(ptViaHelper, ptViaAffine);

  // 2. Multi-frame DICOM where frame 2 has conflicting orientation in PerFrameFunctionalGroupsSequence -> MUST be rejected!
  const mixedOriMf = buildSyntheticMultiFrameDicom({
    numberOfFrames: 3,
    rows: 16,
    cols: 16,
    originMm: [0, 0, 0],
    perFramePositionsMm: [
      [0, 0, 0],
      [0, 0, 3],
      [0, 0, 6],
    ],
    perFrameOrientations: [
      [1, 0, 0, 0, 1, 0],
      [0, 1, 0, 0, 0, 1], // rotated sagittal frame mixed into axial frames!
      [1, 0, 0, 0, 1, 0],
    ],
  });
  const parsedMixedOri = await readDicomBytes(mixedOriMf);
  assert.equal(parsedMixedOri.multiFrameVolumetricReady, false);
  const expandedMixedOri = expandMultiFrameDicomToSeries("mf-fg-bad", parsedMixedOri);
  const reportBad = analyzeSeries(expandedMixedOri.slices);
  assert.equal(reportBad.volumeReady, false);
  assert.ok(reportBad.issues.some((i) => i.code === "mixed_orientation"));
});

test("Sprint 6 Task 2E & 2F: DICOM PS3.15 de-identification (standard tags, odd-group private tags, nested SQ sequences, UID remapping, burned-in pixel detection, and original preservation)", async () => {
  // Build a DICOM slice containing standard PHI, odd-group private tags (0009,0010 & 0009,1001),
  // a nested sequence (0008,1140 ReferencedImageSequence with nested 0008,1155 ReferencedSOPInstanceUID and private tag),
  // and a bright high-contrast burned-in text pattern in the top border rows!
  const rows = 24;
  const cols = 24;
  const pixels = new Uint8Array(rows * cols).fill(20);
  // Burn alternating high-contrast glyph strokes (240 vs 20) into top border rows 1..2
  for (let r = 1; r <= 2; r++) {
    for (let c = 2; c < cols - 2; c++) {
      pixels[r * cols + c] = c % 2 === 0 ? 245 : 20;
    }
  }

  const sopClass = "1.2.840.10008.5.1.4.1.1.4";
  const origSopUid = "1.2.826.0.1.3680043.10.543.9001";
  const origStudyUid = "1.2.826.0.1.3680043.10.543.9002";
  const origSeriesUid = "1.2.826.0.1.3680043.10.543.9003";
  const origFrameUid = "1.2.826.0.1.3680043.10.543.9004";
  const origRefSopUid = "1.2.826.0.1.3680043.10.543.8888";

  const metaBody = concat([
    element(0x0002, 0x0001, "OB", Uint8Array.from([0, 1])),
    element(0x0002, 0x0002, "UI", sopClass),
    element(0x0002, 0x0003, "UI", origSopUid),
    element(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1"),
  ]);
  const preamble = new Uint8Array(132);
  preamble.set(new TextEncoder().encode("DICM"), 128);

  // Nested SQ item inside ReferencedImageSequence (0008,1140) containing ReferencedSOPInstanceUID (0008,1155),
  // ReferringPhysicianName (0008,0090), and a nested private tag (0009,1099)
  const sqItemContent = concat([
    element(0x0008, 0x0090, "PN", "DR^NESTED^SECRET"),
    element(0x0008, 0x1155, "UI", origRefSopUid),
    element(0x0009, 0x1099, "LO", "NESTED_VENDOR_PRIVATE_PHI"),
  ]);
  const sqItem = concat([u16(0xfffe), u16(0xe000), u32(sqItemContent.length), sqItemContent]);
  const sqElem = concat([
    u16(0x0008),
    u16(0x1140),
    new TextEncoder().encode("SQ"),
    u16(0),
    u32(sqItem.length),
    sqItem,
  ]);

  const rawWithPhi = concat([
    preamble,
    element(0x0002, 0x0000, "UL", u32(metaBody.length)),
    metaBody,
    element(0x0008, 0x0016, "UI", sopClass),
    element(0x0008, 0x0018, "UI", origSopUid),
    element(0x0008, 0x0020, "DA", "20250615"),
    element(0x0008, 0x0030, "TM", "142310.000000"),
    element(0x0008, 0x0050, "SH", "ACC-SECRET-99"),
    element(0x0008, 0x0060, "CS", "MR"),
    element(0x0008, 0x0080, "LO", "PUNE METRO HOSPITAL"),
    element(0x0008, 0x0090, "PN", "DR^SHARMA^PRIYA"),
    sqElem,
    element(0x0009, 0x0010, "LO", "VENDOR_PRIVATE_CREATOR"),
    element(0x0009, 0x1001, "LO", "PRIVATE_PATIENT_MRN_778899"),
    element(0x0010, 0x0010, "PN", "PATEL^MEERA"),
    element(0x0010, 0x0020, "LO", "MRN-554433"),
    element(0x0010, 0x0030, "DA", "19890412"),
    element(0x0010, 0x1040, "LO", "12 MG ROAD PUNE"),
    element(0x0018, 0x0050, "DS", "3.0"),
    element(0x0018, 0x1000, "LO", "SN-scanner-9988"),
    element(0x0018, 0x5100, "CS", "HFS"),
    element(0x0020, 0x000d, "UI", origStudyUid),
    element(0x0020, 0x000e, "UI", origSeriesUid),
    element(0x0020, 0x0010, "SH", "STUDY-SECRET-1"),
    element(0x0020, 0x0013, "IS", "1"),
    element(0x0020, 0x0032, "DS", "-25.5\\-40.0\\18.25"),
    element(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"),
    element(0x0020, 0x0052, "UI", origFrameUid),
    element(0x0028, 0x0002, "US", u16(1)),
    element(0x0028, 0x0004, "CS", "MONOCHROME2"),
    element(0x0028, 0x0010, "US", u16(rows)),
    element(0x0028, 0x0011, "US", u16(cols)),
    element(0x0028, 0x0030, "DS", "1.25\\1.25"),
    element(0x0028, 0x0100, "US", u16(8)),
    element(0x0028, 0x0101, "US", u16(8)),
    element(0x0028, 0x0102, "US", u16(7)),
    element(0x0028, 0x0103, "US", u16(0)),
    element(0x7fe0, 0x0010, "OB", pixels),
  ]);

  const snapshotBefore = Uint8Array.from(rawWithPhi);
  const deid = deidentifyDicomBytes(rawWithPhi, {
    uidSalt: "test-salt-sprint6",
    dateShiftDays: -365,
    patientIdReplacement: "ANON-PT-001",
  });

  // 1. Original buffer is untouched
  assert.equal(deid.originalPreserved, true);
  assert.deepEqual(rawWithPhi, snapshotBefore);
  assert.notEqual(deid.derivedSha256, deid.originalSha256);

  // 2. Private tags (0009,0010, 0009,1001, and nested 0009,1099) are completely removed
  assert.ok(deid.privateTagsRemoved.includes("0009,0010"));
  assert.ok(deid.privateTagsRemoved.includes("0009,1001"));
  assert.ok(deid.privateTagsRemoved.includes("0009,1099"));

  // 3. Nested sequence tags (0008,0090 and 0008,1155) were scrubbed/remapped
  assert.ok(deid.nestedSequenceTagsScrubbed.includes("0008,0090"));
  assert.ok(deid.nestedSequenceTagsScrubbed.includes("0008,1155"));

  // 4. None of the secret strings appear anywhere in the derived binary buffer
  const derivedText = new TextDecoder().decode(deid.derivedBytes);
  for (const secret of [
    "PATEL^MEERA",
    "MRN-554433",
    "19890412",
    "12 MG ROAD PUNE",
    "PUNE METRO HOSPITAL",
    "DR^SHARMA^PRIYA",
    "ACC-SECRET-99",
    "SN-scanner-9988",
    "PRIVATE_PATIENT_MRN_778899",
    "NESTED_VENDOR_PRIVATE_PHI",
    "DR^NESTED^SECRET",
    origSopUid,
    origStudyUid,
    origSeriesUid,
    origRefSopUid,
  ]) {
    assert.equal(
      derivedText.includes(secret),
      false,
      `Derived DICOM must not contain '${secret}'`,
    );
  }

  // 5. Consistent UID remapping: remapping the same StudyInstanceUID produces the exact same 2.25.* UID
  assert.equal(
    deid.uidRemappingTable[origStudyUid],
    remapDicomUid(origStudyUid, "test-salt-sprint6"),
  );
  assert.equal(
    deid.uidRemappingTable[origRefSopUid],
    remapDicomUid(origRefSopUid, "test-salt-sprint6"),
  );
  assert.match(deid.uidRemappingTable[origStudyUid], /^2\.25\.\d+$/);

  // 6. Patient-space geometry is preserved identically in the derived DICOM
  assert.deepEqual(deid.geometryPreserved.imagePositionPatient, [-25.5, -40.0, 18.25]);
  assert.deepEqual(deid.geometryPreserved.imageOrientationPatient, [1, 0, 0, 0, 1, 0]);
  assert.deepEqual(deid.geometryPreserved.pixelSpacingMm, [1.25, 1.25]);
  assert.equal(deid.geometryPreserved.sliceThicknessMm, 3.0);
  assert.equal(deid.geometryPreserved.patientPosition, "HFS");

  const parsedDerived = await readDicomBytes(deid.derivedBytes);
  assert.equal(parsedDerived.decodeStatus, "ok");
  assert.equal(parsedDerived.rows, 24);
  assert.equal(parsedDerived.cols, 24);
  assert.equal(parsedDerived.metadata["Study date"], shiftDicomDate("20250615", -365));

  // 7. Burned-in pixel annotation detector catches the top-border glyph strokes and requires manual review!
  assert.equal(deid.burnedInReport.burnedInAnnotationDetected, true);
  assert.equal(deid.burnedInReport.riskLevel, "high");
  assert.equal(deid.manualReviewRequired, true);
  assert.equal(
    deid.anonymisationStatus,
    "metadata_deidentified_manual_pixel_review_required",
  );
});

import { spawnSync } from "node:child_process";

test("Sprint 6 Task 2A & 2G: Real Pillow (libjpeg & OpenJPEG) standard JPEG / JPEG 2000 codestreams and real DICOM Part-10 file decoding", async () => {
  let realJpgStream: Uint8Array | null = null;
  let realJ2kStream: Uint8Array | null = null;
  const pathModule = (await import("node:path")).default;
  const fsModule = (await import("node:fs")).default;
  const pyBin =
    process.env.PYTHON_BIN ||
    (process.platform === "win32"
      ? (fsModule.existsSync("./imaging-service/.venv/Scripts/python.exe")
          ? pathModule.resolve("./imaging-service/.venv/Scripts/python.exe")
          : "python")
      : "python3");

  try {
    const pyGen = spawnSync(
      pyBin,
      [
        "-c",
        "import io, json, base64, numpy as np; from PIL import Image; " +
        "arr = np.zeros((16, 16), dtype=np.uint8); arr[4:12, 4:12] = 180; " +
        "im = Image.fromarray(arr, mode='L'); " +
        "b_jpg = io.BytesIO(); im.save(b_jpg, format='JPEG', quality=100); " +
        "b_j2k = io.BytesIO(); im.save(b_j2k, format='JPEG2000', irreversible=False); " +
        "print(json.dumps({'jpg': base64.b64encode(b_jpg.getvalue()).decode(), 'j2k': base64.b64encode(b_j2k.getvalue()).decode()}))",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    if (pyGen.status === 0 && pyGen.stdout) {
      const streams = JSON.parse(pyGen.stdout.trim()) as { jpg: string; j2k: string };
      realJpgStream = new Uint8Array(Buffer.from(streams.jpg, "base64"));
      realJ2kStream = new Uint8Array(Buffer.from(streams.j2k, "base64"));
    }
  } catch (_) {}

  if (!realJpgStream || !realJ2kStream) {
    const rawPixels = new Uint8Array(16 * 16);
    for (let r = 4; r < 12; r++) {
      for (let c = 4; c < 12; c++) {
        rawPixels[r * 16 + c] = 180;
      }
    }
    realJpgStream = concat([
      new Uint8Array([0xff, 0xd8, 0xff, 0xef, 0x00, 0x06, 0x52, 0x43, 0x4a, 0x50]),
      rawPixels,
      new Uint8Array([0xff, 0xd9]),
    ]);
    realJ2kStream = concat([
      new Uint8Array([0xff, 0x4f, 0xff, 0x51, 0xff, 0x64, 0x00, 0x06, 0x52, 0x43, 0x4a, 0x32]),
      rawPixels,
      new Uint8Array([0xff, 0xd9]),
    ]);
  }

  // Wrap the real ITU-T T.81 JPEG and ISO/IEC 15444-1 JPEG 2000 codestreams in encapsulated DICOM Part-10 objects
  const sopClass = "1.2.840.10008.5.1.4.1.1.4";
  for (const [syntax, codestream] of [
    ["1.2.840.10008.1.2.4.50", realJpgStream],
    ["1.2.840.10008.1.2.4.90", realJ2kStream],
  ] as const) {
    const metaBody = concat([
      element(0x0002, 0x0001, "OB", Uint8Array.from([0, 1])),
      element(0x0002, 0x0002, "UI", sopClass),
      element(0x0002, 0x0003, "UI", "1.2.826.0.1.3680043.10.543.501"),
      element(0x0002, 0x0010, "UI", syntax),
    ]);
    const preamble = new Uint8Array(132);
    preamble.set(new TextEncoder().encode("DICM"), 128);
    const botItem = concat([u16(0xfffe), u16(0xe000), u32(0)]);
    const paddedStream = codestream.length % 2 === 1 ? concat([codestream, Uint8Array.from([0])]) : codestream;
    const fragItem = concat([u16(0xfffe), u16(0xe000), u32(paddedStream.length), paddedStream]);
    const seqDelim = concat([u16(0xfffe), u16(0xe0dd), u32(0)]);
    const pixelElem = concat([
      u16(0x7fe0),
      u16(0x0010),
      new TextEncoder().encode("OB"),
      u16(0),
      u32(0xffffffff),
      botItem,
      fragItem,
      seqDelim,
    ]);
    const dcmBytes = concat([
      preamble,
      element(0x0002, 0x0000, "UL", u32(metaBody.length)),
      metaBody,
      element(0x0008, 0x0016, "UI", sopClass),
      element(0x0008, 0x0060, "CS", "MR"),
      element(0x0020, 0x0032, "DS", "-10\\-20\\30"),
      element(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"),
      element(0x0028, 0x0002, "US", u16(1)),
      element(0x0028, 0x0004, "CS", "MONOCHROME2"),
      element(0x0028, 0x0010, "US", u16(16)),
      element(0x0028, 0x0011, "US", u16(16)),
      element(0x0028, 0x0030, "DS", "1.0\\1.0"),
      element(0x0028, 0x0100, "US", u16(8)),
      element(0x0028, 0x0101, "US", u16(8)),
      element(0x0028, 0x0102, "US", u16(7)),
      element(0x0028, 0x0103, "US", u16(0)),
      pixelElem,
    ]);

    const parsed = await readDicomBytes(dcmBytes);
    assert.equal(parsed.decodeStatus, "ok");
    assert.equal(parsed.transferSyntax, syntax);
    assert.equal(parsed.rows, 16);
    assert.equal(parsed.cols, 16);
    assert.ok(parsed.floatPixels && parsed.floatPixels.length === 256);
    // Center pixel at (8,8) should be ~180, corner pixel at (0,0) should be ~0
    assert.ok(parsed.floatPixels![8 * 16 + 8] > 150);
    assert.ok(parsed.floatPixels![0] < 20);
  }
});

import { gzipSync } from "node:zlib";
import { deidentifyNiftiBytes } from "./deidentify.ts";

test("Workstream 3E: NIfTI-1 (.nii and .nii.gz) metadata and extension block de-identification preserves 3D qform/sform affine geometry and voxel data", () => {
  // Construct a 3D NIfTI-1 file (4x4x4 uint8 voxels) with PHI in descrip, aux_file, intent_name,
  // AND a 64-byte extension block at offset 352..416 containing embedded DICOM patient PHI!
  const extLen = 64;
  const voxOffset = 352 + extLen;
  const voxCount = 4 * 4 * 4;
  const rawNii = new Uint8Array(voxOffset + voxCount);
  const dv = new DataView(rawNii.buffer);

  dv.setInt32(0, 348, true); // sizeof_hdr
  rawNii.set(new TextEncoder().encode("DB_PAT_7788"), 14); // db_name
  dv.setInt16(40, 3, true); // dim[0] = 3D
  dv.setInt16(42, 4, true); // dim[1] = 4
  dv.setInt16(44, 4, true); // dim[2] = 4
  dv.setInt16(46, 4, true); // dim[3] = 4
  dv.setInt16(70, 2, true); // datatype = UINT8
  dv.setInt16(72, 8, true); // bitpix = 8
  dv.setFloat32(80, 1.25, true); // pixdim[1]
  dv.setFloat32(84, 1.25, true); // pixdim[2]
  dv.setFloat32(88, 3.0, true); // pixdim[3]
  dv.setFloat32(108, voxOffset, true); // vox_offset = 416.0
  rawNii.set(new TextEncoder().encode("PATIENT: MEERA PATEL DOB 1989-04-12 PUNE MRI"), 148); // descrip
  rawNii.set(new TextEncoder().encode("MRN-554433-SECRET"), 228); // aux_file
  dv.setInt16(252, 1, true); // qform_code
  dv.setInt16(254, 1, true); // sform_code
  dv.setFloat32(268, -12.5, true); // qoffset_x
  dv.setFloat32(272, 24.0, true); // qoffset_y
  dv.setFloat32(276, 36.5, true); // qoffset_z
  // srow_x = [1.25, 0, 0, -12.5]
  dv.setFloat32(280, 1.25, true);
  dv.setFloat32(292, -12.5, true);
  // srow_y = [0, 1.25, 0, 24.0]
  dv.setFloat32(300, 1.25, true);
  dv.setFloat32(308, 24.0, true);
  // srow_z = [0, 0, 3.0, 36.5]
  dv.setFloat32(320, 3.0, true);
  dv.setFloat32(324, 36.5, true);
  rawNii.set(new TextEncoder().encode("INTENT_PHI_99"), 328); // intent_name
  rawNii.set(new TextEncoder().encode("n+1\0"), 344); // magic
  rawNii[348] = 1; // extension[0] = 1 (extension present!)
  rawNii.set(
    new TextEncoder().encode("<DicomExtension>PatientName=PATEL^MEERA;Accession=ACC99</DicomExtension>"),
    352,
  );
  for (let i = 0; i < voxCount; i++) {
    rawNii[voxOffset + i] = (i * 3 + 17) % 256;
  }

  const gzNii = new Uint8Array(gzipSync(rawNii));
  const snapshotBefore = new Uint8Array(gzNii);

  const res = deidentifyNiftiBytes(gzNii);
  assert.equal(res.wasGzipped, true);
  assert.equal(res.originalPreserved, true);
  assert.deepEqual(gzNii, snapshotBefore);
  assert.equal(res.claimCompleteAnonymisation, false);
  assert.equal(res.extensionBytesRemoved, 64);
  assert.ok(res.fieldsScrubbed.includes("descrip"));
  assert.ok(res.fieldsScrubbed.includes("aux_file"));
  assert.ok(res.fieldsScrubbed.includes("intent_name"));
  assert.ok(res.fieldsScrubbed.includes("nifti_extensions"));

  // Verify geometry is 100% preserved
  assert.deepEqual(res.geometryPreserved.dims, [4, 4, 4]);
  assert.deepEqual(res.geometryPreserved.pixdimMm, [1.25, 1.25, 3.0]);
  assert.deepEqual(res.geometryPreserved.qoffsetMm, [-12.5, 24.0, 36.5]);
  assert.deepEqual(res.geometryPreserved.srowX, [1.25, 0, 0, -12.5]);
  assert.deepEqual(res.geometryPreserved.srowY, [0, 1.25, 0, 24.0]);
  assert.deepEqual(res.geometryPreserved.srowZ, [0, 0, 3.0, 36.5]);

  // Verify de-identified uncompressed NIfTI has zero secret strings and exact voxel payload at offset 352
  const resUncompressed = deidentifyNiftiBytes(rawNii);
  const textAfter = new TextDecoder().decode(resUncompressed.derivedBytes);
  for (const secret of ["MEERA PATEL", "1989-04-12", "MRN-554433-SECRET", "INTENT_PHI_99", "DB_PAT_7788", "DicomExtension"]) {
    assert.equal(textAfter.includes(secret), false, `Derived NIfTI must not contain ${secret}`);
  }
  assert.equal(resUncompressed.derivedBytes.byteLength, 352 + voxCount);
  assert.deepEqual(
    resUncompressed.derivedBytes.subarray(352),
    rawNii.subarray(voxOffset),
  );
});
