/**
 * Named parameters, configurable thresholds, and uncertainty calculations for
 * ReproTrace longitudinal analysis.
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

export type CorrespondenceOutcome =
  | "confirmed_match"
  | "probable_match_review_required"
  | "possible_new_finding"
  | "possible_resolved_finding"
  | "uncertain_correspondence";

export type ChangeAttributionCategory =
  | "genuine_anatomical_change"
  | "protocol_or_spacing_difference"
  | "segmentation_method_difference"
  | "registration_error_or_uncertainty"
  | "image_quality_limitation"
  | "within_measurement_uncertainty"
  | "insufficient_evidence";

export type LongitudinalChangeCategory =
  | ChangeAttributionCategory
  | "within_uncertainty"
  | "genuine_change_candidate"
  | "acquisition_difference"
  | "segmentation_difference"
  | "registration_error"
  | "image_quality_difference";

export interface ReproTraceThresholds {
  /** Spatial distance (mm) below which findings are considered likely candidates for the same lesion. */
  distSameMm: number;
  /** Maximum spatial distance (mm) beyond which findings are considered distinct lesions. */
  distFarMm: number;
  /** Minimum similarity score [0, 1] required to propose a correspondence between two observations. */
  pairFloorScore: number;
  /** Maximum allowable difference in slice thickness (mm) before flagging an acquisition difference. */
  maxSliceThicknessGapMm: number;
  /** Relative volumetric uncertainty threshold (15% default for manual/semi-automated segmentation). */
  relativeVolumeUncertainty: number;
  /** Monthly growth rate (mm³/month) above which rapid progression review is flagged. */
  rapidGrowthAlertMm3PerMonth: number;
  /** Minimum elapsed days between examinations required for reliable growth-rate extrapolation. */
  minElapsedDaysForGrowthRate: number;
  /** Relative voxel volume difference ratio above which acquisition/spacing differences must be flagged. */
  spacingDifferenceRatioThreshold: number;
  /** Maximum registration residual (mm) acceptable for high-confidence spatial correspondence. */
  maxAcceptableRegistrationResidualMm: number;
  /** Minimum registration quality / NCC score [0, 1] required for automated spatial correspondence. */
  minRegistrationQualityScore: number;
  /** Explicit flag indicating whether these parameters have been clinically validated. */
  isClinicallyValidated: false;
}

export const DEFAULT_REPROTRACE_THRESHOLDS: ReproTraceThresholds = {
  distSameMm: 18.0,
  distFarMm: 40.0,
  pairFloorScore: 0.62,
  maxSliceThicknessGapMm: 2.0,
  relativeVolumeUncertainty: 0.15,
  rapidGrowthAlertMm3PerMonth: 500.0,
  minElapsedDaysForGrowthRate: 14,
  spacingDifferenceRatioThreshold: 0.35,
  maxAcceptableRegistrationResidualMm: 15.0,
  minRegistrationQualityScore: 0.5,
  isClinicallyValidated: false,
};

export function createReproTraceConfig(
  overrides?: Partial<Omit<ReproTraceThresholds, "isClinicallyValidated">>,
): ReproTraceThresholds {
  return {
    ...DEFAULT_REPROTRACE_THRESHOLDS,
    ...(overrides ?? {}),
    isClinicallyValidated: false,
  };
}

export const REPROTRACE_PARAMS = {
  /** Spatial distance below which findings are considered likely candidates for the same lesion */
  DIST_SAME_MM: DEFAULT_REPROTRACE_THRESHOLDS.distSameMm,
  /** Maximum spatial distance beyond which findings are considered distinct lesions */
  DIST_FAR_MM: DEFAULT_REPROTRACE_THRESHOLDS.distFarMm,
  /** Minimum similarity score required to propose a correspondence between two observations */
  PAIR_FLOOR_SCORE: DEFAULT_REPROTRACE_THRESHOLDS.pairFloorScore,
  /** Maximum allowable difference in slice thickness before flagging an acquisition difference */
  MAX_SLICE_THICKNESS_GAP_MM: DEFAULT_REPROTRACE_THRESHOLDS.maxSliceThicknessGapMm,
  /** Relative volumetric uncertainty threshold (15% default for manual/semi-automated segmentation) */
  RELATIVE_VOLUME_UNCERTAINTY: DEFAULT_REPROTRACE_THRESHOLDS.relativeVolumeUncertainty,
  /** Monthly growth rate above which rapid progression review is flagged */
  RAPID_GROWTH_ALERT_MM3_PER_MONTH: DEFAULT_REPROTRACE_THRESHOLDS.rapidGrowthAlertMm3PerMonth,
  /** Minimum elapsed days between studies required to extrapolate monthly/annualized growth rates */
  MIN_ELAPSED_DAYS_FOR_GROWTH_RATE: DEFAULT_REPROTRACE_THRESHOLDS.minElapsedDaysForGrowthRate,
} as const;

