import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import {
  explainFinding,
  longestOf,
  matchStudies,
  matchChronology,
  methodGap,
  reportGap,
  sameMethodChange,
  segmentationGap,
  type Measure,
  type Snap,
  type RegistrationLookupEntry,
} from "./engine.ts";
import { toMatrix4x4, eulerToRotationMatrix } from "../imaging/registration.ts";
import {
  executeSaveVolumeRegistration,
  recomputeReproTrace,
} from "../clinic/server.backend.ts";

function snap(partial: Partial<Snap> & Pick<Snap, "id" | "locationLabel" | "centroidMm">): Snap {
  return {
    findingId: partial.id,
    studyId: partial.studyId ?? "s",
    seriesId: partial.seriesId ?? null,
    date: partial.date ?? "2024-01-01",
    organ: partial.organ ?? "uterus",
    structure: partial.structure ?? "fibroid",
    modality: partial.modality ?? "MR",
    frame: partial.frame ?? "schematic",
    axesMm: partial.axesMm ?? [20, 18, 16],
    longestMm: partial.longestMm ?? null,
    quality: partial.quality ?? "adequate",
    ...partial,
  };
}

const priorA = snap({
  id: "m1a",
  studyId: "mr1",
  seriesId: "ser1",
  locationLabel: "FIGO 4 anterior intramural",
  centroidMm: [2, 8, 18],
  axesMm: [42, 38, 36],
});
const priorB = snap({
  id: "m1b",
  studyId: "mr1",
  seriesId: "ser1",
  locationLabel: "FIGO 6 posterior subserosal",
  centroidMm: [4, -6, -22],
  axesMm: [28, 24, 22],
});
const priorC = snap({
  id: "m1c",
  studyId: "mr1",
  seriesId: "ser1",
  locationLabel: "FIGO 2 submucosal",
  centroidMm: [-3, 4, 6],
  axesMm: [18, 16, 15],
});
const nextA = snap({
  id: "m2a",
  studyId: "mr2",
  seriesId: "ser2",
  date: "2025-08-03",
  locationLabel: "FIGO 4 anterior intramural",
  centroidMm: [3, 9, 17],
  axesMm: [51, 44, 40],
});
const nextB = snap({
  id: "m2b",
  studyId: "mr2",
  seriesId: "ser2",
  date: "2025-08-03",
  locationLabel: "FIGO 6 posterior subserosal",
  centroidMm: [5, -5, -21],
  axesMm: [29, 25, 22],
});
const nextD = snap({
  id: "m2d",
  studyId: "mr2",
  seriesId: "ser2",
  date: "2025-08-03",
  locationLabel: "FIGO 7 pedunculated",
  centroidMm: [34, 10, -16],
  axesMm: [14, 12, 11],
});

test("fibroid follow-up proposals stay unmerged and categorized", () => {
  const proposals = matchStudies([priorA, priorB, priorC], [nextA, nextB, nextD]);
  const by = (from: string | null, to: string | null) =>
    proposals.find((p) => p.fromId === from && p.toId === to);
  assert.equal(by("m1a", "m2a")?.category, "likely_same");
  assert.equal(by("m1a", "m2a")?.provisional, true);
  assert.equal(by("m1b", "m2b")?.category, "likely_same");
  assert.equal(by("m1c", null)?.category, "needs_review");
  assert.equal(by(null, "m2d")?.category, "potentially_new");
  assert.equal(proposals.length, 4);
});

test("limited image quality blocks a likely-same label", () => {
  const a = snap({
    id: "e1",
    organ: "pelvis",
    structure: "endometriotic_lesion",
    locationLabel: "right uterosacral region",
    centroidMm: [18, -4, 8],
    axesMm: [16, 12, 10],
    studyId: "a1",
  });
  const b = snap({
    id: "e2",
    organ: "pelvis",
    structure: "endometriotic_lesion",
    locationLabel: "right uterosacral region",
    centroidMm: [18, -4, 30],
    axesMm: [16, 12, 11],
    studyId: "a2",
    quality: "limited",
  });
  const [only] = matchStudies([a], [b]);
  assert.equal(only.category, "uncertain");
  assert.ok(only.rationale.includes("quality"));
});

