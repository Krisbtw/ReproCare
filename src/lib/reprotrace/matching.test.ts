import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSpatialDistance,
  matchFindings,
  type FindingItem,
  type RegistrationResultTransform,
} from "./matching.ts";

describe("ReproTrace Matching Logic", () => {
  const identityRegistration: RegistrationResultTransform = {
    transform: {
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  };

  it("calculates Euclidean spatial distance with translation", () => {
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
  });

  it("should match findings with high confidence (likely_same)", () => {
    const finding1: FindingItem = {
      id: "f1",
      anatomicalLabel: "uterus",
      coordinates: { x: 0, y: 0, z: 0 },
      volume: 100,
      studyUID: "study1",
    };

    const finding2: FindingItem = {
      id: "f2",
      anatomicalLabel: "uterus",
      coordinates: { x: 1, y: 1, z: 1 }, // Within 10mm
      volume: 95, // Delta 5% < 20%
      studyUID: "study2",
    };

    const result = matchFindings(finding1, finding2, identityRegistration);
    assert.equal(result.confidence, "high");
    assert.equal(result.type, "likely_same");
    assert.ok(result.spatialDistance < 10);
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
});
