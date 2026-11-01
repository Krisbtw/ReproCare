import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  linkReportToFindings,
  validateReportFindingConsistency,
} from "./linking.ts";
import type { FindingItem } from "./matching.ts";

describe("ReproTrace Report-Finding Linking & Consistency", () => {
  it("links findings with anatomical evidence to report", () => {
    const findings: FindingItem[] = [
      {
        id: "f1",
        anatomicalLabel: "uterus",
        coordinates: { x: 0, y: 0, z: 0 },
        volume: 120,
        studyUID: "s1",
        anatomicalFindings: ["intramural fibroid"],
      },
      {
        id: "f2",
        anatomicalLabel: "ovary",
        coordinates: { x: 20, y: 10, z: 5 },
        volume: 15,
        studyUID: "s1",
        anatomicalFindings: [],
      },
    ];

    const links = linkReportToFindings("rep-101", findings);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.findingId, "f1");
    assert.equal(links[0]?.reportId, "rep-101");
    assert.equal(links[0]?.reviewStatus, "unreviewed");
  });

  it("detects missing uterus finding when report specifies FIGO classification", () => {
    const findings: FindingItem[] = [
      {
        id: "f1",
        anatomicalLabel: "ovary",
        coordinates: { x: 0, y: 0, z: 0 },
        volume: 20,
        studyUID: "s1",
      },
    ];

    const reportData = {
      figo_classification: "FIGO 4",
      measurements: { uterus: 120 },
    };

    const res = validateReportFindingConsistency(reportData, findings);
    assert.equal(res.consistent, false);
    assert.ok(res.discrepancies.some((d) => d.includes("uterus")));
  });

  it("detects volume discrepancy when report and finding disagree by > 20", () => {
    const findings: FindingItem[] = [
      {
        id: "f1",
        anatomicalLabel: "uterus",
        coordinates: { x: 0, y: 0, z: 0 },
        volume: 200,
        studyUID: "s1",
      },
    ];

    const reportData = {
      measurements: { uterus: 120 },
    };

    const res = validateReportFindingConsistency(reportData, findings);
    assert.equal(res.consistent, false);
    assert.ok(res.discrepancies.some((d) => d.includes("Volume discrepancy")));
  });

  it("passes validation when report measurements match finding volume within threshold", () => {
    const findings: FindingItem[] = [
      {
        id: "f1",
        anatomicalLabel: "uterus",
        coordinates: { x: 0, y: 0, z: 0 },
        volume: 125,
        studyUID: "s1",
      },
      {
        id: "f2",
        anatomicalLabel: "fibroid",
        coordinates: { x: 10, y: 5, z: 2 },
        volume: 32,
        studyUID: "s1",
      },
    ];

    const reportData = {
      figo_classification: "FIGO 5",
      measurements: { uterus: 120, fibroid: 30 },
    };

    const res = validateReportFindingConsistency(reportData, findings);
    assert.equal(res.consistent, true);
    assert.equal(res.discrepancies.length, 0);
  });
});