test("measurement rules do not call modality gaps progression", () => {
  const mr: Measure = {
    id: "mr",
    findingId: "f",
    date: "2024-11-12",
    modality: "MR",
    basis: "three-axis",
    locationLabel: "FIGO 4 anterior intramural",
    longestMm: 42,
    axesMm: [42, 38, 36],
    source: "clinician_edit",
    reportLongestMm: 42,
    quality: "adequate",
  };
  const us: Measure = { ...mr, id: "us", modality: "US", date: "2025-02-14", longestMm: 39, axesMm: null, source: "clinician_recorded" };
  const later: Measure = { ...mr, id: "later", date: "2025-08-03", longestMm: 51, axesMm: [51, 44, 40], source: "demonstration_geometry" };
  assert.equal(methodGap(mr, us)?.category, "method_difference");
  assert.equal(sameMethodChange(mr, later)?.category, "measurable_difference");
  assert.equal(sameMethodChange(mr, { ...mr, id: "close", longestMm: 44 }), null);
  const edited: Measure = { ...mr, id: "v1", source: "demonstration_geometry", axesMm: [46, 40, 38], longestMm: 46 };
  assert.equal(segmentationGap(edited, mr)?.category, "segmentation_disagreement");
  assert.equal(reportGap({ ...mr, reportLongestMm: 34, longestMm: 28 })?.category, "reporting_inconsistency");
  assert.equal(reportGap(mr), null);
});

test("explanations do not invent a report", () => {
  const bare = explainFinding({
    structure: "fibroid",
    location: "anterior",
    quote: null,
    axesMm: [10, 10, 10],
    basis: "three-axis",
    verified: false,
    sourceName: "version",
  });
  assert.equal(bare.insufficient, true);
  assert.ok(bare.paragraphs.every((p) => !p.text.includes("diagnosed")));
  assert.equal(longestOf(null, 12), 12);
});

test("follow-up registration supports non-provisional match when verified and includes registrationQuality", () => {
  const regTransform = {
    translationMm: [1, 1, -1] as [number, number, number],
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as [[number, number, number], [number, number, number], [number, number, number]],
    centerOfRotationMm: [2, 8, 18] as [number, number, number],
    movingCentroidMm: [3, 9, 17] as [number, number, number],
  };

  const supported = matchStudies([priorA], [nextA], {
    registrationId: "reg_1",
    fixedStudyId: "mr1",
    movingStudyId: "mr2",
    fixedSeriesId: "ser1",
    movingSeriesId: "ser2",
    status: "verified",
    nccScore: 0.91,
    residualMm: 1.2,
    supported: true,
    transform: regTransform,
  });
  assert.equal(supported[0]?.category, "likely_same");
  assert.equal(supported[0]?.provisional, false);
  assert.ok(supported[0]?.rationale.includes("Rigid follow-up image registration verified"));
  assert.equal(supported[0]?.registrationQuality?.supported, true);
  assert.equal(supported[0]?.registrationQuality?.status, "verified");
  assert.equal(supported[0]?.registrationQuality?.nccScore, 0.91);
  assert.equal(supported[0]?.registrationQuality?.residualMm, 1.2);
  assert.equal(supported[0]?.fromSeriesId, "ser1");
  assert.equal(supported[0]?.toSeriesId, "ser2");

  const unsupported = matchStudies([priorA], [nextA], { supported: false, status: "failed", nccScore: 0.22, residualMm: 19.5 });
  assert.notEqual(unsupported[0]?.category, "likely_same");
  assert.equal(unsupported[0]?.provisional, true);
  assert.ok(unsupported[0]?.rationale.includes("spatial correspondence could not be established"));
  assert.equal(unsupported[0]?.registrationQuality?.supported, false);
  assert.equal(unsupported[0]?.registrationQuality?.status, "failed");
});

