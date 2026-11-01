/**
 * Longitudinal trends, volumetric growth rates, chronological validation,
 * and alert detection for reproductive imaging.
 */

import {
  DEFAULT_REPROTRACE_THRESHOLDS,
  REPROTRACE_PARAMS,
  type ChangeAttributionCategory,
  type ReproTraceThresholds,
} from "./params.ts";

export interface ObservationPoint {
  date: string;
  volumeMm3: number;
  studyId?: string;
  findingVersionId?: string;
  uncertaintyMm3?: number;
  unit?: "mm3" | "cm3" | "mL";
  method?: string;
  spacingMm?: [number, number, number];
}

export interface LongitudinalAlert {
  type: "rapid_growth" | "significant_reduction" | "stable" | "insufficient_evidence";
  message: string;
  growthRateMm3PerMonth: number;
  attributionCategory?: ChangeAttributionCategory;
  chronologyIssues?: ChronologyIssue[];
}

export interface ChronologyIssue {
  code:
    | "missing_date"
    | "invalid_date"
    | "duplicate_study_id"
    | "duplicate_examination_date"
    | "out_of_order_input"
    | "insufficient_interval"
    | "invalid_measurement_value";
  severity: "warning" | "error";
  message: string;
  studyId?: string;
  date?: string;
}

export interface ValidatedChronology {
  validPoints: ObservationPoint[];
  excludedPoints: ObservationPoint[];
  issues: ChronologyIssue[];
  wasReordered: boolean;
  hasDuplicateDates: boolean;
  hasDuplicateStudies: boolean;
  totalElapsedDays: number;
  totalElapsedMonths: number;
}

const MS_PER_DAY = 24 * 3600 * 1000;
const MS_PER_MONTH = 30.44 * MS_PER_DAY;

/**
 * Parse an examination date string strictly into a UTC timestamp (ms).
 * Returns null if the string is empty, missing, or unparseable.
 */
