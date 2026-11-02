import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { ellipsoidMask, type Vec3 } from "../imaging/volume.ts";
import {
  computePhysicalVolume,
  isValidSpacingMm,
  measureMask,
} from "../imaging/metrics.ts";
import {
  createPatientFrame,
  imageMmToPatient,
  patientToImageMm,
  validatePatientFrame,
  voxelToPatient,
} from "../imaging/patient-coords.ts";
import {
  createReproTraceConfig,
  DEFAULT_REPROTRACE_THRESHOLDS,
  evaluateLongitudinalChange,
} from "./params.ts";
import {
  attributeLongitudinalChange,
  calculateGrowthRate,
  calculateTrend,
  evaluateLongitudinalAlert,
  validateAndOrderChronology,
  type ObservationPoint,
} from "./trends.ts";
import {
  calculateSpatialDistance,
  computeShapeSimilarity,
  matchFindings,
  type FindingItem,
  type RegistrationResultTransform,
} from "./matching.ts";
import {
  matchChronology,
  matchStudies,
  sameMethodChange,
  type Measure,
  type RegistrationLookupEntry,
  type Snap,
} from "./engine.ts";
import {
  executeDecideCorrespondence,
  executeGetLongitudinalComparisonProvenance,
  executeSaveVolumeRegistration,
  recomputeReproTrace,
} from "../clinic/server.ts";

test("Task 2A: Physical volume and centroid calculations with known anisotropic voxel spacing and orientations", () => {
  // 1. Validate spacing guardrails
  assert.equal(isValidSpacingMm([0.8, 0.8, 4.0]), true);
  assert.equal(isValidSpacingMm([0, 0.8, 4.0]), false);
  assert.equal(isValidSpacingMm([-1, 0.8, 4.0]), false);
  assert.throws(() => computePhysicalVolume(100, [0, 1, 1]), /Invalid or missing voxel spacing/);

  // 2. Same physical ellipsoid rasterized at two different anisotropic voxel spacings must yield consistent physical volume (mm³) and patient LPS centroid, despite very different raw voxel counts!
  const centerMm: Vec3 = [30, 30, 30];
  const radiiMm: Vec3 = [12, 10, 14];

  const maskFine = ellipsoidMask([60, 60, 30], [1.0, 1.0, 2.0], radiiMm, centerMm);
  const maskCoarse = ellipsoidMask([30, 30, 15], [2.0, 2.0, 4.0], radiiMm, centerMm);

  const origin: Vec3 = [-100, -120, 40];
  const axialOrientation: [number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0];
  const frameFine = createPatientFrame(origin, axialOrientation, [1.0, 1.0, 2.0]);
  const frameCoarse = createPatientFrame(origin, axialOrientation, [2.0, 2.0, 4.0]);

  assert.equal(validatePatientFrame(frameFine).valid, true);

  const mFine = measureMask(maskFine, frameFine);
  const mCoarse = measureMask(maskCoarse, frameCoarse);

  // Raw voxel counts differ by ~8x, but physical volume (mm³) agrees within discretization uncertainty!
  assert.ok(mFine.voxelCount > mCoarse.voxelCount * 6);
  const relVolDiff = Math.abs((mFine.volumeMm3 ?? 0) - (mCoarse.volumeMm3 ?? 0)) / (mFine.volumeMm3 ?? 1);
  assert.ok(relVolDiff < 0.08, `Expected physical volume agreement within 8%, got ${(relVolDiff * 100).toFixed(1)}%`);
  assert.equal(mFine.frame, "dicom_lps");
  assert.ok(mFine.patientCentroidMm);
  assert.ok(mCoarse.patientCentroidMm);

  // Patient LPS centroid for centerMm [30, 30, 30] + origin [-100, -120, 40] = [-70, -90, 70]
  assert.ok(Math.abs(mFine.patientCentroidMm![0] - -70) < 1.0);
  assert.ok(Math.abs(mFine.patientCentroidMm![1] - -90) < 1.0);
  assert.ok(Math.abs(mFine.patientCentroidMm![2] - 70) < 1.5);
  assert.ok((mFine.uncertaintyMm3 ?? 0) > 0);
  assert.ok((mFine.uncertaintyMm ?? 0) > 0);

  // 3. Sagittal orientation [0, 1, 0, 0, 0, -1] coordinate round-trip
  const sagFrame = createPatientFrame([25, -80, 110], [0, 1, 0, 0, 0, -1], [0.9, 0.9, 3.5]);
  const ptLps = voxelToPatient([10, 20, 5], sagFrame);
  const imgMm = patientToImageMm(ptLps, sagFrame);
  assert.ok(Math.abs(imgMm[0] - 9.0) < 1e-5);
  assert.ok(Math.abs(imgMm[1] - 18.0) < 1e-5);
  assert.ok(Math.abs(imgMm[2] - 17.5) < 1e-5);
  assert.deepEqual(
    imageMmToPatient(imgMm, sagFrame).map((v) => Number(v.toFixed(4))),
    ptLps.map((v) => Number(v.toFixed(4))),
  );
});