test("matchChronology resolves registrations by series-pair and study-pair, and handles rotated/shifted coordinates", () => {
  // Finding in study 1 (series A) is at [20, 0, 10] in fixed space.
  // In study 2 (series B), patient shifted so raw moving coordinate is [0, -20, 7]
  // With a +90 deg Z rotation ([-y, x, z]) -> [20, 0, 7] + translation [0, 0, 3] -> [20, 0, 10] (exact match!)
  const rotZ90 = eulerToRotationMatrix(0, 0, Math.PI / 2);
  const matrix = toMatrix4x4({
    translationMm: [0, 0, 3],
    rotation: rotZ90,
    centerOfRotationMm: [0, 0, 3],
    movingCentroidMm: [0, 0, 0],
  });

  const s1 = snap({
    id: "v_s1",
    findingId: "f1",
    studyId: "study_1",
    seriesId: "series_A",
    date: "2025-01-10",
    frame: "dicom_lps",
    locationLabel: "FIGO 4 intramural",
    centroidMm: [20, 0, 10],
    axesMm: [30, 28, 25],
  });
  const s2 = snap({
    id: "v_s2",
    findingId: "f1",
    studyId: "study_2",
    seriesId: "series_B",
    date: "2025-07-10",
    frame: "dicom_lps",
    locationLabel: "FIGO 4 intramural",
    centroidMm: [0, -20, 7], // Raw distance from [20, 0, 10] is ~28.4mm, but transformed distance is 0mm!
    axesMm: [31, 28, 26],
  });

  // Without registration: raw distance ~28.4mm makes correspondence uncertain/provisional
  const withoutReg = matchChronology([s1, s2]);
  assert.notEqual(withoutReg[0]?.category, "likely_same");
  assert.equal(withoutReg[0]?.provisional, true);
  assert.equal(withoutReg[0]?.registrationQuality?.status, "missing");

  // With registration keyed ONLY by series IDs ("series_A:series_B"): matchChronology resolves it and transforms s2 -> [20, 0, 10]
  const regMap = new Map<string, RegistrationLookupEntry>();
  regMap.set("series_A:series_B", {
    registrationId: "reg_ab",
    fixedStudyId: "study_1",
    movingStudyId: "study_2",
    fixedSeriesId: "series_A",
    movingSeriesId: "series_B",
    status: "verified",
    nccScore: 0.94,
    residualMm: 0.4,
    supported: true,
    transform: matrix,
  });

  const withSeriesReg = matchChronology([s1, s2], regMap);
  assert.equal(withSeriesReg[0]?.category, "likely_same");
  assert.equal(withSeriesReg[0]?.provisional, false);
  assert.equal(withSeriesReg[0]?.registrationQuality?.registrationId, "reg_ab");
  assert.equal(withSeriesReg[0]?.registrationQuality?.supported, true);
});

test("matchStudies blocks likely_same when registration has low NCC, high residual, invalid matrix, or mismatched series", () => {
  const s1 = snap({
    id: "v1",
    studyId: "st1",
    seriesId: "ser1",
    frame: "dicom_lps",
    locationLabel: "FIGO 4 anterior intramural",
    centroidMm: [10, 10, 10],
  });
  const s2 = snap({
    id: "v2",
    studyId: "st2",
    seriesId: "ser2",
    frame: "dicom_lps",
    locationLabel: "FIGO 4 anterior intramural",
    centroidMm: [10, 10, 10],
  });
  const identityMat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  // 1. Low NCC (< 0.5)
  const lowNcc = matchStudies([s1], [s2], {
    status: "computed",
    nccScore: 0.31,
    residualMm: 2.0,
    supported: true,
    transform: identityMat,
  });
  assert.notEqual(lowNcc[0]?.category, "likely_same");
  assert.equal(lowNcc[0]?.provisional, true);
  assert.match(lowNcc[0]?.rationale ?? "", /NCC 0\.31/);

  // 2. Excessive residual (> 15 mm)
  const highResidual = matchStudies([s1], [s2], {
    status: "computed",
    nccScore: 0.85,
    residualMm: 22.4,
    supported: true,
    transform: identityMat,
  });
  assert.notEqual(highResidual[0]?.category, "likely_same");
  assert.equal(highResidual[0]?.provisional, true);
  assert.match(highResidual[0]?.rationale ?? "", /residual/);

  // 3. Invalid transformation matrix (singular / reflection)
  const badMatrix = matchStudies([s1], [s2], {
    status: "verified",
    nccScore: 0.95,
    residualMm: 0.5,
    supported: true,
    transform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  });
  assert.notEqual(badMatrix[0]?.category, "likely_same");
  assert.equal(badMatrix[0]?.provisional, true);
  assert.equal(badMatrix[0]?.registrationQuality?.matrixValid, false);

  // 4. Series mismatch (registration was computed for ser_other_1 -> ser_other_2, not ser1 -> ser2)
  const seriesMismatch = matchStudies([s1], [s2], {
    fixedStudyId: "st1",
    movingStudyId: "st2",
    fixedSeriesId: "ser_other_1",
    movingSeriesId: "ser_other_2",
    status: "verified",
    nccScore: 0.95,
    residualMm: 0.5,
    supported: true,
    transform: identityMat,
  });
  assert.notEqual(seriesMismatch[0]?.category, "likely_same");
  assert.equal(seriesMismatch[0]?.provisional, true);
});