export function parseExaminationDateMs(dateStr: string | null | undefined): number | null {
  if (!dateStr || typeof dateStr !== "string") return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Normalize volume measurement to physical mm³.
 * 1 cm³ = 1 mL = 1000 mm³.
 */
export function normalizeVolumeToMm3(
  value: number,
  unit: "mm3" | "cm3" | "mL" = "mm3",
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid physical volume measurement: ${value}`);
  }
  if (unit === "cm3" || unit === "mL") {
    return value * 1000;
  }
  return value;
}

/**
 * Validate and sort longitudinal observation points strictly by actual examination date.
 * - Rejects points with missing, unparseable, or negative/NaN measurements.
 * - Detects and flags out-of-order input sequences.
 * - Detects and deduplicates duplicate study IDs and same-date duplicate examinations.
 */
export function validateAndOrderChronology(points: ObservationPoint[]): ValidatedChronology {
  const issues: ChronologyIssue[] = [];
  const validWithMs: Array<{ point: ObservationPoint; ms: number; originalIndex: number }> = [];
  const excludedPoints: ObservationPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !p.date || typeof p.date !== "string" || p.date.trim() === "") {
      issues.push({
        code: "missing_date",
        severity: "error",
        message: `Observation at index ${i} (${p?.studyId ?? "unknown study"}) is missing an examination date.`,
        studyId: p?.studyId,
      });
      if (p) excludedPoints.push(p);
      continue;
    }

    const ms = parseExaminationDateMs(p.date);
    if (ms === null) {
      issues.push({
        code: "invalid_date",
        severity: "error",
        message: `Observation at index ${i} (${p.studyId ?? "unknown study"}) has an unparseable examination date ('${p.date}').`,
        studyId: p.studyId,
        date: p.date,
      });
      excludedPoints.push(p);
      continue;
    }

    if (!Number.isFinite(p.volumeMm3) || p.volumeMm3 < 0) {
      issues.push({
        code: "invalid_measurement_value",
        severity: "error",
        message: `Observation at index ${i} (${p.studyId ?? "unknown study"}) has a non-finite or negative volume (${p.volumeMm3}).`,
        studyId: p.studyId,
        date: p.date,
      });
      excludedPoints.push(p);
      continue;
    }

    const normalizedVolume = normalizeVolumeToMm3(p.volumeMm3, p.unit ?? "mm3");
    validWithMs.push({
      point: { ...p, volumeMm3: normalizedVolume, unit: "mm3" },
      ms,
      originalIndex: i,
    });
  }

  let wasReordered = false;
  for (let i = 1; i < validWithMs.length; i++) {
    if (validWithMs[i].ms < validWithMs[i - 1].ms) {
      wasReordered = true;
      break;
    }
  }
  if (wasReordered) {
    issues.push({
      code: "out_of_order_input",
      severity: "warning",
      message:
        "Input examinations were not in chronological order; ReproTrace sorted them strictly by actual examination date.",
    });
  }

  validWithMs.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.originalIndex - b.originalIndex));

  const seenStudyIds = new Set<string>();
  const seenDateDays = new Map<string, ObservationPoint>();
  const deduplicated: Array<{ point: ObservationPoint; ms: number }> = [];
  let hasDuplicateStudies = false;
  let hasDuplicateDates = false;

  for (const item of validWithMs) {
    const { point, ms } = item;
    if (point.studyId && seenStudyIds.has(point.studyId)) {
      hasDuplicateStudies = true;
      issues.push({
        code: "duplicate_study_id",
        severity: "warning",
        message: `Duplicate observation for study '${point.studyId}' on '${point.date}' was excluded.`,
        studyId: point.studyId,
        date: point.date,
      });
      excludedPoints.push(point);
      continue;
    }
    if (point.studyId) {
      seenStudyIds.add(point.studyId);
    }

    const dayKey = new Date(ms).toISOString().slice(0, 10);
    if (seenDateDays.has(dayKey)) {
      hasDuplicateDates = true;
      issues.push({
        code: "duplicate_examination_date",
        severity: "warning",
        message: `Duplicate examination date (${dayKey}) detected; zero-day duplicate interval excluded from growth rate calculation.`,
        studyId: point.studyId,
        date: point.date,
      });
      excludedPoints.push(point);
      continue;
    }

    seenDateDays.set(dayKey, point);
    deduplicated.push({ point, ms });
  }

  const totalElapsedDays =
    deduplicated.length >= 2
      ? (deduplicated[deduplicated.length - 1].ms - deduplicated[0].ms) / MS_PER_DAY
      : 0;
  const totalElapsedMonths =
    deduplicated.length >= 2
      ? (deduplicated[deduplicated.length - 1].ms - deduplicated[0].ms) / MS_PER_MONTH
      : 0;

  return {
    validPoints: deduplicated.map((d) => d.point),
    excludedPoints,
    issues,
    wasReordered,
    hasDuplicateDates,
    hasDuplicateStudies,
    totalElapsedDays,
    totalElapsedMonths,
  };
}

/**
 * Calculates linear growth rate (mm³/month) from longitudinal observations.
 * Strictly validates and orders points by actual examination date (`date`),
 * excludes invalid/missing dates and same-day duplicates, and returns 0.0
 * when fewer than 2 valid separated observations exist.
 */
export function calculateGrowthRate(
  points: ObservationPoint[],
  thresholds: ReproTraceThresholds = DEFAULT_REPROTRACE_THRESHOLDS,
): number {
  const chronology = validateAndOrderChronology(points);
  const sorted = chronology.validPoints;
  if (sorted.length < 2) return 0.0;

  if (chronology.totalElapsedDays < Math.min(2, thresholds.minElapsedDaysForGrowthRate)) {
    return 0.0;
  }

  const t0 = parseExaminationDateMs(sorted[0].date)!;
  const x = sorted.map((p) => (parseExaminationDateMs(p.date)! - t0) / MS_PER_MONTH);
  const y = sorted.map((p) => p.volumeMm3);

  if (x[x.length - 1] - x[0] < 0.05) return 0.0;

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumXX = x.reduce((acc, xi) => acc + xi * xi, 0);

  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-6) return 0.0;

  const slope = (n * sumXY - sumX * sumY) / denom;
  return Number(slope.toFixed(2));
}

/**
 * Trajectory direction: +1 (growth), -1 (reduction), 0 (stable within ±5%).
 * If dated `ObservationPoint[]` are passed, sorts them strictly by actual examination date first.
 */
export function calculateTrend(valuesOrPoints: number[] | ObservationPoint[]): -1 | 0 | 1 {
  if (!Array.isArray(valuesOrPoints) || valuesOrPoints.length < 2) return 0;

  let first: number;
  let last: number;
  if (typeof valuesOrPoints[0] === "number") {
    const nums = (valuesOrPoints as number[]).filter((v) => Number.isFinite(v) && v >= 0);
    if (nums.length < 2) return 0;
    first = nums[0];
    last = nums[nums.length - 1];
  } else {
    const chronology = validateAndOrderChronology(valuesOrPoints as ObservationPoint[]);
    if (chronology.validPoints.length < 2) return 0;
    first = chronology.validPoints[0].volumeMm3;
    last = chronology.validPoints[chronology.validPoints.length - 1].volumeMm3;
  }

  if (last > first * 1.05) return 1;
  if (last < first * 0.95) return -1;
  return 0;
}

export interface LongitudinalDiscrepancyAttribution {
  category: ChangeAttributionCategory;
  alert: boolean;
  confidence: "high" | "moderate" | "low";
  explanation: string;
  factors: string[];
  volumeDeltaMm3: number;
  volumeDeltaPercent: number | null;
  combinedUncertaintyMm3: number;
}

/**
 * Distinguish genuine anatomical change from measurement variation across all 7 required categories:
 * 1. genuine_anatomical_change
 * 2. protocol_or_spacing_difference
 * 3. segmentation_method_difference
 * 4. registration_error_or_uncertainty
 * 5. image_quality_limitation
 * 6. within_measurement_uncertainty
 * 7. insufficient_evidence
 */
export function attributeLongitudinalChange(input: {
  priorVolumeMm3: number | null | undefined;
  currentVolumeMm3: number | null | undefined;
  priorUncertaintyMm3?: number | null;
  currentUncertaintyMm3?: number | null;
  priorSpacingMm?: [number, number, number] | null;
  currentSpacingMm?: [number, number, number] | null;
  priorMethod?: string | null;
  currentMethod?: string | null;
  priorModality?: string | null;
  currentModality?: string | null;
  registrationQualityScore?: number | null;
  registrationResidualMm?: number | null;
  registrationDegraded?: boolean;
  imageQualityDegraded?: boolean;
  partialCoverageOrArtifact?: boolean;
  elapsedDays?: number | null;
  thresholds?: ReproTraceThresholds;
}): LongitudinalDiscrepancyAttribution {
  const thresholds = input.thresholds ?? DEFAULT_REPROTRACE_THRESHOLDS;
  const factors: string[] = [];

  if (
    input.priorVolumeMm3 == null ||
    input.currentVolumeMm3 == null ||
    !Number.isFinite(input.priorVolumeMm3) ||
    !Number.isFinite(input.currentVolumeMm3) ||
    input.priorVolumeMm3 <= 0 ||
    input.currentVolumeMm3 < 0
  ) {
    return {
      category: "insufficient_evidence",
      alert: false,
      confidence: "low",
      explanation:
        "Insufficient physical volume or geometric metadata to compare longitudinal measurements reliably.",
      factors: ["missing_or_invalid_physical_volume"],
      volumeDeltaMm3: 0,
      volumeDeltaPercent: null,
      combinedUncertaintyMm3: 0,
    };
  }

  const v1 = input.priorVolumeMm3;
  const v2 = input.currentVolumeMm3;
  const deltaMm3 = v2 - v1;
  const absDeltaMm3 = Math.abs(deltaMm3);
  const deltaRatio = absDeltaMm3 / v1;
  const deltaPercent = (deltaMm3 / v1) * 100;

  const voxelVol1 = input.priorSpacingMm
    ? input.priorSpacingMm[0] * input.priorSpacingMm[1] * input.priorSpacingMm[2]
    : 0;
  const voxelVol2 = input.currentSpacingMm
    ? input.currentSpacingMm[0] * input.currentSpacingMm[1] * input.currentSpacingMm[2]
    : 0;

  const u1 = input.priorUncertaintyMm3 ?? Math.max(v1 * 0.06, voxelVol1 * 4);
  const u2 = input.currentUncertaintyMm3 ?? Math.max(v2 * 0.06, voxelVol2 * 4);
  const combinedUncertaintyMm3 = Math.hypot(u1, u2);

  if (input.imageQualityDegraded || input.partialCoverageOrArtifact) {
    factors.push("image_quality_or_coverage_limitation");
    return {
      category: "image_quality_limitation",
      alert: deltaRatio >= 0.2,
      confidence: "low",
      explanation:
        "Observed measurement difference may be affected by degraded image quality, motion artifact, or incomplete anatomical slice coverage.",
      factors,
      volumeDeltaMm3: deltaMm3,
      volumeDeltaPercent: deltaPercent,
      combinedUncertaintyMm3,
    };
  }

  const regResidual = input.registrationResidualMm ?? 0;
  const regScore = input.registrationQualityScore ?? 1.0;
  if (
    input.registrationDegraded ||
    regResidual > thresholds.maxAcceptableRegistrationResidualMm ||
    regScore < thresholds.minRegistrationQualityScore
  ) {
    factors.push(
      `registration_uncertainty(score=${regScore.toFixed(2)},residual=${regResidual.toFixed(1)}mm)`,
    );
    return {
      category: "registration_error_or_uncertainty",
      alert: true,
      confidence: "low",
      explanation: `Spatial alignment uncertainty (registration score ${regScore.toFixed(2)}, residual ${regResidual.toFixed(1)} mm) limits longitudinal comparison reliability; clinician verification required.`,
      factors,
      volumeDeltaMm3: deltaMm3,
      volumeDeltaPercent: deltaPercent,
      combinedUncertaintyMm3,
    };
  }

  if (absDeltaMm3 <= combinedUncertaintyMm3 || deltaRatio < 0.08) {
    factors.push("within_volumetric_uncertainty_bounds");
    return {
      category: "within_measurement_uncertainty",
      alert: false,
      confidence: "high",
      explanation: `Volume difference (${deltaPercent.toFixed(1)}%, ${deltaMm3.toFixed(0)} mm³) is within combined physical measurement uncertainty (±${combinedUncertaintyMm3.toFixed(0)} mm³).`,
      factors,
      volumeDeltaMm3: deltaMm3,
      volumeDeltaPercent: deltaPercent,
      combinedUncertaintyMm3,
    };
  }

  if (input.priorMethod && input.currentMethod && input.priorMethod !== input.currentMethod) {
    factors.push(`method_mismatch(${input.priorMethod}->${input.currentMethod})`);
    return {
      category: "segmentation_method_difference",
      alert: deltaRatio >= 0.2,
      confidence: "moderate",
      explanation: `Measurements were produced by different segmentation methods ('${input.priorMethod}' vs '${input.currentMethod}'); boundary definition differences may account for part of the ${deltaPercent.toFixed(1)}% volume change.`,
      factors,
      volumeDeltaMm3: deltaMm3,
      volumeDeltaPercent: deltaPercent,
      combinedUncertaintyMm3,
    };
  }

  if (input.priorModality && input.currentModality && input.priorModality !== input.currentModality) {
    factors.push(`modality_mismatch(${input.priorModality}->${input.currentModality})`);
    return {
      category: "protocol_or_spacing_difference",
      alert: deltaRatio >= 0.2,
      confidence: "moderate",
      explanation: `Measurements were acquired on different imaging modalities ('${input.priorModality}' vs '${input.currentModality}').`,
      factors,
      volumeDeltaMm3: deltaMm3,
      volumeDeltaPercent: deltaPercent,
      combinedUncertaintyMm3,
    };
  }

  if (voxelVol1 > 0 && voxelVol2 > 0) {
    const spacingVolDiffRatio =
      Math.abs(voxelVol1 - voxelVol2) / Math.min(voxelVol1, voxelVol2);
    const sliceThicknessDiff =
      input.priorSpacingMm && input.currentSpacingMm
        ? Math.abs(input.priorSpacingMm[2] - input.currentSpacingMm[2])
        : 0;
    if (
      spacingVolDiffRatio >= thresholds.spacingDifferenceRatioThreshold ||
      sliceThicknessDiff > thresholds.maxSliceThicknessGapMm
    ) {
      factors.push(
        `voxel_spacing_difference(voxelVolRatio=${spacingVolDiffRatio.toFixed(2)},sliceDelta=${sliceThicknessDiff.toFixed(1)}mm)`,
      );
      return {
        category: "protocol_or_spacing_difference",
        alert: deltaRatio >= 0.2,
        confidence: "moderate",
        explanation: `Imaging acquisition voxel geometry changed significantly between studies (slice thickness delta ${sliceThicknessDiff.toFixed(1)} mm); partial-volume effects may contribute to the ${deltaPercent.toFixed(1)}% difference.`,
        factors,
        volumeDeltaMm3: deltaMm3,
        volumeDeltaPercent: deltaPercent,
        combinedUncertaintyMm3,
      };
    }
  }

  if (input.elapsedDays !== undefined && input.elapsedDays !== null && input.elapsedDays < 2) {
    factors.push(`short_interval(${input.elapsedDays.toFixed(1)}d)`);
    return {
      category: "insufficient_evidence",
      alert: true,
      confidence: "low",
      explanation: `Apparent volume change (${deltaPercent.toFixed(1)}%) over a sub-48-hour interval (${input.elapsedDays.toFixed(1)} days) suggests technical variation rather than biological remodeling.`,
      factors,
      volumeDeltaMm3: deltaMm3,
      volumeDeltaPercent: deltaPercent,
      combinedUncertaintyMm3,
    };
  }

  factors.push("consistent_methodology_and_geometry");
  return {
    category: "genuine_anatomical_change",
    alert: deltaRatio >= 0.15,
    confidence: "high",
    explanation: `Volume changed by ${deltaPercent >= 0 ? "+" : ""}${deltaPercent.toFixed(1)}% (${deltaMm3 >= 0 ? "+" : ""}${deltaMm3.toFixed(0)} mm³), exceeding combined measurement uncertainty (±${combinedUncertaintyMm3.toFixed(0)} mm³) under consistent segmentation and acquisition geometry.`,
    factors,
    volumeDeltaMm3: deltaMm3,
    volumeDeltaPercent: deltaPercent,
    combinedUncertaintyMm3,
  };
}

/**
 * Evaluates whether longitudinal trajectory requires clinician notification.
 * Validates chronology strictly before computing growth rate.
 */
export function evaluateLongitudinalAlert(
  points: ObservationPoint[],
  thresholds: ReproTraceThresholds = DEFAULT_REPROTRACE_THRESHOLDS,
): LongitudinalAlert | null {
  const chronology = validateAndOrderChronology(points);
  if (chronology.validPoints.length < 2) return null;

  const growthRate = calculateGrowthRate(chronology.validPoints, thresholds);
  const first = chronology.validPoints[0];
  const last = chronology.validPoints[chronology.validPoints.length - 1];

  const attribution = attributeLongitudinalChange({
    priorVolumeMm3: first.volumeMm3,
    currentVolumeMm3: last.volumeMm3,
    priorUncertaintyMm3: first.uncertaintyMm3,
    currentUncertaintyMm3: last.uncertaintyMm3,
    priorSpacingMm: first.spacingMm,
    currentSpacingMm: last.spacingMm,
    priorMethod: first.method,
    currentMethod: last.method,
    elapsedDays: chronology.totalElapsedDays,
    thresholds,
  });

  if (growthRate > thresholds.rapidGrowthAlertMm3PerMonth) {
    return {
      type: "rapid_growth",
      message: `Accelerated lesion expansion detected: +${growthRate} mm³/month (unvalidated threshold >${thresholds.rapidGrowthAlertMm3PerMonth} mm³/mo). Recommend expedited clinician review.`,
      growthRateMm3PerMonth: growthRate,
      attributionCategory: attribution.category,
      chronologyIssues: chronology.issues,
    };
  } else if (growthRate < -thresholds.rapidGrowthAlertMm3PerMonth) {
    return {
      type: "significant_reduction",
      message: `Significant volume reduction noted: ${growthRate} mm³/month. Correlate with hormonal therapy or embolization response.`,
      growthRateMm3PerMonth: growthRate,
      attributionCategory: attribution.category,
      chronologyIssues: chronology.issues,
    };
  }

  return {
    type: "stable",
    message: `Lesion dimensions stable (${growthRate} mm³/month). Continue standard surveillance.`,
    growthRateMm3PerMonth: growthRate,
    attributionCategory: attribution.category,
    chronologyIssues: chronology.issues,
  };
}
