/**
 * Named parameters and uncertainty calculations for ReproTrace longitudinal analysis.
 *
 * NOTE ON CLINICAL VALIDATION:
 * All constants in this file are research heuristics and empirical defaults.
 * They have not been clinically validated for standalone medical diagnosis and are
 * clearly labeled as "unvalidated thresholds" throughout the application.
 */

export interface ReproTraceParameterMeta {
  name: string;
  value: number | string;
  unit: string;
  source: string;
  isClinicallyValidated: boolean;
  clinicalNote: string;
}

export const REPROTRACE_PARAMS = {
  /** Spatial distance below which findings are considered likely candidates for the same lesion */
  DIST_SAME_MM: 18.0,
  /** Maximum spatial distance beyond which findings are considered distinct lesions */
  DIST_FAR_MM: 40.0,
  /** Minimum similarity score required to propose a correspondence between two observations */
  PAIR_FLOOR_SCORE: 0.62,
  /** Maximum allowable difference in slice thickness before flagging an acquisition difference */
  MAX_SLICE_THICKNESS_GAP_MM: 2.0,
  /** Relative volumetric uncertainty threshold (15% default for manual/semi-automated segmentation) */
  RELATIVE_VOLUME_UNCERTAINTY: 0.15,
  /** Monthly growth rate above which rapid progression review is flagged */
  RAPID_GROWTH_ALERT_MM3_PER_MONTH: 500.0,
} as const;

export const REPROTRACE_METADATA: Record<string, ReproTraceParameterMeta> = {
  DIST_SAME_MM: {
    name: "Likely Same Lesion Distance",
    value: REPROTRACE_PARAMS.DIST_SAME_MM,
    unit: "mm",
    source: "Empirical heuristic from pelvic anatomical mobility and respiratory variation",
    isClinicallyValidated: false,
    clinicalNote: "Pelvic organs (uterus, ovaries) shift relative to bladder/rectal filling. 18 mm accounts for typical physiological displacement.",
  },
  DIST_FAR_MM: {
    name: "Distinct Lesion Distance",
    value: REPROTRACE_PARAMS.DIST_FAR_MM,
    unit: "mm",
    source: "AnatomyBridge geometric baseline",
    isClinicallyValidated: false,
    clinicalNote: "Lesions separated by >40 mm in the pelvis are rarely the same anatomical structure.",
  },
  PAIR_FLOOR_SCORE: {
    name: "Pairing Floor Score",
    value: REPROTRACE_PARAMS.PAIR_FLOOR_SCORE,
    unit: "ratio (0-1)",
    source: "ReproTrace ruleset v1",
    isClinicallyValidated: false,
    clinicalNote: "Floor threshold to prevent spurious correspondence proposals in complex multi-fibroid cases.",
  },
  RAPID_GROWTH_ALERT_MM3_PER_MONTH: {
    name: "Rapid Growth Alert Threshold",
    value: REPROTRACE_PARAMS.RAPID_GROWTH_ALERT_MM3_PER_MONTH,
    unit: "mm³/month",
    source: "Clinical review threshold for leiomyoma growth surveillance",
    isClinicallyValidated: false,
    clinicalNote: "Used to prioritize findings for clinician review. Does not equate to malignancy or leiomyosarcoma.",
  },
};

export interface AcquisitionCharacteristics {
  modality: string;
  sliceThicknessMm?: number | null;
  plane?: string | null;
  measurementBasis?: string | null;
}

export type LongitudinalChangeCategory =
  | "within_uncertainty"
  | "genuine_change_candidate"
  | "acquisition_difference"
  | "segmentation_difference"
  | "insufficient_evidence";

export interface LongitudinalComparisonResult {
  category: LongitudinalChangeCategory;
  absoluteChangeMm3: number;
  relativeChangePercent: number;
  combinedUncertaintyMm3: number;
  monthlyGrowthRateMm3: number;
  isRapidGrowth: boolean;
  notes: string[];
}

/**
 * Computes volumetric boundary uncertainty from volume and voxel spacing.
 * Accounts for 0.5-voxel partial volume uncertainty across the structure's surface area.
 */
export function computeVoxelBoundaryUncertainty(
  volumeMm3: number,
  voxelSpacingMm: [number, number, number] = [1.0, 1.0, 3.0],
): number {
  if (volumeMm3 <= 0) return 0;
  // Radius of equivalent sphere: r = ((3 * V) / (4 * pi))^(1/3)
  const r = Math.cbrt((3 * volumeMm3) / (4 * Math.PI));
  // Surface area: 4 * pi * r^2
  const surfaceArea = 4 * Math.PI * r * r;
  // Effective boundary margin (0.5 times minimum voxel spacing)
  const marginMm = 0.5 * Math.min(...voxelSpacingMm);
  return surfaceArea * marginMm;
}

