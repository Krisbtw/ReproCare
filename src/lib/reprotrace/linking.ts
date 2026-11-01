/**
 * Evidence linking and report-finding consistency validation.
 */
import type { FindingItem } from "./matching.ts";

export interface ReportLink {
  reportId: string;
  findingId: string;
  confidence: number;
  reviewStatus: "unreviewed" | "confirmed" | "disputed";
}

export interface ReportConsistencyInput {
  figo_classification?: string;
  measurements?: Record<string, number>;
}

export interface ConsistencyResult {
  consistent: boolean;
  discrepancies: string[];
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
    if (!findingLabels.has("uterus") && !findingLabels.has("fibroid") && !findingLabels.has("myoma")) {
      discrepancies.push("Report mentions uterine fibroid FIGO classification but no uterus finding recorded");
    }
  }

  // Check volume consistency (threshold 20 cm³)
  if (reportData.measurements) {
    for (const [organ, volume] of Object.entries(reportData.measurements)) {
      const matching = findings.find((f) => f.anatomicalLabel.toLowerCase() === organ.toLowerCase());
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
