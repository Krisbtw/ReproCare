import assert from "node:assert/strict";
import test from "node:test";
import {
  explainFinding,
  longestOf,
  matchStudies,
  methodGap,
  reportGap,
  sameMethodChange,
  segmentationGap,
  type Measure,
  type Snap,
} from "./engine.ts";

function snap(partial: Partial<Snap> & Pick<Snap, "id" | "locationLabel" | "centroidMm">): Snap {
  return {
    findingId: partial.id,
    studyId: partial.studyId ?? "s",
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
  locationLabel: "FIGO 4 anterior intramural",
  centroidMm: [2, 8, 18],
  axesMm: [42, 38, 36],
});
const priorB = snap({
  id: "m1b",
  studyId: "mr1",
  locationLabel: "FIGO 6 posterior subserosal",
  centroidMm: [4, -6, -22],
  axesMm: [28, 24, 22],
});
const priorC = snap({
  id: "m1c",
  studyId: "mr1",
  locationLabel: "FIGO 2 submucosal",
  centroidMm: [-3, 4, 6],
  axesMm: [18, 16, 15],
});
const nextA = snap({
  id: "m2a",
  studyId: "mr2",
  date: "2025-08-03",
  locationLabel: "FIGO 4 anterior intramural",
  centroidMm: [3, 9, 17],
  axesMm: [51, 44, 40],
});
const nextB = snap({
  id: "m2b",
  studyId: "mr2",
  date: "2025-08-03",
  locationLabel: "FIGO 6 posterior subserosal",
  centroidMm: [5, -5, -21],
  axesMm: [29, 25, 22],
});
const nextD = snap({
  id: "m2d",
  studyId: "mr2",
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

test("follow-up registration supports non-provisional match when verified", () => {
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

  const supported = matchStudies([priorA], [nextA], { supported: true, transform: regTransform });
  assert.equal(supported[0]?.category, "likely_same");
  assert.equal(supported[0]?.provisional, false);
  assert.ok(supported[0]?.rationale.includes("Rigid follow-up image registration verified"));

  const unsupported = matchStudies([priorA], [nextA], { supported: false });
  assert.notEqual(unsupported[0]?.category, "likely_same");
  assert.equal(unsupported[0]?.provisional, true);
  assert.ok(unsupported[0]?.rationale.includes("spatial correspondence could not be established"));
});