test("Task 2B: Chronological sorting, missing/invalid examination dates, and duplicate examination handling", () => {
  // 1. Out-of-order input points must be sorted strictly by actual examination date
  const ordered: ObservationPoint[] = [
    { studyId: "s1", date: "2025-01-15", volumeMm3: 10000 },
    { studyId: "s2", date: "2025-04-15", volumeMm3: 13000 },
    { studyId: "s3", date: "2025-07-15", volumeMm3: 16000 },
  ];
  const shuffled: ObservationPoint[] = [ordered[2], ordered[0], ordered[1]];

  const rateOrdered = calculateGrowthRate(ordered);
  const rateShuffled = calculateGrowthRate(shuffled);
  assert.equal(rateOrdered, rateShuffled);
  assert.ok(rateOrdered > 900 && rateOrdered < 1100);

  // 2. Trend direction on out-of-order dated points must use chronological order, not array order
  assert.equal(calculateTrend(shuffled), 1);
  assert.equal(
    calculateTrend([
      { studyId: "s_late", date: "2025-09-01", volumeMm3: 8000 },
      { studyId: "s_early", date: "2025-01-01", volumeMm3: 14000 },
    ]),
    -1,
  );

  // 3. Missing dates, invalid dates, and duplicate studyIds / duplicate exam dates are flagged and excluded
  const messy: ObservationPoint[] = [
    { studyId: "s2", date: "2025-04-15", volumeMm3: 13000 },
    { studyId: "s_missing", date: "", volumeMm3: 50000 },
    { studyId: "s_invalid", date: "not-a-date", volumeMm3: 99999 },
    { studyId: "s1", date: "2025-01-15", volumeMm3: 10000 },
    { studyId: "s1", date: "2025-01-15", volumeMm3: 10000 }, // duplicate studyId
    { studyId: "s1_repeat", date: "2025-01-15", volumeMm3: 88888 }, // same-day duplicate date
    { studyId: "s3", date: "2025-07-15", volumeMm3: 16000 },
  ];

  const validated = validateAndOrderChronology(messy);
  assert.equal(validated.wasReordered, true);
  assert.equal(validated.hasDuplicateStudies, true);
  assert.equal(validated.hasDuplicateDates, true);
  assert.deepEqual(
    validated.validPoints.map((p) => p.studyId),
    ["s1", "s2", "s3"],
  );
  assert.ok(validated.issues.some((i) => i.code === "missing_date"));
  assert.ok(validated.issues.some((i) => i.code === "invalid_date"));
  assert.ok(validated.issues.some((i) => i.code === "duplicate_study_id"));
  assert.ok(validated.issues.some((i) => i.code === "duplicate_examination_date"));
  assert.equal(calculateGrowthRate(messy), rateOrdered);
});

