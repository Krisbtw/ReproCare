/**
 * ReproTrace Cross-Examination Matching logic.
 * Computes spatial correspondence and volumetric consistency across longitudinal findings
 * using the unified 3D rigid transformation representation, physical-space uncertainty,
 * 3D shape similarity, and registration quality gating.
 */
import type { Vec3 } from "../imaging/volume.ts";
import {
  transformPoint,
  validateTransformMatrix,
  type Matrix3x3,
  type Matrix4x4,
  type RegistrationTransform,
} from "../imaging/registration.ts";
import {
  evaluateRegistrationEntry,
  type RegistrationLookupEntry,
  type RegistrationQualityInfo,
} from "./engine.ts";
import {
  DEFAULT_REPROTRACE_THRESHOLDS,
  type ChangeAttributionCategory,
  type CorrespondenceOutcome,
  type ReproTraceThresholds,
} from "./params.ts";
import { attributeLongitudinalChange } from "./trends.ts";

export interface FindingCoord {
  x: number;
  y: number;
  z: number;
}

export interface FindingItem {
  id: string;
  anatomicalLabel: string;
  coordinates: FindingCoord | Vec3;
  volume: number;
  studyUID: string;
  seriesUID?: string;
  studyId?: string;
  seriesId?: string;
  anatomicalFindings?: string[];
  laterality?: string | null;
  figoType?: string | null;
  axesMm?: [number, number, number] | null;
  spacingMm?: [number, number, number] | null;
  uncertaintyMm?: number | null;
  uncertaintyMm3?: number | null;
  studyDate?: string | null;
  method?: string | null;
}

export interface RegistrationResultTransform {
  id?: string | null;
  supported?: boolean;
  status?: "verified" | "unverified" | "failed";
  ncc?: number | null;
  nccScore?: number | null;
  residualMm?: number | null;
  fixedStudyId?: string | null;
  movingStudyId?: string | null;
  fixedSeriesId?: string | null;
  movingSeriesId?: string | null;
  matrix?: Matrix4x4 | number[] | number[][] | null;
  transform?:
    | RegistrationTransform
    | Matrix4x4
    | number[]
    | number[][]
    | {
        translation: FindingCoord | Vec3;
        rotation?: FindingCoord | Matrix3x3;
      }
    | null;
}

export interface MatchResult {
  confidence: "high" | "medium" | "low";
  type: "likely_same" | "potentially_new" | "requires_review" | "uncertain" | "confirmed_match" | "possible_resolved";
  outcome: CorrespondenceOutcome;
  spatialDistance: number;
  uncertaintyMm: number;
  shapeSimilarity: number;
  volumeDeltaRatio: number;
  attributionCategory: ChangeAttributionCategory;
  provisional: boolean;
  registrationQuality: RegistrationQualityInfo;
  rationale: string;
}

function toVec3(coord: FindingCoord | Vec3): Vec3 {
  if (Array.isArray(coord)) {
    if (coord.length !== 3 || coord.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      throw new Error("Invalid 3D coordinate array: expected three finite numbers [x, y, z] in mm.");
    }
    return [coord[0], coord[1], coord[2]];
  }
  if (
    !coord ||
    typeof coord !== "object" ||
    typeof coord.x !== "number" ||
    typeof coord.y !== "number" ||
    typeof coord.z !== "number" ||
    !Number.isFinite(coord.x) ||
    !Number.isFinite(coord.y) ||
    !Number.isFinite(coord.z)
  ) {
    throw new Error("Invalid FindingCoord: expected finite { x, y, z } in mm.");
  }
  return [coord.x, coord.y, coord.z];
}

function unwrapTransformInput(
  registration?:
    | RegistrationResultTransform
    | RegistrationTransform
    | Matrix4x4
    | number[]
    | number[][]
    | null,
): unknown {
  if (!registration) return null;
  if (Array.isArray(registration)) return registration;
  if (typeof registration === "object" && "transform" in registration && registration.transform != null) {
    return registration.transform;
  }
  if (
    typeof registration === "object" &&
    "matrix" in registration &&
    (registration as { matrix?: unknown }).matrix != null
  ) {
    return (registration as { matrix?: unknown }).matrix;
  }
  return registration;
}

/**
 * Compute 3D aspect-ratio / shape similarity in [0, 1] from principal axes (mm).
 * Invariant to uniform isotropic scaling so a lesion that grows uniformly still has
 * high shape similarity (~1.0).
 */
