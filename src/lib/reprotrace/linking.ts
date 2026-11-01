/**
 * Evidence linking and report-finding consistency validation.
 */
import type { FindingItem } from "./matching.ts";
import { normalizeVolumeToMm3 } from "./trends.ts";

export interface ReportLink {
  reportId: string;
  findingId: string;
  confidence: number;
  reviewStatus: "unreviewed" | "confirmed" | "disputed";
}

export interface ReportConsistencyInput {
  figo_classification?: string;
  measurements?: Record<string, number>;
  measurementUnit?: "cm3" | "mm3" | "mL";
}

export interface ConsistencyResult {
  consistent: boolean;
  discrepancies: string[];
}

export interface ReportClaim {
  id: string;
  anatomicalLocation: string;
  reportedVolumeCm3?: number;
  reportedVolumeMm3?: number;
  reportedMaxDiameterMm?: number;
}

export interface DiscrepancyEvaluation {
  claimId: string;
  findingId: string | null;
  status: "consistent" | "discrepant" | "unverified";
  discrepancyType?: "missing_in_image" | "size_mismatch" | "location_mismatch";
  details: string;
  volumeDifferenceRatio?: number;
}

/**
 * Links a clinical report with findings that have confirmed anatomical evidence.
 */
export function linkReportToFindings(
  reportId: string,
  findings: FindingItem[],
  confidenceThreshold = 0.7,
): ReportLink[] {
  return findings
    .filter((f) => f.anatomicalFindings && f.anatomicalFindings.length > 0)
    .map((finding) => ({
      reportId,
      findingId: finding.id,
      confidence: Math.min(confidenceThreshold, 0.9),
      reviewStatus: "unreviewed" as const,
    }));
}

/**
 * Validates consistency between unstructured clinical report data and structured AI findings.
 */
export function validateReportFindingConsistency(
  reportData: ReportConsistencyInput,
  findings: FindingItem[],
): ConsistencyResult {
  const discrepancies: string[] = [];

  // Check FIGO classification consistency
  if (reportData.figo_classification && findings.length > 0) {
    const findingLabels = new Set(findings.map((f) => f.anatomicalLabel.toLowerCase()));
    if (
      !findingLabels.has("uterus") &&
      !findingLabels.has("fibroid") &&
      !findingLabels.has("myoma")
    ) {
      discrepancies.push(
        "Report mentions uterine fibroid FIGO classification but no uterus finding recorded",
      );
    }
  }

  // Check volume consistency (threshold 20 cm³)
  if (reportData.measurements) {
    for (const [organ, volume] of Object.entries(reportData.measurements)) {
      const matching = findings.find(
        (f) => f.anatomicalLabel.toLowerCase() === organ.toLowerCase(),
      );
      if (matching && Math.abs(matching.volume - volume) > 20) {
        discrepancies.push(
          `Volume discrepancy for ${organ}: Report=${volume}cm³, AI=${matching.volume}cm³`,
        );
      }
    }
  }

  return {
    consistent: discrepancies.length === 0,
    discrepancies,
  };
}

/**
 * Evaluate correspondence and discrepancy between structured report claims (`cm³` or `mm³`)
 * and segmented image findings (`volumeMm3`).
 */
export function evaluateReportCorrespondence(
  claims: ReportClaim[],
  findings: Array<{ id: string; anatomicalLocation: string; volumeMm3: number }>,
): DiscrepancyEvaluation[] {
  const evaluations: DiscrepancyEvaluation[] = [];

  for (const claim of claims) {
    const locationMatches = findings.filter(
      (f) =>
        f.anatomicalLocation.toLowerCase().trim() ===
          claim.anatomicalLocation.toLowerCase().trim() ||
        f.anatomicalLocation.toLowerCase().includes(claim.anatomicalLocation.toLowerCase()) ||
        claim.anatomicalLocation.toLowerCase().includes(f.anatomicalLocation.toLowerCase()),
    );

    if (locationMatches.length === 0) {
      evaluations.push({
        claimId: claim.id,
        findingId: null,
        status: "discrepant",
        discrepancyType: "missing_in_image",
        details: `No imaging finding segmented in reported location: ${claim.anatomicalLocation}`,
      });
      continue;
    }

    const claimVolumeMm3 =
      claim.reportedVolumeMm3 !== undefined
        ? claim.reportedVolumeMm3
        : claim.reportedVolumeCm3 !== undefined
          ? normalizeVolumeToMm3(claim.reportedVolumeCm3, "cm3")
          : undefined;

    const bestFinding =
      claimVolumeMm3 !== undefined && locationMatches.length > 1
        ? [...locationMatches].sort(
            (a, b) =>
              Math.abs(a.volumeMm3 - claimVolumeMm3) - Math.abs(b.volumeMm3 - claimVolumeMm3),
          )[0]
        : locationMatches[0];

    if (claimVolumeMm3 !== undefined && claimVolumeMm3 > 0) {
      const volDiffRatio = Math.abs(bestFinding.volumeMm3 - claimVolumeMm3) / claimVolumeMm3;

      if (volDiffRatio > 0.25) {
        const reportedCm3 = (claimVolumeMm3 / 1000).toFixed(2);
        const measuredCm3 = (bestFinding.volumeMm3 / 1000).toFixed(2);
        evaluations.push({
          claimId: claim.id,
          findingId: bestFinding.id,
          status: "discrepant",
          discrepancyType: "size_mismatch",
          details: `Reported volume (${reportedCm3} cm³ / ${claimVolumeMm3.toFixed(0)} mm³) differs from segmented physical volume (${measuredCm3} cm³ / ${bestFinding.volumeMm3.toFixed(0)} mm³) by ${(volDiffRatio * 100).toFixed(1)}% (>25%).`,
          volumeDifferenceRatio: Number(volDiffRatio.toFixed(4)),
        });
        continue;
      }
    }

    evaluations.push({
      claimId: claim.id,
      findingId: bestFinding.id,
      status: "consistent",
      details:
        "Segmented finding aligns with structured report claim in anatomical location and physical volume.",
    });
  }

  return evaluations;
}
