import test from "node:test";
import assert from "node:assert/strict";
import { fnv1a, versionFromLab, LAB_SEGMENTATION_SOURCE } from "./finding-link.ts";
import type { MaskMeasurement } from "./metrics.ts";

const good: MaskMeasurement = {
  voxelCount: 6520, volumeMl: 37.5, componentCount: 1, largestComponentFraction: 1,
  centroidMm: [58, 58, 56], axesMm: [56, 42, 33], longestMm: 56, method: "m",
};
const base = { accepted: true, isLearnedModel: false, measurement: good, seed: [48, 48, 14] as [number, number, number], recordHash: "abcd1234", seriesDescription: "SYNTHETIC", source: "sample" as const, reason: "First measured pass" };

test("accepted classical run becomes version fields with no centroid and unavailable frame", () => {
  const r = versionFromLab(base);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.fields.segmentationSource, LAB_SEGMENTATION_SOURCE);
  assert.equal(r.fields.frame, "unavailable");
  assert.equal(r.fields.centroidMm, null);
  assert.equal(r.fields.modelId, null);
  assert.deepEqual(r.fields.axes, [56, 42, 33]);
  assert.equal(r.fields.sliceIndex, 14);
  assert.match(r.fields.evidenceNote, /not a trained model/);
  assert.match(r.fields.evidenceNote, /abcd1234/);
  assert.match(r.fields.evidenceNote, /not been shown to be the study/);
});

test("refuses rejected segmentation, unconfirmed learned flag, empty mask, fragmented mask, short reason, absurd size", () => {
  assert.equal(versionFromLab({ ...base, accepted: false }).ok, false);
  assert.equal(versionFromLab({ ...base, isLearnedModel: true, clinicianConfirmed: false }).ok, false);
  assert.equal(versionFromLab({ ...base, measurement: { ...good, voxelCount: 0, axesMm: null, longestMm: null } }).ok, false);
  assert.equal(versionFromLab({ ...base, measurement: { ...good, componentCount: 3, largestComponentFraction: 0.6 } }).ok, false);
  assert.equal(versionFromLab({ ...base, reason: "short" }).ok, false);
  assert.equal(versionFromLab({ ...base, measurement: { ...good, axesMm: [400, 10, 10], longestMm: 400 } }).ok, false);
});

test("accepts learned model result when clinician explicitly confirms", () => {
  const r = versionFromLab({
    ...base,
    isLearnedModel: true,
    clinicianConfirmed: true,
    modelId: "umd_monai_fibroid",
    segmentationRunId: "run-123",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.fields.modelId, "umd_monai_fibroid");
  assert.equal(r.fields.segmentationSource, "umd_monai_fibroid");
  assert.equal(r.fields.segmentationRunId, "run-123");
  assert.match(r.fields.evidenceNote, /Clinician reviewed and confirmed/);
});

test("fnv1a is stable and sensitive", () => {
  assert.equal(fnv1a("abc"), fnv1a("abc"));
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
  assert.equal(fnv1a("").length, 8);
});

import { matchStudies, type Snap } from "../reprotrace/engine.ts";

test("a lab-made snapshot is never auto-matched: it stays unpaired and provisional", () => {
  const prior: Snap = { id: "a", findingId: "f1", studyId: "s1", date: "2026-01-02", organ: "uterus", structure: "fibroid", locationLabel: "FIGO 4", modality: "MR", frame: "image_registered", centroidMm: [10, 10, 10], axesMm: [56, 42, 33], longestMm: 56, quality: "adequate" };
  const lab: Snap = { ...prior, id: "b", studyId: "s2", date: "2026-06-01", frame: "unavailable", centroidMm: null };
  const out = matchStudies([prior], [lab]);
  assert.ok(out.length > 0);
  assert.ok(out.every((p) => p.category !== "likely_same"));
  assert.ok(out.every((p) => p.provisional));
  assert.ok(out.every((p) => !(p.fromId === "a" && p.toId === "b")));
});