export const REPROTRACE_METADATA: Record<string, ReproTraceParameterMeta> = {
  DIST_SAME_MM: {
    name: "Likely Same Lesion Distance",
    value: REPROTRACE_PARAMS.DIST_SAME_MM,
    unit: "mm",
    source: "Empirical heuristic from pelvic anatomical mobility and respiratory variation",
    isClinicallyValidated: false,
    clinicalNote:
      "Pelvic organs (uterus, ovaries) shift relative to bladder/rectal filling. 18 mm accounts for typical physiological displacement.",
  },
  DIST_FAR_MM: {
    name: "Distinct Lesion Distance",
    value: REPROTRACE_PARAMS.DIST_FAR_MM,
    unit: "mm",
    source: "AnatomyBridge geometric baseline",
    isClinicallyValidated: false,
    clinicalNote:
      "Lesions separated by >40 mm in the pelvis are rarely the same anatomical structure.",
  },
  PAIR_FLOOR_SCORE: {
    name: "Pairing Floor Score",
    value: REPROTRACE_PARAMS.PAIR_FLOOR_SCORE,
    unit: "ratio (0-1)",
    source: "ReproTrace ruleset v1",
    isClinicallyValidated: false,
    clinicalNote:
      "Floor threshold to prevent spurious correspondence proposals in complex multi-fibroid cases.",
  },
  RAPID_GROWTH_ALERT_MM3_PER_MONTH: {
    name: "Rapid Growth Alert Threshold",
    value: REPROTRACE_PARAMS.RAPID_GROWTH_ALERT_MM3_PER_MONTH,
    unit: "mm³/month",
    source: "Clinical review threshold for leiomyoma growth surveillance",
    isClinicallyValidated: false,
    clinicalNote:
      "Used to prioritize findings for clinician review. Does not equate to malignancy or leiomyosarcoma.",
  },
};

export interface AcquisitionCharacteristics {
  modality: string;
  sliceThicknessMm?: number | null;
  plane?: string | null;
  measurementBasis?: string | null;
  pixelSpacingMm?: [number, number] | null;
  imageQuality?: "adequate" | "limited" | "unknown";
}

export interface LongitudinalComparisonResult {
  category: LongitudinalChangeCategory;
  attributionCategory: ChangeAttributionCategory;
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
  if (!Number.isFinite(volumeMm3) || volumeMm3 <= 0) return 0;
  // Radius of equivalent sphere: r = ((3 * V) / (4 * pi))^(1/3)
  const r = Math.cbrt((3 * volumeMm3) / (4 * Math.PI));
  // Surface area: 4 * pi * r^2
  const surfaceArea = 4 * Math.PI * r * r;
  // Effective boundary margin (0.5 times minimum positive voxel spacing)
  const validSpacings = voxelSpacingMm.filter((s) => Number.isFinite(s) && s > 0);
  const marginMm = 0.5 * (validSpacings.length === 3 ? Math.min(...validSpacings) : 1.0);
  return surfaceArea * marginMm;
}

/**
 * Evaluates whether an observed volumetric change exceeds combined measurement uncertainty
 * and classifies the change across all 7 required attribution categories:
 * 1. genuine_anatomical_change (`genuine_change_candidate`)
 * 2. protocol_or_spacing_difference (`acquisition_difference`)
 * 3. segmentation_method_difference (`segmentation_difference`)
 * 4. registration_error_or_uncertainty (`registration_error`)
 * 5. image_quality_limitation (`image_quality_difference`)
 * 6. within_measurement_uncertainty (`within_uncertainty`)
 * 7. insufficient_evidence (`insufficient_evidence`)
 */