/**
 * Evaluates whether an observed volumetric change exceeds combined measurement uncertainty
 * and validates that acquisition parameters are compatible for direct comparison.
 */
export function evaluateLongitudinalChange(
  v1Mm3: number,
  v2Mm3: number,
  daysBetween: number,
  acq1?: AcquisitionCharacteristics,
  acq2?: AcquisitionCharacteristics,
  voxelSpacingMm?: [number, number, number],
): LongitudinalComparisonResult {
  const notes: string[] = [];
  const delta = v2Mm3 - v1Mm3;
  const months = Math.max(0.1, daysBetween / 30.4375);
  const monthlyRate = delta / months;
  const relChange = v1Mm3 > 0 ? (delta / v1Mm3) * 100 : 0;

  // 1. Check acquisition compatibility
  if (acq1 && acq2) {
    if (acq1.modality !== acq2.modality) {
      notes.push(`Modalities differ (${acq1.modality} vs ${acq2.modality}) — direct volume comparison is limited`);
      return {
        category: "acquisition_difference",
        absoluteChangeMm3: delta,
        relativeChangePercent: relChange,
        combinedUncertaintyMm3: 0,
        monthlyGrowthRateMm3: monthlyRate,
        isRapidGrowth: false,
        notes,
      };
    }
    if (
      acq1.sliceThicknessMm != null &&
      acq2.sliceThicknessMm != null &&
      Math.abs(acq1.sliceThicknessMm - acq2.sliceThicknessMm) > REPROTRACE_PARAMS.MAX_SLICE_THICKNESS_GAP_MM
    ) {
      notes.push(
        `Slice thickness difference (${acq1.sliceThicknessMm}mm vs ${acq2.sliceThicknessMm}mm) exceeds ${REPROTRACE_PARAMS.MAX_SLICE_THICKNESS_GAP_MM}mm tolerance`,
      );
      return {
        category: "acquisition_difference",
        absoluteChangeMm3: delta,
        relativeChangePercent: relChange,
        combinedUncertaintyMm3: 0,
        monthlyGrowthRateMm3: monthlyRate,
        isRapidGrowth: false,
        notes,
      };
    }
    if (
      acq1.measurementBasis &&
      acq2.measurementBasis &&
      acq1.measurementBasis !== acq2.measurementBasis
    ) {
      notes.push(`Measurement basis differs: '${acq1.measurementBasis}' vs '${acq2.measurementBasis}'`);
      return {
        category: "segmentation_difference",
        absoluteChangeMm3: delta,
        relativeChangePercent: relChange,
        combinedUncertaintyMm3: 0,
        monthlyGrowthRateMm3: monthlyRate,
        isRapidGrowth: false,
        notes,
      };
    }
  }

  // 2. Compute combined uncertainty
  const u1 = computeVoxelBoundaryUncertainty(v1Mm3, voxelSpacingMm);
  const u2 = computeVoxelBoundaryUncertainty(v2Mm3, voxelSpacingMm);
  const combinedUncertainty = Math.sqrt(u1 * u1 + u2 * u2);

  // 3. Compare change against uncertainty
  let category: LongitudinalChangeCategory = "within_uncertainty";
  if (Math.abs(delta) > combinedUncertainty) {
    category = "genuine_change_candidate";
    notes.push(
      `Observed change (${Math.abs(delta).toFixed(0)} mm³) exceeds combined boundary uncertainty (${combinedUncertainty.toFixed(0)} mm³)`,
    );
  } else {
    notes.push(
      `Observed change (${Math.abs(delta).toFixed(0)} mm³) is within boundary uncertainty margin (${combinedUncertainty.toFixed(0)} mm³)`,
    );
  }

  const isRapidGrowth =
    category === "genuine_change_candidate" &&
    monthlyRate > REPROTRACE_PARAMS.RAPID_GROWTH_ALERT_MM3_PER_MONTH;

  if (isRapidGrowth) {
    notes.push(
      `Growth rate (${monthlyRate.toFixed(1)} mm³/mo) exceeds ${REPROTRACE_PARAMS.RAPID_GROWTH_ALERT_MM3_PER_MONTH} mm³/mo review alert`,
    );
  }

  return {
    category,
    absoluteChangeMm3: delta,
    relativeChangePercent: relChange,
    combinedUncertaintyMm3: combinedUncertainty,
    monthlyGrowthRateMm3: monthlyRate,
    isRapidGrowth,
    notes,
  };
}