test("End-to-end DB integration: executeSaveVolumeRegistration + recomputeReproTrace links series to studies and persists registration quality", async () => {
  const pg = new PGlite();
  await pg.exec(`
    create table profiles (user_id text primary key, display_name text not null default '', role text not null default 'clinician', active_patient_id text, created_at timestamptz not null default now());
    create table clinician_verifications (id text primary key, user_id text not null, licence_no text not null default '', registry text not null default '', evidence_note text not null default '', status text not null default 'verified', decided_by text, decided_at timestamptz, reason text not null default '', requested_at timestamptz not null default now());
    create table patients (id text primary key, user_id text not null, code text not null, display_name text not null, year_of_birth integer, pathway text not null, synopsis text not null, is_self boolean not null default false, synthetic boolean not null default true);
    create table studies (id text primary key, user_id text not null, patient_id text not null, modality text not null, study_date date not null, description text not null, accession text not null, synthetic boolean not null default true, source_note text not null);
    create table series (id text primary key, user_id text not null, study_id text not null, series_number integer not null, description text not null, plane text, slice_thickness_mm double precision, pixel_spacing_mm text, slice_count integer, quality text not null default 'adequate');
    create table findings (id text primary key, user_id text not null, patient_id text not null, code text not null, structure text not null, organ text not null, pathway text not null);
    create table finding_versions (id text primary key, user_id text not null, finding_id text not null, version_no integer not null, previous_version_id text, study_id text not null, observed_on date not null, location_label text not null, figo text, centroid_mm text, axes_mm text, longest_mm double precision, measurement_basis text not null, frame text not null, segmentation_source text not null, model_id text, quality text not null default 'adequate', modality text not null, report_longest_mm double precision, change_reason text not null, created_at timestamptz not null default now());
    create table evidence_links (id text primary key, user_id text not null, finding_version_id text not null, kind text not null, study_id text, series_id text, report_id text, quote text, slice_index integer, note text not null, created_at timestamptz not null default now());
    create table registrations (id text primary key, user_id text not null, patient_id text not null, fixed_series_id text not null, moving_series_id text not null, fixed_study_id text, moving_study_id text, ncc_score double precision not null, residual_mm double precision not null, transform_matrix_json text not null, status text not null default 'verified', quality_note text, matrix_valid boolean not null default true, created_at timestamptz not null default now());
    create table correspondences (id text primary key, user_id text not null, patient_id text not null, from_version_id text, to_version_id text, from_study_id text, to_study_id text, from_series_id text, to_series_id text, registration_id text, registration_status text, registration_ncc double precision, registration_residual_mm double precision, category text not null, score double precision not null, rationale text not null, provisional boolean not null default true, engine_version text not null, active boolean not null default true, created_at timestamptz not null default now());
    create table discrepancies (id text primary key, user_id text not null, patient_id text not null, category text not null, summary text not null, detail text not null, left_ref text not null, right_ref text not null, engine_version text not null, active boolean not null default true, created_at timestamptz not null default now());
    create table audit_events (id text primary key, user_id text not null, action text not null, entity_type text not null, entity_id text not null, detail text not null, at timestamptz not null default now());

    insert into profiles (user_id, display_name, role) values ('clin_1', 'Dr Verified', 'clinician');
    insert into clinician_verifications (id, user_id, licence_no, registry, status) values ('cv_1', 'clin_1', 'L-100', 'GMC', 'verified');
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis) values ('pat_1', 'clin_1', 'P1', 'Test Patient', 1988, 'fibroids', 'Test');
    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note) values ('st_1', 'clin_1', 'pat_1', 'MR', '2025-01-01', 'Baseline MRI', 'A1', 'Seed');
    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note) values ('st_2', 'clin_1', 'pat_1', 'MR', '2025-06-01', 'Follow-up MRI', 'A2', 'Seed');
    insert into series (id, user_id, study_id, series_number, description) values ('ser_1', 'clin_1', 'st_1', 1, 'T2 Sagittal Baseline');
    insert into series (id, user_id, study_id, series_number, description) values ('ser_2', 'clin_1', 'st_2', 1, 'T2 Sagittal Follow-up');
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway) values ('find_1', 'clin_1', 'pat_1', 'F1', 'fibroid', 'uterus', 'fibroids');
    insert into finding_versions (id, user_id, finding_id, version_no, study_id, observed_on, location_label, figo, centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, modality, change_reason)
      values ('fv_1', 'clin_1', 'find_1', 1, 'st_1', '2025-01-01', 'FIGO 4 intramural', '4', '[10, 20, 30]', '[40, 35, 30]', 40, 'three-axis', 'dicom_lps', 'clinician_edit', 'MR', 'Baseline');
    insert into finding_versions (id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo, centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, modality, change_reason)
      values ('fv_2', 'clin_1', 'find_1', 2, 'fv_1', 'st_2', '2025-06-01', 'FIGO 4 intramural', '4', '[5, 18, 34]', '[42, 36, 31]', 42, 'three-axis', 'dicom_lps', 'clinician_edit', 'MR', 'Follow-up');
    insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, note) values ('ev_1', 'clin_1', 'fv_1', 'series_slice', 'st_1', 'ser_1', 'Slice 10');
    insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, note) values ('ev_2', 'clin_1', 'fv_2', 'series_slice', 'st_2', 'ser_2', 'Slice 11');
  `);

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      query += `$${i + 1}${strings[i + 1]}`;
    }
    const res = await pg.query(query, values as unknown[]);
    return res.rows as any;
  }) as unknown as Sql;

  // Save a valid volume registration mapping moving [5, 18, 34] -> fixed [10, 20, 30] via translation [+5, +2, -4]
  const regRes = await executeSaveVolumeRegistration(sql, "clin_1", {
    patientId: "pat_1",
    fixedSeriesId: "ser_1",
    movingSeriesId: "ser_2",
    method: "ncc_moments_3d",
    matrix: [1, 0, 0, 5, 0, 1, 0, 2, 0, 0, 1, -4, 0, 0, 0, 1],
    nccScore: 0.93,
    residualMm: 0.8,
    status: "verified",
  });
  assert.ok(regRes.id);

  const corrRows = await sql<{
    category: string;
    provisional: boolean;
    from_series_id: string;
    to_series_id: string;
    registration_id: string;
    registration_status: string;
    registration_ncc: number;
    registration_residual_mm: number;
  }>`select category, provisional, from_series_id, to_series_id, registration_id, registration_status, registration_ncc, registration_residual_mm from correspondences where patient_id = 'pat_1' and active = true`;

  assert.equal(corrRows.length, 1);
  assert.equal(corrRows[0].category, "likely_same");
  assert.equal(corrRows[0].provisional, false);
  assert.equal(corrRows[0].from_series_id, "ser_1");
  assert.equal(corrRows[0].to_series_id, "ser_2");
  assert.equal(corrRows[0].registration_id, regRes.id);
  assert.equal(corrRows[0].registration_status, "verified");
  assert.ok(Math.abs(corrRows[0].registration_ncc - 0.93) < 1e-6);
  assert.ok(Math.abs(corrRows[0].registration_residual_mm - 0.8) < 1e-6);

  // Now test that if registration fails (status='failed' even with high nccScore), recomputeReproTrace blocks likely_same!
  await sql`update registrations set status = 'failed', ncc_score = 0.88 where id = ${regRes.id}`;
  await recomputeReproTrace(sql, "clin_1", "pat_1");

  const failedCorr = await sql<{
    category: string;
    provisional: boolean;
    registration_status: string;
  }>`select category, provisional, registration_status from correspondences where patient_id = 'pat_1' and active = true`;
  assert.equal(failedCorr.length, 1);
  assert.notEqual(failedCorr[0].category, "likely_same");
  assert.equal(failedCorr[0].provisional, true);
  assert.equal(failedCorr[0].registration_status, "failed");
});