export function computeShapeSimilarity(
  axesA?: [number, number, number] | null,
  axesB?: [number, number, number] | null,
): number {
  if (!axesA || !axesB) return 0.85;
  const sortedA = [...axesA].map((x) => Math.max(0.1, x)).sort((a, b) => b - a);
  const sortedB = [...axesB].map((x) => Math.max(0.1, x)).sort((a, b) => b - a);

  const elongationA = sortedA[1] / sortedA[0];
  const flatnessA = sortedA[2] / sortedA[0];
  const elongationB = sortedB[1] / sortedB[0];
  const flatnessB = sortedB[2] / sortedB[0];

  const diff = Math.hypot(elongationA - elongationB, flatnessA - flatnessB);
  return Math.max(0, Math.min(1, 1 - diff / Math.SQRT2));
}

/**
 * Evaluate whether two anatomical location / laterality / FIGO descriptors are compatible
 * vs contradictory (e.g., uterus vs ovary, anterior vs posterior, left vs right).
 */
export function evaluateAnatomicalCompatibility(
  f1: Pick<FindingItem, "anatomicalLabel" | "laterality" | "figoType">,
  f2: Pick<FindingItem, "anatomicalLabel" | "laterality" | "figoType">,
): { compatible: boolean; contradictory: boolean; score: number; reason: string } {
  const l1 = (f1.anatomicalLabel || "").trim().toLowerCase();
  const l2 = (f2.anatomicalLabel || "").trim().toLowerCase();
  const lat1 = (f1.laterality || "").trim().toLowerCase();
  const lat2 = (f2.laterality || "").trim().toLowerCase();

  if (
    (lat1 === "left" && lat2 === "right") ||
    (lat1 === "right" && lat2 === "left") ||
    (l1.includes("left") && l2.includes("right")) ||
    (l1.includes("right") && l2.includes("left"))
  ) {
    return {
      compatible: false,
      contradictory: true,
      score: 0,
      reason: "Opposing lateralities (left vs right)",
    };
  }

  if (
    (l1.includes("anterior") && l2.includes("posterior")) ||
    (l1.includes("posterior") && l2.includes("anterior")) ||
    (l1.includes("uterus") && l2.includes("ovary")) ||
    (l1.includes("ovary") && l2.includes("uterus")) ||
    (l1.includes("fundus") && l2.includes("cervix")) ||
    (l1.includes("cervix") && l2.includes("fundus"))
  ) {
    return {
      compatible: false,
      contradictory: true,
      score: 0,
      reason: `Contradictory anatomical site ('${f1.anatomicalLabel}' vs '${f2.anatomicalLabel}')`,
    };
  }

  if (l1 === l2) {
    return { compatible: true, contradictory: false, score: 1.0, reason: "Matching anatomical label" };
  }
  if (l1 && l2 && (l1.includes(l2) || l2.includes(l1))) {
    return { compatible: true, contradictory: false, score: 0.85, reason: "Compatible anatomical site" };
  }
  return {
    compatible: false,
    contradictory: true,
    score: 0.1,
    reason: `Anatomical label mismatch ('${f1.anatomicalLabel}' vs '${f2.anatomicalLabel}')`,
  };
}

/**
 * Calculates Euclidean distance (in mm) between two 3D anatomical coordinates after applying
 * the validated registration transformation from moving (coord2) to fixed (coord1) space.
 */
