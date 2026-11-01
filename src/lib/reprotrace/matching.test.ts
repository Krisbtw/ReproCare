import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSpatialDistance,
  matchFindings,
  type FindingItem,
  type RegistrationResultTransform,
} from "./matching.ts";
import { eulerToRotationMatrix, toMatrix4x4 } from "../imaging/registration.ts";

describe("ReproTrace Matching Logic", () => {
  const identityRegistration: RegistrationResultTransform = {
    status: "verified",
    nccScore: 0.95,
    residualMm: 0.5,
    supported: true,
    transform: {
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  };

  it("calculates Euclidean spatial distance with translation and rotation", () => {
    const p1 = { x: 10, y: 20, z: 30 };
    const p2 = { x: 10, y: 20, z: 30 };
    const d1 = calculateSpatialDistance(p1, p2, identityRegistration);
    assert.equal(d1, 0);

    const offsetReg: RegistrationResultTransform = {
      transform: {
        translation: { x: 3, y: 4, z: 0 },
      },
    };
    const d2 = calculateSpatialDistance(p1, p2, offsetReg);
    assert.equal(d2, 5);

    // 90 deg rotation around Z axis + translation
    const rotZ90 = eulerToRotationMatrix(0, 0, Math.PI / 2);
    const mat4x4 = toMatrix4x4({
      translationMm: [10, 5, 0],
      rotation: rotZ90,
      centerOfRotationMm: [10, 5, 0],
      movingCentroidMm: [0, 0, 0],
    });
    // Moving point [2, 3, 4] rotated by +90 deg around Z is [-3, 2, 4], + [10, 5, 0] = [7, 7, 4]
    const fixedPt = { x: 7, y: 7, z: 4 };
    const movingPt = { x: 2, y: 3, z: 4 };
    const dRot = calculateSpatialDistance(fixedPt, movingPt, { matrix: mat4x4 });
    assert.ok(dRot < 1e-6);
  });

  it("should match findings with high confidence (likely_same) when registration is valid and supported", () => {
    const finding1: FindingItem = {
      id: "f1",
      anatomicalLabel: "uterus",
      coordinates: { x: 0, y: 0, z: 0 },
      volume: 100,
      studyUID: "study1",
      seriesUID: "series1",
    };

    const finding2: FindingItem = {
      id: "f2",
      anatomicalLabel: "uterus",
      coordinates: { x: 1, y: 1, z: 1 }, // Within 10mm
      volume: 95, // Delta 5% < 20%
      studyUID: "study2",
      seriesUID: "series2",
    };

    const result = matchFindings(finding1, finding2, {
      ...identityRegistration,
      fixedStudyId: "study1",
      movingStudyId: "study2",
      fixedSeriesId: "series1",
      movingSeriesId: "series2",
    });
    assert.equal(result.confidence, "high");
    assert.equal(result.type, "likely_same");
    assert.ok(result.spatialDistance < 10);
    assert.equal(result.registrationQuality.supported, true);
  });

  it("should flag findings requiring review when label or volume differs significantly", () => {
    const finding1: FindingItem = {
      id: "f1",
      anatomicalLabel: "uterus",
      coordinates: { x: 0, y: 0, z: 0 },
      volume: 100,
      studyUID: "study1",
    };

    const finding2: FindingItem = {
      id: "f2",
      anatomicalLabel: "ovary", // Different label
      coordinates: { x: 5, y: 5, z: 5 },
      volume: 50,
      studyUID: "study2",
    };

    const result = matchFindings(finding1, finding2, identityRegistration);
    assert.equal(result.confidence, "low");
    assert.equal(result.type, "requires_review");
  });

  it("prevents likely_same matching when registration is missing, failed, low quality, or series-mismatched across studies", () => {
    const f1: FindingItem = {
      id: "f1",
      anatomicalLabel: "fibroid",
      coordinates: { x: 12, y: -4, z: 20 },
      volume: 40,
      studyUID: "study_prior",
      seriesUID: "series_prior",
    };
    const f2: FindingItem = {
      id: "f2",
      anatomicalLabel: "fibroid",
      coordinates: { x: 12, y: -4, z: 20 },
      volume: 41,
      studyUID: "study_next",
      seriesUID: "series_next",
    };

    // 1. Missing registration across different studies -> must NOT return likely_same
    const missingRes = matchFindings(f1, f2, null);
    assert.notEqual(missingRes.type, "likely_same");
    assert.equal(missingRes.registrationQuality.status, "missing");
    assert.equal(missingRes.registrationQuality.supported, false);

    // 2. Failed registration -> must NOT return likely_same
    const failedRes = matchFindings(f1, f2, {
      ...identityRegistration,
      status: "failed",
      supported: false,
    });
    assert.notEqual(failedRes.type, "likely_same");
    assert.equal(failedRes.registrationQuality.status, "failed");
    assert.equal(failedRes.registrationQuality.supported, false);

    // 3. Low NCC score (< 0.5) -> must NOT return likely_same
    const lowNccRes = matchFindings(f1, f2, {
      ...identityRegistration,
      nccScore: 0.35,
    });
    assert.notEqual(lowNccRes.type, "likely_same");
    assert.equal(lowNccRes.registrationQuality.supported, false);

    // 4. Series ID mismatch -> must NOT return likely_same
    const mismatchSeriesRes = matchFindings(f1, f2, {
      ...identityRegistration,
      fixedSeriesId: "series_prior",
      movingSeriesId: "wrong_series_id",
    });
    assert.notEqual(mismatchSeriesRes.type, "likely_same");
    assert.equal(mismatchSeriesRes.registrationQuality.supported, false);

    // 5. Invalid transformation matrix -> must NOT return likely_same
    const invalidMatRes = matchFindings(f1, f2, {
      status: "verified",
      nccScore: 0.95,
      matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], // det = -1
    });
    assert.notEqual(invalidMatRes.type, "likely_same");
    assert.equal(invalidMatRes.registrationQuality.matrixValid, false);
  });
});