export function evaluateLongitudinalChange(
  v1Mm3: number,
  v2Mm3: number,
  daysBetween: number,
  acq1?: AcquisitionCharacteristics,
  acq2?: AcquisitionCharacteristics,
  voxelSpacingMm?: [number, number, number],
  options?: {
    registrationQualityScore?: number | null;
    registrationResidualMm?: number | null;
    registrationFailed?: boolean;
    thresholds?: ReproTraceThresholds;
  },
): LongitudinalComparisonResult {
  const thresholds = options?.thresholds ?? DEFAULT_REPROTRACE_THRESHOLDS;
  const notes: string[] = [];

  if (!Number.isFinite(v1Mm3) || !Number.isFinite(v2Mm3) || v1Mm3 <= 0 || v2Mm3 < 0 || !Number.isFinite(daysBetween) || daysBetween <= 0) {
    notes.push("Insufficient or invalid physical volume or time interval for longitudinal attribution");
    return {
      category: "insufficient_evidence",
      attributionCategory: "insufficient_evidence",
      absoluteChangeMm3: 0,
      relativeChangePercent: 0,
      combinedUncertaintyMm3: 0,
      monthlyGrowthRateMm3: 0,
      isRapidGrowth: false,
      notes,
    };
  }

  const delta = v2Mm3 - v1Mm3;
  const months = Math.max(0.1, daysBetween / 30.4375);
  const monthlyRate = delta / months;
  const relChange = v1Mm3 > 0 ? (delta / v1Mm3) * 100 : 0;

  // 1. Check registration error or uncertainty
  if (
    options?.registrationFailed ||
    (options?.registrationQualityScore != null &&
      options.registrationQualityScore < thresholds.minRegistrationQualityScore) ||
    (options?.registrationResidualMm != null &&
      options.registrationResidualMm > thresholds.maxAcceptableRegistrationResidualMm)
  ) {
    notes.push("Registration error or alignment uncertainty prevents reliable volumetric change attribution");
    return {
      category: "registration_error",
      attributionCategory: "registration_error_or_uncertainty",
      absoluteChangeMm3: delta,
      relativeChangePercent: relChange,
      combinedUncertaintyMm3: 0,
      monthlyGrowthRateMm3: monthlyRate,
      isRapidGrowth: false,
      notes,
    };
  }

  // 2. Check image quality limitations
  if (acq1?.imageQuality === "limited" || acq2?.imageQuality === "limited") {
    notes.push("Image quality is limited on at least one examination; apparent volume difference may reflect motion or partial coverage");
    return {
      category: "image_quality_difference",
      attributionCategory: "image_quality_limitation",
      absoluteChangeMm3: delta,
      relativeChangePercent: relChange,
      combinedUncertaintyMm3: 0,
      monthlyGrowthRateMm3: monthlyRate,
      isRapidGrowth: false,
      notes,
    };
  }

  // 3. Check acquisition & segmentation compatibility
  if (acq1 && acq2) {
    if (acq1.modality !== acq2.modality) {
      notes.push(`Modalities differ (${acq1.modality} vs ${acq2.modality}) — direct volume comparison is limited`);
      return {
        category: "acquisition_difference",
        attributionCategory: "protocol_or_spacing_difference",
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
      Math.abs(acq1.sliceThicknessMm - acq2.sliceThicknessMm) > thresholds.maxSliceThicknessGapMm
    ) {
      notes.push(
        `Slice thickness difference (${acq1.sliceThicknessMm}mm vs ${acq2.sliceThicknessMm}mm) exceeds ${thresholds.maxSliceThicknessGapMm}mm tolerance`,
      );
      return {
        category: "acquisition_difference",
        attributionCategory: "protocol_or_spacing_difference",
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
        attributionCategory: "segmentation_method_difference",
        absoluteChangeMm3: delta,
        relativeChangePercent: relChange,
        combinedUncertaintyMm3: 0,
        monthlyGrowthRateMm3: monthlyRate,
        isRapidGrowth: false,
        notes,
      };
    }
  }

  // 4. Compute combined uncertainty
  const u1 = computeVoxelBoundaryUncertainty(v1Mm3, voxelSpacingMm);
  const u2 = computeVoxelBoundaryUncertainty(v2Mm3, voxelSpacingMm);
  const combinedUncertainty = Math.sqrt(u1 * u1 + u2 * u2);

  // 5. Compare change against uncertainty
  let category: LongitudinalChangeCategory = "within_uncertainty";
  let attributionCategory: ChangeAttributionCategory = "within_measurement_uncertainty";
  if (Math.abs(delta) > combinedUncertainty) {
    category = "genuine_change_candidate";
    attributionCategory = "genuine_anatomical_change";
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
    monthlyRate > thresholds.rapidGrowthAlertMm3PerMonth;

  if (isRapidGrowth) {
    notes.push(
      `Growth rate (${monthlyRate.toFixed(1)} mm³/mo) exceeds ${thresholds.rapidGrowthAlertMm3PerMonth} mm³/mo review alert`,
    );
  }

  return {
    category,
    attributionCategory,
    absoluteChangeMm3: delta,
    relativeChangePercent: relChange,
    combinedUncertaintyMm3: combinedUncertainty,
    monthlyGrowthRateMm3: monthlyRate,
    isRapidGrowth,
    notes,
  };
}