test("Task 2C: Finding correspondence matches growing lesions at same site and never matches distinct lesions", () => {
  const verifiedReg: RegistrationResultTransform = {
    status: "verified",
    nccScore: 0.94,
    residualMm: 0.9,
    supported: true,
    fixedStudyId: "st1",
    movingStudyId: "st2",
    fixedSeriesId: "ser1",
    movingSeriesId: "ser2",
    transform: {
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  };

  // 1. Growing lesion (+60% volume) at almost identical patient LPS coordinate & same location is matched as likely_same!
  const baselineLesion: FindingItem = {
    id: "f_base",
    anatomicalLabel: "FIGO 4 anterior intramural fibroid",
    laterality: "midline",
    figoType: "4",
    coordinates: { x: 12, y: -15, z: 32 },
    volume: 15000,
    axesMm: [32, 30, 28],
    spacingMm: [0.8, 0.8, 4.0],
    studyUID: "st1",
    seriesUID: "ser1",
  };
  const grownLesion: FindingItem = {
    id: "f_grown",
    anatomicalLabel: "FIGO 4 anterior intramural fibroid",
    laterality: "midline",
    figoType: "4",
    coordinates: { x: 13.2, y: -14.5, z: 33.0 }, // 1.65 mm distance
    volume: 24000, // +60% volume growth!
    axesMm: [37, 35, 33], // proportional 3D aspect ratio
    spacingMm: [0.8, 0.8, 4.0],
    studyUID: "st2",
    seriesUID: "ser2",
  };

  const growthMatch = matchFindings(baselineLesion, grownLesion, verifiedReg);
  assert.equal(growthMatch.type, "likely_same");
  assert.equal(growthMatch.outcome, "probable_match_review_required");
  assert.equal(growthMatch.attributionCategory, "genuine_anatomical_change");
  assert.ok(growthMatch.shapeSimilarity > 0.9);

  // 2. Clinician confirmation upgrades outcome to confirmed_match
  const confirmedMatch = matchFindings(baselineLesion, grownLesion, verifiedReg, {
    clinicianDecision: "accept",
  });
  assert.equal(confirmedMatch.type, "confirmed_match");
  assert.equal(confirmedMatch.outcome, "confirmed_match");
  assert.equal(confirmedMatch.provisional, false);

  // 3. Two distinct lesions (anterior vs posterior or left vs right or separated by 45 mm) are NEVER matched as likely_same
  const distinctPosteriorLesion: FindingItem = {
    id: "f_post",
    anatomicalLabel: "FIGO 6 posterior subserosal fibroid",
    laterality: "right",
    figoType: "6",
    coordinates: { x: 14, y: 28, z: 30 }, // 43 mm away and posterior wall
    volume: 15200,
    axesMm: [32, 30, 28],
    studyUID: "st2",
    seriesUID: "ser2",
  };

  const nonMatch = matchFindings(baselineLesion, distinctPosteriorLesion, verifiedReg);
  assert.notEqual(nonMatch.type, "likely_same");
  assert.notEqual(nonMatch.type, "confirmed_match");

  // 4. Study-level chronology with out-of-order study groups sorts chronologically and keeps distinct lesions separate
  const s1Snap: Snap = {
    id: "v_2025_01",
    findingId: "f1",
    studyId: "st1",
    seriesId: "ser1",
    date: "2025-01-10",
    organ: "uterus",
    structure: "fibroid",
    locationLabel: "FIGO 4 anterior intramural",
    modality: "MR",
    frame: "dicom_lps",
    centroidMm: [12, -15, 32],
    axesMm: [32, 30, 28],
    longestMm: 32,
    volumeMm3: 14000,
    quality: "adequate",
  };
  const s2SnapSameGrown: Snap = {
    id: "v_2025_07_same",
    findingId: "f1",
    studyId: "st2",
    seriesId: "ser2",
    date: "2025-07-10",
    organ: "uterus",
    structure: "fibroid",
    locationLabel: "FIGO 4 anterior intramural",
    modality: "MR",
    frame: "dicom_lps",
    centroidMm: [13, -14, 33],
    axesMm: [44, 40, 38],
    longestMm: 44,
    volumeMm3: 35000,
    quality: "adequate",
  };
  const s2SnapDistinctNew: Snap = {
    id: "v_2025_07_new",
    findingId: "f2",
    studyId: "st2",
    seriesId: "ser2",
    date: "2025-07-10",
    organ: "uterus",
    structure: "fibroid",
    locationLabel: "FIGO 7 right pedunculated",
    modality: "MR",
    frame: "dicom_lps",
    centroidMm: [55, 22, -10],
    axesMm: [18, 16, 15],
    longestMm: 18,
    volumeMm3: 2200,
    quality: "adequate",
  };

  const regMap = new Map<string, RegistrationLookupEntry>();
  regMap.set("ser1:ser2", {
    registrationId: "reg_12",
    fixedStudyId: "st1",
    movingStudyId: "st2",
    fixedSeriesId: "ser1",
    movingSeriesId: "ser2",
    status: "verified",
    nccScore: 0.93,
    residualMm: 0.8,
    supported: true,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  });

  // Pass studies in reverse chronological order [st2, st1] to verify matchChronology sorts by study date
  const proposals = matchChronology(
    [
      { studyId: "st2", date: "2025-07-10", snaps: [s2SnapSameGrown, s2SnapDistinctNew] },
      { studyId: "st1", date: "2025-01-10", snaps: [s1Snap] },
    ],
    regMap,
  );

  const matchedPair = proposals.find(
    (p) => p.fromId === "v_2025_01" && p.toId === "v_2025_07_same",
  );
  assert.ok(matchedPair, "Growing lesion at same registered coordinate is paired in chronological order");
  assert.equal(matchedPair?.category, "likely_same");
  assert.equal(matchedPair?.outcome, "probable_match_review_required");
  assert.equal(matchedPair?.attributionCategory, "genuine_anatomical_change");
  assert.ok((matchedPair?.growthRateMm3PerMonth ?? 0) > 3000);

  const newLesionProposal = proposals.find((p) => p.toId === "v_2025_07_new");
  assert.equal(newLesionProposal?.fromId, null);
  assert.equal(newLesionProposal?.category, "potentially_new");
  assert.equal(newLesionProposal?.outcome, "possible_new_finding");
});

test("Task 2D & 2F: Distinguishes all 7 longitudinal change vs measurement variation categories and configurable thresholds", () => {
  const customThresholds = createReproTraceConfig({
    rapidGrowthAlertMm3PerMonth: 800,
  });
  assert.equal(customThresholds.isClinicallyValidated, false);
  assert.equal(DEFAULT_REPROTRACE_THRESHOLDS.isClinicallyValidated, false);

  // 1. Within measurement uncertainty
  const withinUnc = attributeLongitudinalChange({
    priorVolumeMm3: 10000,
    currentVolumeMm3: 10350, // +3.5% within ±6% uncertainty
    priorSpacingMm: [0.8, 0.8, 3.0],
    currentSpacingMm: [0.8, 0.8, 3.0],
    priorMethod: "umd_monai_fibroid",
    currentMethod: "umd_monai_fibroid",
    elapsedDays: 180,
  });
  assert.equal(withinUnc.category, "within_measurement_uncertainty");
  assert.equal(withinUnc.alert, false);

  // 2. Genuine anatomical change
  const genuine = attributeLongitudinalChange({
    priorVolumeMm3: 10000,
    currentVolumeMm3: 16500, // +65%
    priorSpacingMm: [0.8, 0.8, 3.0],
    currentSpacingMm: [0.8, 0.8, 3.0],
    priorMethod: "umd_monai_fibroid",
    currentMethod: "umd_monai_fibroid",
    elapsedDays: 180,
  });
  assert.equal(genuine.category, "genuine_anatomical_change");
  assert.equal(genuine.alert, true);

  // 3. Protocol or voxel spacing difference
  const spacingDiff = attributeLongitudinalChange({
    priorVolumeMm3: 10000,
    currentVolumeMm3: 13500,
    priorSpacingMm: [0.8, 0.8, 2.5],
    currentSpacingMm: [1.2, 1.2, 6.0], // slice thickness jumped from 2.5mm to 6.0mm
    priorMethod: "umd_monai_fibroid",
    currentMethod: "umd_monai_fibroid",
    elapsedDays: 180,
  });
  assert.equal(spacingDiff.category, "protocol_or_spacing_difference");

  // 4. Segmentation method difference
  const methodDiff = attributeLongitudinalChange({
    priorVolumeMm3: 10000,
    currentVolumeMm3: 13500,
    priorSpacingMm: [0.8, 0.8, 3.0],
    currentSpacingMm: [0.8, 0.8, 3.0],
    priorMethod: "seeded_region_growing",
    currentMethod: "umd_monai_fibroid",
    elapsedDays: 180,
  });
  assert.equal(methodDiff.category, "segmentation_method_difference");

  // 5. Registration error or uncertainty
  const regError = attributeLongitudinalChange({
    priorVolumeMm3: 10000,
    currentVolumeMm3: 14000,
    registrationQualityScore: 0.25,
    registrationResidualMm: 18.0,
    elapsedDays: 180,
  });
  assert.equal(regError.category, "registration_error_or_uncertainty");

  // 6. Image quality limitation
  const imgQuality = attributeLongitudinalChange({
    priorVolumeMm3: 10000,
    currentVolumeMm3: 14000,
    imageQualityDegraded: true,
    elapsedDays: 180,
  });
  assert.equal(imgQuality.category, "image_quality_limitation");

  // 7. Insufficient evidence (missing volume or sub-48h interval)
  const insuff = attributeLongitudinalChange({
    priorVolumeMm3: null,
    currentVolumeMm3: 14000,
  });
  assert.equal(insuff.category, "insufficient_evidence");
});

test("Task 2E & 2G: Clinician review provenance and preservation of historical findings & decisions across recomputeReproTrace", async () => {
  const pg = new PGlite();
  for (const mig of [
    "0002_anatomybridge.sql",
    "0008_clinician_verification.sql",
    "0009_imaging_and_provenance.sql",
    "0010_sprint1_auth_and_registration.sql",
    "0011_sprint3_imaging_storage_and_reprotrace.sql",
  ]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${mig}`, import.meta.url), "utf8"));
  }

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      "",
    );
    return (await pg.query(text, values as unknown[])).rows;
  }) as unknown as Sql;

  await pg.exec(`
    insert into profiles (user_id, display_name, role) values ('clin_1', 'Dr Provenance', 'clinician');
    insert into clinician_verifications (id, user_id, licence_no, registry, status) values ('cv_1', 'clin_1', 'L-900', 'NMC', 'verified');
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis) values ('pat_1', 'clin_1', 'P-1', 'Longitudinal Patient', 1989, 'fibroids', 'Test');
    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note) values
      ('st_1', 'clin_1', 'pat_1', 'MR', '2025-01-10', 'Baseline MRI', 'A1', 'Seed'),
      ('st_2', 'clin_1', 'pat_1', 'MR', '2025-07-10', '6-Month Follow-up MRI', 'A2', 'Seed');
    insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality) values
      ('ser_1', 'clin_1', 'st_1', 1, 'T2 Sagittal Baseline', 'Sagittal', 3.0, '0.8\\\\0.8', 20, 'adequate'),
      ('ser_2', 'clin_1', 'st_2', 1, 'T2 Sagittal Follow-up', 'Sagittal', 3.0, '0.8\\\\0.8', 20, 'adequate');
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway) values
      ('f_main', 'clin_1', 'pat_1', 'F1', 'fibroid', 'uterus', 'fibroids'),
      ('f_unmatched', 'clin_1', 'pat_1', 'F2', 'fibroid', 'uterus', 'fibroids');
    insert into finding_versions (
      id, user_id, finding_id, version_no, study_id, series_id, observed_on, location_label, figo,
      centroid_mm, axes_mm, longest_mm, volume_mm3, uncertainty_mm3, measurement_basis, frame, segmentation_source, modality, change_reason
    ) values
      ('fv_1', 'clin_1', 'f_main', 1, 'st_1', 'ser_1', '2025-01-10', 'FIGO 4 anterior intramural', '4', '[10, 20, 30]', '[36, 32, 30]', 36, 18095, 950, 'three-axis', 'dicom_lps', 'umd_monai_fibroid', 'MR', 'Baseline'),
      ('fv_unmatched_1', 'clin_1', 'f_unmatched', 1, 'st_1', 'ser_1', '2025-01-10', 'FIGO 6 posterior subserosal', '6', '[-25, -35, 10]', '[26, 24, 22]', 26, 7180, 500, 'three-axis', 'dicom_lps', 'umd_monai_fibroid', 'MR', 'Baseline posterior'),
      ('fv_2', 'clin_1', 'f_main', 2, 'st_2', 'ser_2', '2025-07-10', 'FIGO 4 anterior intramural', '4', '[11, 20, 30]', '[45, 40, 38]', 45, 35814, 1500, 'three-axis', 'dicom_lps', 'umd_monai_fibroid', 'MR', 'Follow-up');
  `);

  await executeSaveVolumeRegistration(sql, "clin_1", {
    patientId: "pat_1",
    fixedSeriesId: "ser_1",
    movingSeriesId: "ser_2",
    nccScore: 0.94,
    residualMm: 0.7,
    matrix: [1, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    status: "verified",
  });

  const corrRows = await sql<{
    id: string;
    from_version_id: string | null;
    to_version_id: string | null;
    category: string;
    attribution_category: string | null;
    growth_rate_mm3_per_month: number | null;
  }>`
    select id, from_version_id, to_version_id, category, attribution_category, growth_rate_mm3_per_month
    from correspondences
    where patient_id = 'pat_1' and active = true
  `;

  // 1. Matched growing lesion has attribution_category = 'genuine_anatomical_change' and positive monthly growth rate
  const matched = corrRows.find(
    (c) => c.from_version_id === "fv_1" && c.to_version_id === "fv_2",
  );
  assert.ok(matched, "fv_1 -> fv_2 correspondence created");
  assert.equal(matched?.category, "likely_same");
  assert.equal(matched?.attribution_category, "genuine_anatomical_change");
  assert.ok((matched?.growth_rate_mm3_per_month ?? 0) > 2500);

  // 2. Unmatched prior finding fv_unmatched_1 is flagged as possible_resolved (provisional), never deleted from finding_versions!
  const possibleResolved = corrRows.find(
    (c) => c.from_version_id === "fv_unmatched_1" && c.to_version_id === null,
  );
  assert.ok(possibleResolved);
  assert.equal(possibleResolved?.category, "possible_resolved");

  // 3. Clinician records decision on matched correspondence, then recomputes ReproTrace -> decision and provenance are preserved
  await executeDecideCorrespondence(sql, "clin_1", {
    correspondenceId: matched!.id,
    decision: "accept",
    note: "Confirmed same anterior intramural fibroid across 6-month interval.",
  });

  await recomputeReproTrace(sql, "clin_1", "pat_1");

  const provenance = await executeGetLongitudinalComparisonProvenance(
    sql,
    "clin_1",
    matched!.id,
  );
  assert.equal(provenance.correspondence.id, matched!.id);
  assert.equal(provenance.sourceExamination?.study?.id, "st_1");
  assert.equal(provenance.targetExamination?.study?.id, "st_2");
  assert.equal(provenance.sourceExamination?.findingVersion.id, "fv_1");
  assert.equal(provenance.targetExamination?.findingVersion.id, "fv_2");
  assert.ok(provenance.registration, "Registration record is linked in provenance");
  assert.equal(provenance.clinicianDecisions.length, 1);
  assert.equal(provenance.clinicianDecisions[0].decision, "accept");
  assert.equal(provenance.clinicianDecisions[0].user_id, "clin_1");
  assert.ok(provenance.discrepancies.length >= 1, "Discrepancy explanation is linked in provenance");
  assert.ok(provenance.auditHistory.length >= 1, "Audit history is linked in provenance");
});

test("Workstream 5D: attributeLongitudinalChange distinguishes scanner_difference (1.5T vs 3.0T or vendor mismatch) from genuine biological change", () => {
  const scannerDiff = attributeLongitudinalChange({
    priorVolumeMm3: 10000,
    currentVolumeMm3: 13200,
    priorSpacingMm: [1.0, 1.0, 3.0],
    currentSpacingMm: [1.0, 1.0, 3.0],
    priorMethod: "ai_3d_unet",
    currentMethod: "ai_3d_unet",
    priorScanner: "Siemens Avanto 1.5T",
    currentScanner: "Philips Ingenia 3.0T",
    priorFieldStrengthT: 1.5,
    currentFieldStrengthT: 3.0,
    elapsedDays: 90,
  });
  assert.equal(scannerDiff.category, "scanner_difference");
  assert.ok(scannerDiff.factors.some((f) => f.includes("scanner_difference")));
});