export function calculateSpatialDistance(
  coord1: FindingCoord | Vec3,
  coord2: FindingCoord | Vec3,
  registration?:
    | RegistrationResultTransform
    | RegistrationTransform
    | Matrix4x4
    | number[]
    | number[][]
    | null,
): number {
  const pFixed = toVec3(coord1);
  const pMoving = toVec3(coord2);

  let pMovingInFixed: Vec3 = pMoving;
  if (registration != null) {
    const rawTx = unwrapTransformInput(registration);
    const validation = validateTransformMatrix(rawTx);
    if (!validation.valid || !validation.transform) {
      throw new Error(`Invalid registration transformation: ${validation.reason ?? "validation failed"}`);
    }
    pMovingInFixed = transformPoint(pMoving, validation.transform);
  }

  const dx = pFixed[0] - pMovingInFixed[0];
  const dy = pFixed[1] - pMovingInFixed[1];
  const dz = pFixed[2] - pMovingInFixed[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Evaluates whether two findings from paired studies/series correspond to the same lesion.
 *
 * Key guarantees:
 * 1. Explicitly prevents `likely_same` matching when registration is missing across different studies/series,
 *    when registration failed, when the transformation matrix is invalid, or when registration quality is insufficient.
 * 2. Matches a growing or shrinking lesion at the same registered patient-space coordinate (`spatialDistance <= 12 mm`)
 *    and compatible anatomical location as `likely_same` (`probable_match_review_required`), never misclassifying
 *    a growing lesion at the same site as a brand-new lesion (`potentially_new`) when its shape/site are consistent!
 * 3. Distinct lesions separated beyond physical thresholds or in contradictory anatomical locations
 *    are never matched together.
 */
export function matchFindings(
  finding1: FindingItem,
  finding2: FindingItem,
  registration?: RegistrationResultTransform | RegistrationLookupEntry | null,
  options?: {
    clinicianDecision?: "accept" | "reject" | "defer" | null;
    thresholds?: ReproTraceThresholds;
  },
): MatchResult {
  const thresholds = options?.thresholds ?? DEFAULT_REPROTRACE_THRESHOLDS;
  const study1 = finding1.studyId ?? finding1.studyUID;
  const study2 = finding2.studyId ?? finding2.studyUID;
  const series1 = finding1.seriesId ?? finding1.seriesUID ?? null;
  const series2 = finding2.seriesId ?? finding2.seriesUID ?? null;

  const sameStudyAndSeries =
    study1 === study2 && (series1 === null || series2 === null || series1 === series2);

  let regEntry: RegistrationLookupEntry | null = null;
  if (registration != null) {
    if (
      typeof registration === "object" &&
      !Array.isArray(registration) &&
      ("transform" in registration ||
        "matrix" in registration ||
        "status" in registration ||
        "supported" in registration)
    ) {
      const rObj = registration as RegistrationResultTransform;
      regEntry = {
        ...(rObj as unknown as RegistrationLookupEntry),
        transform: (rObj.transform ?? rObj.matrix ?? null) as RegistrationLookupEntry["transform"],
      };
    } else {
      regEntry = {
        status: "verified",
        supported: true,
        transform: registration as unknown as RegistrationTransform,
      };
    }
  } else if (sameStudyAndSeries) {
    regEntry = {
      status: "verified",
      supported: true,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      fixedStudyId: study1,
      movingStudyId: study2,
      fixedSeriesId: series1,
      movingSeriesId: series2,
    };
  }

  const evaluated = evaluateRegistrationEntry(regEntry, {
    fromStudyId: study1,
    toStudyId: study2,
    fromSeriesId: series1,
    toSeriesId: series2,
  });

  const p1 = toVec3(finding1.coordinates);
  const p2 = toVec3(finding2.coordinates);

  const u1Mm =
    finding1.uncertaintyMm ??
    (finding1.spacingMm ? 0.5 * Math.hypot(...finding1.spacingMm) : 2.0);
  const u2Mm =
    finding2.uncertaintyMm ??
    (finding2.spacingMm ? 0.5 * Math.hypot(...finding2.spacingMm) : 2.0);
  const regResidual = evaluated.quality.residualMm ?? 0;
  const combinedUncertaintyMm = Number(Math.hypot(u1Mm, u2Mm, regResidual).toFixed(2));
  const shapeSimilarity = Number(
    computeShapeSimilarity(finding1.axesMm, finding2.axesMm).toFixed(4),
  );
  const baseVol = Math.max(finding1.volume, 1e-4);
  const volumeDelta = Number((Math.abs(finding1.volume - finding2.volume) / baseVol).toFixed(4));

  // If registration is unsupported (missing, failed, invalid matrix, series mismatch, or low quality),
  // never silently treat the two findings as the same lesion.
  if (!evaluated.quality.supported || !evaluated.transform) {
    const rawDist = calculateSpatialDistance(p1, p2, null);
    return {
      confidence: "low",
      type: "requires_review",
      outcome: "uncertain_correspondence",
      spatialDistance: Number(rawDist.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: "registration_error_or_uncertainty",
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: evaluated.quality.notes.join(". ") || "Spatial correspondence could not be established.",
    };
  }

  const spatialDistance = calculateSpatialDistance(p1, p2, evaluated.transform);
  const anatomy = evaluateAnatomicalCompatibility(finding1, finding2);

  const attribution = attributeLongitudinalChange({
    priorVolumeMm3: finding1.volume,
    currentVolumeMm3: finding2.volume,
    priorUncertaintyMm3: finding1.uncertaintyMm3,
    currentUncertaintyMm3: finding2.uncertaintyMm3,
    priorSpacingMm: finding1.spacingMm,
    currentSpacingMm: finding2.spacingMm,
    priorMethod: finding1.method,
    currentMethod: finding2.method,
    registrationQualityScore: evaluated.quality.nccScore,
    registrationResidualMm: evaluated.quality.residualMm,
    thresholds,
  });

  if (options?.clinicianDecision === "accept") {
    return {
      confidence: "high",
      type: "confirmed_match",
      outcome: "confirmed_match",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: attribution.category,
      provisional: false,
      registrationQuality: evaluated.quality,
      rationale: `Clinician confirmed longitudinal match (${spatialDistance.toFixed(2)} mm in registered patient space).`,
    };
  }

  if (options?.clinicianDecision === "reject") {
    return {
      confidence: "low",
      type: "potentially_new",
      outcome: "possible_new_finding",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: "insufficient_evidence",
      provisional: false,
      registrationQuality: evaluated.quality,
      rationale: "Clinician rejected correspondence; treated as distinct finding.",
    };
  }

  // Contradictory anatomy (e.g. uterus vs ovary, left vs right, anterior vs posterior) -> requires_review
  if (!anatomy.compatible || anatomy.contradictory) {
    return {
      confidence: "low",
      type: "requires_review",
      outcome: "uncertain_correspondence",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: "insufficient_evidence",
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: `Spatial distance (${spatialDistance.toFixed(2)} mm) or anatomical label mismatch (${anatomy.reason}) requires clinician review.`,
    };
  }

  // Adaptive physical-space distance threshold accounting for voxel spacing & registration residual
  const highConfDistMm = Math.max(12.0, combinedUncertaintyMm * 2.0);
  const maxMatchDistMm = Math.max(thresholds.distSameMm, combinedUncertaintyMm * 3.0);

  if (spatialDistance <= highConfDistMm && shapeSimilarity >= 0.5 && volumeDelta <= 3.0) {
    // Same anatomical site and within high-confidence registered coordinate tolerance:
    // Even if the lesion grew or shrank (e.g. +50% or -40%), it is the SAME lesion!
    const isStableVolume = volumeDelta < 0.2;
    return {
      confidence: isStableVolume ? "high" : "medium",
      type: "likely_same",
      outcome: "probable_match_review_required",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: attribution.category,
      provisional: !isStableVolume || evaluated.quality.status !== "verified",
      registrationQuality: evaluated.quality,
      rationale: `Matched within ${spatialDistance.toFixed(2)} mm (±${combinedUncertaintyMm.toFixed(1)} mm) in registered space (volume delta ${(volumeDelta * 100).toFixed(1)}%, attribution: ${attribution.category}). ${evaluated.quality.notes.join(". ")}`,
    };
  } else if (spatialDistance <= maxMatchDistMm) {
    return {
      confidence: "medium",
      type: "uncertain",
      outcome: "uncertain_correspondence",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: attribution.category,
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: `Moderate spatial separation (${spatialDistance.toFixed(2)} mm ± ${combinedUncertaintyMm.toFixed(1)} mm) or volume change (${(volumeDelta * 100).toFixed(1)}%) requires clinician review.`,
    };
  } else if (spatialDistance > thresholds.distFarMm) {
    return {
      confidence: "low",
      type: "potentially_new",
      outcome: "possible_new_finding",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: "insufficient_evidence",
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: `Spatial separation (${spatialDistance.toFixed(2)} mm) exceeds physical threshold (${thresholds.distFarMm} mm); distinct lesion / possible new finding.`,
    };
  } else {
    return {
      confidence: "low",
      type: "requires_review",
      outcome: "uncertain_correspondence",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      uncertaintyMm: combinedUncertaintyMm,
      shapeSimilarity,
      volumeDeltaRatio: volumeDelta,
      attributionCategory: attribution.category,
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: `Spatial distance (${spatialDistance.toFixed(2)} mm) requires clinician review.`,
    };
  }
}
