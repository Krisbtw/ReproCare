/**
 * Deterministic SYNTHETIC cross-examination scenarios (Requirement 2) and report-candidate scoring
 * (Requirement 1). These check rule behaviour only; they are not evidence of clinical accuracy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { matchStudies, matchChronology, type Snap, type RegistrationLookupEntry } from "./engine.ts";
import { assessReportObservation, observationFromExtraction, type CandidateVersion } from "../reports/candidates.ts";
import { extractReport } from "../reports/extract.ts";

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function snap(p: Partial<Snap> & Pick<Snap, "id">): Snap {
  return {
    findingId: p.id,
    studyId: "st1",
    seriesId: "se1",
    date: "2025-01-01",
    organ: "uterus",
    structure: "fibroid",
    locationLabel: "FIGO 4 anterior intramural",
    modality: "MR",
    frame: "dicom_lps",
    centroidMm: [10, 10, 10],
    axesMm: [30, 28, 26],
    longestMm: 30,
    quality: "adequate",
    ...p,
  };
}
const later = (p: Partial<Snap> & Pick<Snap, "id">) => snap({ studyId: "st2", seriesId: "se2", date: "2025-07-01", ...p });
const reg = (extra: Partial<RegistrationLookupEntry> = {}): RegistrationLookupEntry => ({
  registrationId: "r1",
  fixedStudyId: "st1",
  movingStudyId: "st2",
  fixedSeriesId: "se1",
  movingSeriesId: "se2",
  status: "verified",
  nccScore: 0.9,
  residualMm: 1,
  supported: true,
  transform: I,
  ...extra,
});

test("1. same fibroid in two comparable registered exams -> likely same, distance valid", () => {
  const [p] = matchStudies([snap({ id: "a" })], [later({ id: "b", centroidMm: [11, 10, 9], axesMm: [32, 29, 27] })], reg());
  assert.equal(p.category, "likely_same");
  assert.equal(p.registrationAvailability?.spatialComparisonValid, true);
  assert.ok((p.distanceMm ?? 99) < 3);
});

test("2. new ovarian cyst in later exam -> potentially new", () => {
  const ps = matchStudies([snap({ id: "a" })], [later({ id: "b" }), later({ id: "cyst", organ: "ovary", structure: "cyst", locationLabel: "left ovary", centroidMm: [-40, 0, 5] })], reg());
  const n = ps.find((p) => p.toId === "cyst");
  assert.equal(n?.category, "potentially_new");
  assert.equal(n?.fromId, null);
});

test("3. previous finding not detected later -> possible resolved, never 'resolved'", () => {
  const ps = matchStudies([snap({ id: "a" }), snap({ id: "gone", locationLabel: "FIGO 6 posterior subserosal", centroidMm: [0, -30, -20], axesMm: [35, 30, 28] })], [later({ id: "b" })], reg());
  const r = ps.find((p) => p.fromId === "gone");
  assert.equal(r?.category, "possible_resolved");
  assert.match(r?.rationale ?? "", /not treated as proof of resolution/);
  assert.equal(r?.provisional, true);
});

test("4. ambiguous: two earlier candidates both plausible -> uncertain, alternatives listed, no auto choice", () => {
  const ps = matchStudies(
    [snap({ id: "a1", centroidMm: [10, 10, 10] }), snap({ id: "a2", centroidMm: [12, 11, 10] })],
    [later({ id: "b", centroidMm: [11, 10, 10] })],
    reg(),
  );
  const paired = ps.find((p) => p.toId === "b");
  assert.equal(paired?.category, "uncertain");
  assert.equal(paired?.provisional, true);
  assert.ok((paired?.alternatives ?? []).length >= 1);
  const other = ps.find((p) => p.toId === null);
  assert.equal(other?.category, "uncertain", "rival is not called resolved");
});

test("5. same anatomy, different laterality -> not paired", () => {
  const ps = matchStudies(
    [snap({ id: "a", organ: "ovary", structure: "cyst", locationLabel: "ovary", laterality: "left" })],
    [later({ id: "b", organ: "ovary", structure: "cyst", locationLabel: "ovary", laterality: "right" })],
    reg(),
  );
  assert.equal(ps.some((p) => p.fromId === "a" && p.toId === "b"), false);
});

test("6. different coordinate frames without registration -> uncertain, spatial comparison invalid", () => {
  const ps = matchChronology([snap({ id: "a" }), later({ id: "b" })]);
  assert.notEqual(ps[0].category, "likely_same");
  assert.equal(ps[0].registrationQuality?.status, "missing");
  assert.equal(ps[0].registrationAvailability?.kind, "unavailable");
  assert.equal(ps[0].registrationAvailability?.spatialComparisonValid, false);
});

test("7. poor-quality registration -> downgraded and explained", () => {
  const [p] = matchStudies([snap({ id: "a" })], [later({ id: "b" })], reg({ nccScore: 0.2 }));
  assert.notEqual(p.category, "likely_same");
  assert.equal(p.registrationAvailability?.kind, "insufficient_quality");
});

test("8. different modalities -> rationale says sizes are not compared as change", () => {
  const [p] = matchStudies([snap({ id: "a" })], [later({ id: "b", modality: "US" })], reg());
  assert.match(p.rationale, /modalities differ \(MR vs US\)/);
});

test("9. different voxel spacing -> attribution reflects protocol/spacing, not growth", () => {
  const [p] = matchStudies(
    [snap({ id: "a", spacingMm: [0.5, 0.5, 1] })],
    [later({ id: "b", spacingMm: [1.5, 1.5, 6], axesMm: [31, 28, 26] })],
    reg(),
  );
  assert.notEqual(p.attributionCategory, "genuine_anatomical_change");
});

test("10. missing anatomical coordinates -> needs review via non-spatial path, not dropped", () => {
  const ps = matchChronology([snap({ id: "a" }), later({ id: "b", centroidMm: null, frame: "unavailable" })], null, { includeNonSpatial: true });
  const p = ps.find((x) => x.toId === "b");
  assert.equal(p?.category, "needs_review");
  assert.equal(p?.registrationAvailability?.kind, "no_coordinates");
  assert.match(p?.rationale ?? "", /Missing anatomical coordinates/);
});

test("determinism: identical inputs give identical proposals", () => {
  const run = () => JSON.stringify(matchStudies([snap({ id: "a1" }), snap({ id: "a2", centroidMm: [12, 11, 10] })], [later({ id: "b" })], reg()));
  assert.equal(run(), run());
});

// ---- Requirement 1: report candidate scoring ----
const cand = (p: Partial<CandidateVersion> & Pick<CandidateVersion, "versionId">): CandidateVersion => ({
  findingId: `f-${p.versionId}`,
  findingCode: p.versionId.toUpperCase(),
  patientId: "p1",
  structure: "fibroid",
  organ: "uterus",
  locationLabel: "FIGO 4 anterior intramural",
  figo: "4",
  studyId: "st1",
  studyDate: "2025-01-01",
  modality: "MR",
  versionNo: 1,
  longestMm: 42,
  axesMm: [42, 38, 36],
  volumeMm3: null,
  ...p,
});
const obsOf = (text: string) => {
  const x = extractReport(text);
  return observationFromExtraction(x, x.findings.findIndex((f) => !f.negated))!;
};
const ctx = { patientId: "p1", reportStudyId: "st1", reportDate: null };

test("R1: strong candidate when structure, FIGO, side, size and exam agree; never auto-selected", () => {
  const a = assessReportObservation(obsOf("Anterior intramural fibroid (FIGO 4) measuring 4.3 x 3.8 x 3.6 cm."), [cand({ versionId: "v1" }), cand({ versionId: "v2", locationLabel: "FIGO 6 posterior subserosal", figo: "6" })], ctx);
  assert.equal(a.state, "strong");
  assert.equal(a.candidates[0].versionId, "v1");
  assert.equal(a.autoSelected, null);
  assert.equal(a.candidates.find((c) => c.versionId === "v2")?.compatible, false);
});

test("R1: single incompatible candidate is not attached", () => {
  const a = assessReportObservation(obsOf("Posterior intramural fibroid (FIGO 4) measuring 52 mm."), [cand({ versionId: "v1" })], ctx);
  assert.equal(a.state, "none");
  assert.match(a.explanation, /contradictory location/);
});

test("R1: ambiguous when two findings fit equally", () => {
  const a = assessReportObservation(obsOf("Intramural fibroid (FIGO 4) measuring 4.2 cm."), [cand({ versionId: "v1" }), cand({ versionId: "v2", locationLabel: "FIGO 4 intramural fundal" })], ctx);
  assert.equal(a.state, "ambiguous");
});

test("R1: negated statement -> insufficient evidence; other patient's findings ignored", () => {
  const x = extractReport("No fibroid is seen.");
  const o = observationFromExtraction(x, 0)!;
  assert.equal(assessReportObservation(o, [cand({ versionId: "v1" })], ctx).state, "insufficient_evidence");
  const b = assessReportObservation(obsOf("Anterior intramural fibroid (FIGO 4) measuring 4.2 cm."), [cand({ versionId: "v9", patientId: "other" })], ctx);
  assert.equal(b.candidates.length, 0);
});

test("R1: cm normalised to mm; volumes never compared with lengths", () => {
  const o = obsOf("Anterior intramural fibroid (FIGO 4) measuring 4.2 cm.");
  assert.deepEqual(o.measurements[0].valuesNormalised, [42]);
  const v = obsOf("Anterior intramural fibroid (FIGO 4), volume 30 mL.");
  const a = assessReportObservation(v, [cand({ versionId: "v1", axesMm: null, longestMm: 42 })], ctx);
  assert.ok(a.candidates[0].reasons.some((r) => /lengths and volumes are not compared/.test(r)));
});
