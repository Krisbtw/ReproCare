/** ReproTrace rules. Proposals only — nothing here merges findings. */

import type { RegistrationTransform, RegistrationTransformInput } from "../imaging/registration.ts";
import { transformPoint, validateTransformMatrix } from "../imaging/registration.ts";
import {
  DEFAULT_REPROTRACE_THRESHOLDS,
  REPROTRACE_PARAMS,
  computeVoxelBoundaryUncertainty,
  type ChangeAttributionCategory,
  type CorrespondenceOutcome,
  type ReproTraceThresholds,
} from "./params.ts";
import { computeShapeSimilarity } from "./matching.ts";
import { attributeLongitudinalChange, parseExaminationDateMs } from "./trends.ts";

export const ENGINE_VERSION = "reprotrace-rules-1";

export type MatchCategory =
  | "likely_same"
  | "confirmed_match"
  | "potentially_new"
  | "possible_resolved"
  | "uncertain"
  | "needs_review";

export type Frame = "image_registered" | "dicom_lps" | "schematic" | "unavailable";

export type Snap = {
  id: string;
  findingId: string;
  studyId: string;
  seriesId?: string | null;
  date: string;
  organ: string;
  structure: string;
  locationLabel: string;
  laterality?: string | null;
  figo?: string | null;
  modality: string;
  frame: Frame;
  centroidMm: [number, number, number] | null;
  axesMm: [number, number, number] | null;
  longestMm: number | null;
  volumeMm3?: number | null;
  spacingMm?: [number, number, number] | null;
  uncertaintyMm?: number | null;
  uncertaintyMm3?: number | null;
  basis?: string | null;
  source?: string | null;
  quality: "adequate" | "limited" | "unknown";
};

export type RegistrationQualityStatus =
  | "verified"
  | "unverified"
  | "failed"
  | "missing"
  | "insufficient_quality"
  | "invalid_transform"
  | "series_mismatch";

export type RegistrationQualityInfo = {
  id?: string | null;
  registrationId?: string | null;
  status: RegistrationQualityStatus;
  supported: boolean;
  nccScore: number | null;
  residualMm: number | null;
  matrixValid: boolean;
  fixedStudyId: string | null;
  movingStudyId: string | null;
  fixedSeriesId: string | null;
  movingSeriesId: string | null;
  notes: string[];
  /** How the transform was obtained, when recorded (e.g. "ncc_moments_3d", "externally_supplied"). */
  method?: string | null;
};

export type RegistrationLookupEntry = {
  id?: string | null;
  registrationId?: string | null;
  supported?: boolean;
  status?: "verified" | "unverified" | "failed" | "computed" | RegistrationQualityStatus;
  transform?: RegistrationTransformInput | string | null;
  ncc?: number | null;
  nccScore?: number | null;
  residualMm?: number | null;
  residualMse?: number | null;
  fixedStudyId?: string | null;
  movingStudyId?: string | null;
  fixedSeriesId?: string | null;
  movingSeriesId?: string | null;
  notes?: string[];
  method?: string | null;
};

export interface ClinicianCorrespondenceDecision {
  correspondenceId?: string;
  fromVersionId?: string | null;
  toVersionId?: string | null;
  decision: "accept" | "reject" | "defer";
  note?: string | null;
  decidedByUserId?: string | null;
  decidedAt?: string | null;
}

export type Proposal = {
  fromId: string | null;
  toId: string | null;
  fromStudyId: string | null;
  toStudyId: string | null;
  fromSeriesId?: string | null;
  toSeriesId?: string | null;
  category: MatchCategory;
  outcome?: CorrespondenceOutcome;
  score: number;
  rationale: string;
  provisional: boolean;
  distanceMm?: number | null;
  volumeDeltaPct?: number | null;
  elapsedDays?: number | null;
  growthRateMm3PerMonth?: number | null;
  uncertaintyMm?: number | null;
  uncertaintyMm3?: number | null;
  attributionCategory?: ChangeAttributionCategory;
  clinicianDecision?: "accept" | "reject" | "defer" | null;
  reviewedByUserId?: string | null;
  reviewedAt?: string | null;
  registrationQuality?: RegistrationQualityInfo | null;
  /** Other plausible counterparts when the match is ambiguous. Never auto-selected. */
  alternatives?: string[];
  /** Plain description of how (or whether) the two coordinate frames were aligned. */
  registrationAvailability?: RegistrationAvailability;
};

export type RegistrationAvailabilityKind =
  | "available_verified"
  | "externally_supplied"
  | "unavailable"
  | "failed"
  | "insufficient_quality"
  | "not_required"
  | "schematic_frame"
  | "no_coordinates";

export type RegistrationAvailability = {
  kind: RegistrationAvailabilityKind;
  label: string;
  spatialComparisonValid: boolean;
  explanation: string;
};

const EXTERNAL_REGISTRATION_METHODS = new Set([
  "manual",
  "external",
  "externally_supplied",
  "synthetic_ground_truth",
]);

/**
 * Classifies the spatial basis of a comparison so the UI can say plainly whether the distance is meaningful.
 * Pure: does not compute or claim any registration that was not supplied.
 */
export function describeRegistrationAvailability(
  a: Pick<Snap, "frame" | "centroidMm" | "studyId" | "seriesId">,
  b: Pick<Snap, "frame" | "centroidMm" | "studyId" | "seriesId">,
  quality: RegistrationQualityInfo | null | undefined,
  method?: string | null,
): RegistrationAvailability {
  if (!a.centroidMm || !b.centroidMm || a.frame === "unavailable" || b.frame === "unavailable") {
    return {
      kind: "no_coordinates",
      label: "No spatial coordinates",
      spatialComparisonValid: false,
      explanation:
        "At least one observation has no stored patient-space coordinate, so no spatial distance can be computed. Matching relies on anatomical labels and measurements only.",
    };
  }
  if (a.frame === "schematic" || b.frame === "schematic") {
    return {
      kind: "schematic_frame",
      label: "Schematic coordinates only",
      spatialComparisonValid: false,
      explanation:
        "Coordinates are teaching-schematic placements, not positions measured in source images. The distance is illustrative and cannot establish correspondence.",
    };
  }
  const sameSeries = a.studyId === b.studyId && (a.seriesId ?? null) === (b.seriesId ?? null);
  if (sameSeries && !quality) {
    return {
      kind: "not_required",
      label: "Same series — no registration needed",
      spatialComparisonValid: true,
      explanation: "Both observations are in the same image series and therefore the same coordinate frame.",
    };
  }
  if (!quality || quality.status === "missing") {
    return {
      kind: "unavailable",
      label: "Registration unavailable",
      spatialComparisonValid: false,
      explanation:
        "The examinations are in different coordinate frames and no registration transform is stored. Unregistered patient-space coordinates are not treated as aligned.",
    };
  }
  if (quality.status === "failed" || quality.status === "invalid_transform" || quality.status === "series_mismatch") {
    return {
      kind: "failed",
      label: "Registration failed",
      spatialComparisonValid: false,
      explanation: `Registration could not be used (${quality.status.replaceAll("_", " ")}). ${quality.notes.join(" ")}`.trim(),
    };
  }
  if (!quality.supported || quality.status === "insufficient_quality") {
    return {
      kind: "insufficient_quality",
      label: "Registration quality insufficient",
      spatialComparisonValid: false,
      explanation: `A transform exists but its quality is below the configured threshold. ${quality.notes.join(" ")}`.trim(),
    };
  }
  if (method && EXTERNAL_REGISTRATION_METHODS.has(method)) {
    return {
      kind: "externally_supplied",
      label: "Registration supplied externally",
      spatialComparisonValid: true,
      explanation:
        "The transform was entered or supplied from outside this application; ReproCare did not compute it. Distance is shown in the fixed study's frame after applying it.",
    };
  }
  return {
    kind: "available_verified",
    label: quality.status === "verified" ? "Registration available (quality checks passed)" : "Registration available (unverified)",
    spatialComparisonValid: true,
    explanation: `Distance is measured after applying the stored rigid transform. ${quality.notes.join(" ")}`.trim(),
  };
}

const DIST_SAME = REPROTRACE_PARAMS.DIST_SAME_MM;
const DIST_FAR = REPROTRACE_PARAMS.DIST_FAR_MM;
const PAIR_FLOOR = REPROTRACE_PARAMS.PAIR_FLOOR_SCORE;
/** Competing candidates within this score margin make a pairing ambiguous (unvalidated heuristic). */
export const AMBIGUITY_MARGIN = 0.1;
/** Only candidates at or above this score are considered plausible rivals (unvalidated heuristic). */
export const AMBIGUITY_MIN_SCORE = 0.6;
/** Floor for anatomy-and-measurement-only comparison of observations without coordinates (unvalidated). */
export const NON_SPATIAL_FLOOR = 0.45;

export const MIN_REGISTRATION_NCC_VERIFIED = 0.5;
export const MIN_REGISTRATION_NCC_UNVERIFIED = 0.5;
export const MAX_REGISTRATION_RESIDUAL_MM = 15.0;

export function longestOf(
  axes: [number, number, number] | null,
  longest: number | null,
): number | null {
  if (longest != null && Number.isFinite(longest)) return longest;
  if (!axes) return null;
  return Math.max(axes[0], axes[1], axes[2]);
}

export function ellipsoidVolumeMm3(axes: [number, number, number]): number {
  return (4 / 3) * Math.PI * (axes[0] / 2) * (axes[1] / 2) * (axes[2] / 2);
}

export function snapshotVolumeMm3(s: Pick<Snap, "volumeMm3" | "axesMm" | "longestMm">): number | null {
  if (s.volumeMm3 != null && Number.isFinite(s.volumeMm3) && s.volumeMm3 > 0) {
    return s.volumeMm3;
  }
  if (s.axesMm && s.axesMm.every((x) => Number.isFinite(x) && x > 0)) {
    return ellipsoidVolumeMm3(s.axesMm);
  }
  if (s.longestMm != null && Number.isFinite(s.longestMm) && s.longestMm > 0) {
    return ellipsoidVolumeMm3([s.longestMm, s.longestMm, s.longestMm]);
  }
  return null;
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function mapCategoryToOutcome(
  category: MatchCategory,
  clinicianDecision?: "accept" | "reject" | "defer" | null,
): CorrespondenceOutcome {
  if (clinicianDecision === "accept" || category === "confirmed_match") {
    return "confirmed_match";
  }
  if (clinicianDecision === "reject" || category === "potentially_new") {
    return "possible_new_finding";
  }
  if (category === "likely_same") {
    return "probable_match_review_required";
  }
  if (category === "possible_resolved") {
    return "possible_resolved_finding";
  }
  return "uncertain_correspondence";
}

/**
 * Evaluates a registration record's transformation validity, quality metrics, and identifier alignment.
 */
export function evaluateRegistrationEntry(
  entry: RegistrationLookupEntry | null | undefined,
  context?: {
    fromStudyId?: string | null;
    toStudyId?: string | null;
    fromSeriesId?: string | null;
    toSeriesId?: string | null;
  },
): { quality: RegistrationQualityInfo; transform: RegistrationTransform | null } {
  const fixedStudyId = entry?.fixedStudyId ?? context?.fromStudyId ?? null;
  const movingStudyId = entry?.movingStudyId ?? context?.toStudyId ?? null;
  const fixedSeriesId = entry?.fixedSeriesId ?? context?.fromSeriesId ?? null;
  const movingSeriesId = entry?.movingSeriesId ?? context?.toSeriesId ?? null;

  if (!entry) {
    return {
      quality: {
        id: null,
        registrationId: null,
        status: "missing",
        supported: false,
        nccScore: null,
        residualMm: null,
        matrixValid: false,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes: ["No registration transformation available for this study/series pair"],
      },
      transform: null,
    };
  }

  const notes: string[] = [...(entry.notes ?? [])];
  const nccScore =
    entry.nccScore != null && Number.isFinite(entry.nccScore)
      ? Number(entry.nccScore)
      : entry.ncc != null && Number.isFinite(entry.ncc)
        ? Number(entry.ncc)
        : null;
  const residualMm =
    entry.residualMm != null && Number.isFinite(entry.residualMm)
      ? Number(entry.residualMm)
      : null;

  // 1. Check series/study identifier consistency when both sides specify IDs
  if (
    (entry.fixedSeriesId && context?.fromSeriesId && entry.fixedSeriesId !== context.fromSeriesId) ||
    (entry.movingSeriesId && context?.toSeriesId && entry.movingSeriesId !== context.toSeriesId) ||
    (entry.fixedStudyId && context?.fromStudyId && entry.fixedStudyId !== context.fromStudyId) ||
    (entry.movingStudyId && context?.toStudyId && entry.movingStudyId !== context.toStudyId)
  ) {
    notes.push("Registration series or study identifiers do not match the findings being compared");
    return {
      quality: {
        id: entry.registrationId ?? entry.id ?? null,
        registrationId: entry.registrationId ?? entry.id ?? null,
        status: "series_mismatch",
        supported: false,
        nccScore,
        residualMm,
        matrixValid: false,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes,
      },
      transform: null,
    };
  }

  // 2. Check explicit failed status
  if (
    entry.status === "failed" ||
    entry.status === "invalid_transform" ||
    entry.status === "insufficient_quality" ||
    entry.status === "series_mismatch"
  ) {
    notes.push("Follow-up image registration was attempted but spatial correspondence could not be established");
    return {
      quality: {
        id: entry.registrationId ?? entry.id ?? null,
        registrationId: entry.registrationId ?? entry.id ?? null,
        status: entry.status,
        supported: false,
        nccScore,
        residualMm,
        matrixValid: false,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes,
      },
      transform: null,
    };
  }

  // 3. Check explicit supported === false
  if (entry.supported === false) {
    notes.push("Follow-up image registration was attempted but spatial correspondence could not be established");
    return {
      quality: {
        id: entry.registrationId ?? entry.id ?? null,
        registrationId: entry.registrationId ?? entry.id ?? null,
        status: entry.status === "missing" ? "missing" : "insufficient_quality",
        supported: false,
        nccScore,
        residualMm,
        matrixValid: false,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes,
      },
      transform: null,
    };
  }

  // 4. Validate transformation matrix
  if (entry.transform == null) {
    notes.push("Registration transformation matrix is missing; spatial correspondence could not be established");
    return {
      quality: {
        id: entry.registrationId ?? entry.id ?? null,
        registrationId: entry.registrationId ?? entry.id ?? null,
        status: "missing",
        supported: false,
        nccScore,
        residualMm,
        matrixValid: false,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes,
      },
      transform: null,
    };
  }

  const validation = validateTransformMatrix(entry.transform);
  if (!validation.valid || !validation.transform) {
    notes.push(
      `Invalid registration transformation matrix (${validation.reason ?? "validation failed"}); spatial correspondence could not be established`,
    );
    return {
      quality: {
        id: entry.registrationId ?? entry.id ?? null,
        registrationId: entry.registrationId ?? entry.id ?? null,
        status: "invalid_transform",
        supported: false,
        nccScore,
        residualMm,
        matrixValid: false,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes,
      },
      transform: null,
    };
  }

  // 5. Validate registration quality thresholds (NCC and residual error in mm)
  const minNcc = entry.status === "unverified" ? MIN_REGISTRATION_NCC_UNVERIFIED : MIN_REGISTRATION_NCC_VERIFIED;
  if (nccScore != null && nccScore < minNcc) {
    notes.push(
      `Follow-up image registration was attempted but spatial correspondence could not be established (NCC ${nccScore.toFixed(3)} < ${minNcc.toFixed(2)} threshold)`,
    );
    return {
      quality: {
        id: entry.registrationId ?? entry.id ?? null,
        registrationId: entry.registrationId ?? entry.id ?? null,
        status: "insufficient_quality",
        supported: false,
        nccScore,
        residualMm,
        matrixValid: true,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes,
      },
      transform: null,
    };
  }

  if (residualMm != null && (residualMm < 0 || residualMm > MAX_REGISTRATION_RESIDUAL_MM)) {
    notes.push(
      `Follow-up image registration was attempted but spatial correspondence could not be established (residual ${residualMm.toFixed(2)} mm exceeds ${MAX_REGISTRATION_RESIDUAL_MM.toFixed(1)} mm limit)`,
    );
    return {
      quality: {
        id: entry.registrationId ?? entry.id ?? null,
        registrationId: entry.registrationId ?? entry.id ?? null,
        status: "insufficient_quality",
        supported: false,
        nccScore,
        residualMm,
        matrixValid: true,
        fixedStudyId,
        movingStudyId,
        fixedSeriesId,
        movingSeriesId,
        notes,
      },
      transform: null,
    };
  }

  const metricParts: string[] = [];
  if (nccScore != null) metricParts.push(`NCC ${nccScore.toFixed(3)}`);
  if (residualMm != null) metricParts.push(`residual ${residualMm.toFixed(2)} mm`);
  notes.push(
    `Rigid follow-up image registration verified${metricParts.length ? ` (${metricParts.join(", ")})` : ""}; spatial correspondence is supported`,
  );

  return {
    quality: {
      id: entry.registrationId ?? entry.id ?? null,
      registrationId: entry.registrationId ?? entry.id ?? null,
      status: entry.status === "unverified" ? "unverified" : "verified",
      supported: true,
      nccScore,
      residualMm,
      matrixValid: true,
      fixedStudyId,
      movingStudyId,
      fixedSeriesId,
      movingSeriesId,
      notes,
      method: entry.method ?? null,
    },
    transform: validation.transform,
  };
}

/**
 * Resolves a registration entry between two finding snapshots across series and study identifiers.
 */
export function resolveRegistrationForSnapshots(
  a: Snap,
  b: Snap,
  registrations?: Map<string, RegistrationLookupEntry> | null,
  directRegistration?: RegistrationLookupEntry | null,
): { quality: RegistrationQualityInfo; transform: RegistrationTransform | null } | null {
  const ctx = {
    fromStudyId: a.studyId,
    toStudyId: b.studyId,
    fromSeriesId: a.seriesId ?? null,
    toSeriesId: b.seriesId ?? null,
  };

  if (directRegistration !== undefined && directRegistration !== null) {
    return evaluateRegistrationEntry(directRegistration, ctx);
  }

  if (registrations) {
    // 1. Exact study+series composite key
    if (a.seriesId && b.seriesId) {
      const compositeKey = `${a.studyId}:${a.seriesId}->${b.studyId}:${b.seriesId}`;
      if (registrations.has(compositeKey)) {
        return evaluateRegistrationEntry(registrations.get(compositeKey)!, ctx);
      }
      // 2. Exact series-pair key `${fromSeriesId}:${toSeriesId}`
      const seriesKey = `${a.seriesId}:${b.seriesId}`;
      if (registrations.has(seriesKey)) {
        return evaluateRegistrationEntry(registrations.get(seriesKey)!, ctx);
      }
      // 3. Scan map values for matching fixedSeriesId + movingSeriesId
      for (const entry of registrations.values()) {
        if (entry.fixedSeriesId === a.seriesId && entry.movingSeriesId === b.seriesId) {
          return evaluateRegistrationEntry(entry, ctx);
        }
      }
    }

    // 4. Study-pair key `${fromStudyId}:${toStudyId}`
    const studyKey = `${a.studyId}:${b.studyId}`;
    if (registrations.has(studyKey)) {
      return evaluateRegistrationEntry(registrations.get(studyKey)!, ctx);
    }

    // 5. Scan map values for matching fixedStudyId + movingStudyId
    for (const entry of registrations.values()) {
      if (
        entry.fixedStudyId &&
        entry.movingStudyId &&
        entry.fixedStudyId === a.studyId &&
        entry.movingStudyId === b.studyId
      ) {
        return evaluateRegistrationEntry(entry, ctx);
      }
    }

    // 6. If snapshots had seriesId and we found a registration for the same study pair but DIFFERENT series, flag series_mismatch
    if (a.seriesId || b.seriesId) {
      for (const [k, entry] of registrations.entries()) {
        if (
          (a.seriesId && k.startsWith(`${a.seriesId}:`)) ||
          (b.seriesId && k.endsWith(`:${b.seriesId}`)) ||
          (entry.fixedSeriesId && a.seriesId && entry.fixedSeriesId === a.seriesId) ||
          (entry.movingSeriesId && b.seriesId && entry.movingSeriesId === b.seriesId)
        ) {
          return evaluateRegistrationEntry(entry, ctx);
        }
      }
    }

    // 7. If a registrations map was explicitly provided, or if snapshots are in non-schematic frames across studies/series, report missing registration explicitly
    if (
      registrations.size > 0 ||
      a.frame === "dicom_lps" ||
      b.frame === "dicom_lps" ||
      a.seriesId ||
      b.seriesId
    ) {
      return evaluateRegistrationEntry(null, ctx);
    }
  }

  // If no registration map was provided, still check if snapshots are in unregistered dicom_lps frames across different studies or series
  const differentStudies = a.studyId !== b.studyId;
  const differentSeries = Boolean(a.seriesId && b.seriesId && a.seriesId !== b.seriesId);
  if (
    (a.frame === "dicom_lps" || b.frame === "dicom_lps") &&
    (differentStudies || differentSeries)
  ) {
    return evaluateRegistrationEntry(null, ctx);
  }

  return null;
}

function hasContradictoryLocation(labelA: string, labelB: string): boolean {
  const a = (labelA || "").toLowerCase();
  const b = (labelB || "").toLowerCase();
  if ((a.includes("left") && b.includes("right")) || (a.includes("right") && b.includes("left"))) {
    return true;
  }
  if (
    (a.includes("anterior") && b.includes("posterior")) ||
    (a.includes("posterior") && b.includes("anterior"))
  ) {
    return true;
  }
  return false;
}

function hasOpposingLaterality(a?: string | null, b?: string | null): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return (x === "left" && y === "right") || (x === "right" && y === "left");
}

function pairScore(
  a: Snap,
  b: Snap,
  thresholds: ReproTraceThresholds = DEFAULT_REPROTRACE_THRESHOLDS,
): {
  score: number;
  category: MatchCategory;
  notes: string[];
  separationMm: number | null;
} | null {
  if (a.organ !== b.organ || a.structure !== b.structure) return null;
  if (hasContradictoryLocation(a.locationLabel, b.locationLabel)) {
    return null;
  }
  if (hasOpposingLaterality(a.laterality, b.laterality)) {
    return null;
  }

  const notes: string[] = [];
  let score = 0.35;
  const sameLabel = Boolean(a.locationLabel && a.locationLabel === b.locationLabel);
  if (sameLabel) {
    score += 0.25;
    notes.push("same recorded anatomical label");
  } else if (a.locationLabel && b.locationLabel) {
    score -= 0.05;
    notes.push("anatomical labels differ");
  }

  let separation: number | null = null;
  if (a.centroidMm && b.centroidMm) {
    separation = dist(a.centroidMm, b.centroidMm);
    notes.push(`centroid separation ${separation.toFixed(1)} mm in the stored frame`);
    if (separation <= thresholds.distSameMm) score += 0.3;
    else if (separation <= thresholds.distFarMm) score += 0.1;
    else score -= 0.25;
  } else {
    score -= 0.2;
    notes.push(
      "at least one observation has no centroid (no stored patient-space coordinate), so spatial distance was not computed",
    );
  }

  const la = longestOf(a.axesMm, a.longestMm);
  const lb = longestOf(b.axesMm, b.longestMm);
  if (la && lb && la > 0 && lb > 0) {
    const ratio = Math.max(la, lb) / Math.min(la, lb);
    notes.push(`longest-axis ratio ${ratio.toFixed(2)}`);
    if (ratio <= 1.35) {
      score += 0.15;
    } else if (ratio <= 1.8) {
      // If the lesion is at virtually the same coordinate with the same anatomical label and consistent 3D shape,
      // allow moderate growth/shrinkage without penalizing it below likely_same
      const shapeSim = computeShapeSimilarity(a.axesMm, b.axesMm);
      if (separation != null && separation <= 10 && sameLabel && shapeSim >= 0.75) {
        score += 0.13;
        notes.push(`consistent 3D aspect ratio (${shapeSim.toFixed(2)}) during growth/regression`);
      } else {
        score += 0.05;
      }
    } else {
      score -= 0.1;
    }
  }
  if (a.modality !== b.modality) {
    score -= 0.08;
    notes.push(
      `modalities differ (${a.modality} vs ${b.modality}); sizes from different modalities are not treated as a before-and-after of one measurement`,
    );
  }
  if (a.laterality && b.laterality && a.laterality === b.laterality) {
    notes.push(`same laterality (${a.laterality})`);
  }
  if (a.quality !== "adequate" || b.quality !== "adequate") {
    score -= 0.12;
    notes.push("image quality is limited or unknown on at least one study");
  }
  score = Math.max(0, Math.min(0.99, score));

  let category: MatchCategory = "needs_review";
  if (separation != null && separation <= thresholds.distSameMm && score >= 0.72)
    category = "likely_same";
  else if (separation != null && separation <= thresholds.distFarMm && score >= 0.45)
    category = "uncertain";
  else category = "needs_review";

  if (a.quality !== "adequate" || b.quality !== "adequate") {
    if (category === "likely_same") category = "uncertain";
  }
  if (!a.centroidMm || !b.centroidMm || a.frame === "unavailable" || b.frame === "unavailable") {
    category = "needs_review";
  }
  if (a.frame !== "image_registered" || b.frame !== "image_registered") {
    notes.push(
      "coordinate frame is schematic, not an image-to-image registration, so this cannot be confirmed automatically",
    );
  }
  return { score, category, notes, separationMm: separation };
}

/** Pair observations between two spatially described studies. Does not merge records. */
export function matchStudies(
  prior: Snap[],
  next: Snap[],
  registration?: RegistrationLookupEntry | null,
  registrationsMap?: Map<string, RegistrationLookupEntry> | null,
  options?: {
    clinicianDecisions?: ClinicianCorrespondenceDecision[];
    thresholds?: ReproTraceThresholds;
  },
): Proposal[] {
  const thresholds = options?.thresholds ?? DEFAULT_REPROTRACE_THRESHOLDS;
  const decisionByPair = new Map<string, ClinicianCorrespondenceDecision>();
  for (const d of options?.clinicianDecisions ?? []) {
    if (d.fromVersionId && d.toVersionId) {
      decisionByPair.set(`${d.fromVersionId}->${d.toVersionId}`, d);
    }
  }

  const candidates: {
    i: number;
    j: number;
    score: number;
    category: MatchCategory;
    notes: string[];
    evalA: Snap;
    evalB: Snap;
    rawA: Snap;
    rawB: Snap;
    separationMm: number | null;
    regQuality: RegistrationQualityInfo | null;
    decision?: ClinicianCorrespondenceDecision;
  }[] = [];

  prior.forEach((rawA, i) => {
    next.forEach((rawB, j) => {
      const decision = decisionByPair.get(`${rawA.id}->${rawB.id}`);
      if (decision?.decision === "reject") {
        return;
      }

      const resolved = resolveRegistrationForSnapshots(rawA, rawB, registrationsMap, registration);
      let evalA: Snap = rawA;
      let evalB: Snap = rawB;

      if (resolved?.quality.supported && resolved.transform) {
        evalA = { ...rawA, frame: "image_registered" };
        evalB = {
          ...rawB,
          frame: "image_registered",
          centroidMm: rawB.centroidMm ? transformPoint(rawB.centroidMm, resolved.transform) : null,
        };
      }

      const scored = pairScore(evalA, evalB, thresholds);
      if (!scored || (scored.score < thresholds.pairFloorScore && decision?.decision !== "accept")) {
        return;
      }

      let cat = scored.category;
      const notes = [...scored.notes];

      if (resolved) {
        notes.push(...resolved.quality.notes);
        if (!resolved.quality.supported) {
          if (cat === "likely_same") {
            cat = "uncertain";
          }
        }
      }

      if (decision?.decision === "accept") {
        cat = "likely_same";
        notes.push("Clinician reviewed and accepted longitudinal correspondence");
      } else if (decision?.decision === "defer") {
        cat = "uncertain";
        notes.push("Clinician deferred correspondence for follow-up review");
      }

      candidates.push({
        i,
        j,
        score: decision?.decision === "accept" ? Math.max(0.95, scored.score) : scored.score,
        category: cat,
        notes,
        evalA,
        evalB,
        rawA,
        rawB,
        separationMm: scored.separationMm,
        regQuality: resolved?.quality ?? null,
        decision,
      });
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  // Ambiguity: when several plausible counterparts score within a small margin of each other,
  // the engine must not pick one. The greedy pairing below still emits one proposal for review,
  // but it is downgraded to "uncertain" and lists the competing candidates.
  const plausible = candidates.filter(
    (c) =>
      (c.category === "likely_same" || c.category === "uncertain") &&
      c.score >= AMBIGUITY_MIN_SCORE &&
      c.decision?.decision !== "accept",
  );
  const rivalsOf = (c: (typeof candidates)[number]) => {
    const forNext = plausible.filter((x) => x.j === c.j && x.i !== c.i && x.score >= c.score - AMBIGUITY_MARGIN);
    const forPrior = plausible.filter((x) => x.i === c.i && x.j !== c.j && x.score >= c.score - AMBIGUITY_MARGIN);
    return { forNext, forPrior };
  };
  const contestedPrior = new Map<number, string>();
  const contestedNext = new Map<number, string>();

  const usedPrior = new Set<number>();
  const usedNext = new Set<number>();
  const proposals: Proposal[] = [];
  for (const c of candidates) {
    if (usedPrior.has(c.i) || usedNext.has(c.j)) continue;
    usedPrior.add(c.i);
    usedNext.add(c.j);
    const a = c.evalA;
    const b = c.evalB;
    let alternatives: string[] = [];
    if (c.decision?.decision !== "accept" && (c.category === "likely_same" || c.category === "uncertain")) {
      const { forNext, forPrior } = rivalsOf(c);
      if (forNext.length > 0 || forPrior.length > 0) {
        alternatives = [...forNext.map((x) => x.rawA.id), ...forPrior.map((x) => x.rawB.id)];
        c.category = "uncertain";
        c.notes.push(
          `Ambiguous: ${alternatives.length} other plausible candidate(s) (${alternatives.join(", ")}) scored within ${AMBIGUITY_MARGIN.toFixed(2)} of this pairing; ReproTrace does not choose between them and requires clinician review`,
        );
        for (const x of forNext) contestedPrior.set(x.i, b.id);
        for (const x of forPrior) contestedNext.set(x.j, a.id);
      }
    }
    const regSupported = c.regQuality ? c.regQuality.supported : false;
    const isProvisional =
      c.decision?.decision === "accept"
        ? false
        : alternatives.length > 0 ||
          a.frame !== "image_registered" ||
          b.frame !== "image_registered" ||
          (c.regQuality ? !regSupported : true);

    const v1 = snapshotVolumeMm3(a);
    const v2 = snapshotVolumeMm3(b);
    const t1 = parseExaminationDateMs(a.date);
    const t2 = parseExaminationDateMs(b.date);
    const elapsedDays =
      t1 !== null && t2 !== null && t2 > t1 ? (t2 - t1) / (1000 * 60 * 60 * 24) : null;
    const volumeDeltaPct =
      v1 != null && v2 != null && v1 > 0 ? Number((((v2 - v1) / v1) * 100).toFixed(2)) : null;
    const growthRateMm3PerMonth =
      v1 != null &&
      v2 != null &&
      elapsedDays != null &&
      elapsedDays >= thresholds.minElapsedDaysForGrowthRate
        ? Number((((v2 - v1) / elapsedDays) * 30.4375).toFixed(1))
        : null;

    const attribution = attributeLongitudinalChange({
      priorVolumeMm3: v1,
      currentVolumeMm3: v2,
      priorUncertaintyMm3: a.uncertaintyMm3,
      currentUncertaintyMm3: b.uncertaintyMm3,
      priorSpacingMm: a.spacingMm,
      currentSpacingMm: b.spacingMm,
      priorMethod: a.source ?? a.basis,
      currentMethod: b.source ?? b.basis,
      priorModality: a.modality,
      currentModality: b.modality,
      registrationQualityScore: c.regQuality?.nccScore,
      registrationResidualMm: c.regQuality?.residualMm,
      registrationDegraded: c.regQuality ? !c.regQuality.supported && c.regQuality.status !== "missing" : false,
      imageQualityDegraded: a.quality !== "adequate" || b.quality !== "adequate",
      elapsedDays,
      thresholds,
    });

    const uA = a.uncertaintyMm ?? (a.spacingMm ? 0.5 * Math.hypot(...a.spacingMm) : 2.0);
    const uB = b.uncertaintyMm ?? (b.spacingMm ? 0.5 * Math.hypot(...b.spacingMm) : 2.0);
    const uReg = c.regQuality?.residualMm ?? 0;
    const combinedUncertaintyMm = Number(Math.hypot(uA, uB, uReg).toFixed(2));

    proposals.push({
      fromId: a.id,
      toId: b.id,
      fromStudyId: a.studyId,
      toStudyId: b.studyId,
      fromSeriesId: a.seriesId ?? null,
      toSeriesId: b.seriesId ?? null,
      category: c.category,
      outcome: mapCategoryToOutcome(c.category, c.decision?.decision),
      score: Number(c.score.toFixed(2)),
      rationale: `${c.notes.join(". ")}.`,
      provisional: isProvisional,
      distanceMm: c.separationMm != null ? Number(c.separationMm.toFixed(2)) : null,
      volumeDeltaPct,
      elapsedDays: elapsedDays != null ? Number(elapsedDays.toFixed(2)) : null,
      growthRateMm3PerMonth,
      uncertaintyMm: combinedUncertaintyMm,
      uncertaintyMm3: Number(attribution.combinedUncertaintyMm3.toFixed(1)),
      attributionCategory: attribution.category,
      clinicianDecision: c.decision?.decision ?? null,
      reviewedByUserId: c.decision?.decidedByUserId ?? null,
      reviewedAt: c.decision?.decidedAt ?? null,
      registrationQuality:
        c.regQuality ?? {
          id: null,
          registrationId: null,
          status: "missing",
          supported: false,
          nccScore: null,
          residualMm: null,
          matrixValid: false,
          fixedStudyId: a.studyId,
          movingStudyId: b.studyId,
          fixedSeriesId: a.seriesId ?? null,
          movingSeriesId: b.seriesId ?? null,
          notes: ["Unregistered coordinate frame; proposal remains provisional"],
        },
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      registrationAvailability: describeRegistrationAvailability(
        c.rawA,
        c.rawB,
        c.regQuality,
        c.regQuality?.method ?? null,
      ),
    });
  }
  prior.forEach((a, i) => {
    if (usedPrior.has(i)) return;
    const contestedBy = contestedPrior.get(i);
    if (contestedBy) {
      proposals.push({
        fromId: a.id,
        toId: null,
        fromStudyId: a.studyId,
        toStudyId: next[0]?.studyId ?? null,
        fromSeriesId: a.seriesId ?? null,
        toSeriesId: next[0]?.seriesId ?? null,
        category: "uncertain",
        outcome: "uncertain_correspondence",
        score: 0.4,
        rationale: `Competes with another earlier observation for the same later observation (${contestedBy}). Left unpaired pending clinician review; it is not called resolved.`,
        provisional: true,
        attributionCategory: "insufficient_evidence",
        alternatives: [contestedBy],
      });
      return;
    }
    const small = (longestOf(a.axesMm, a.longestMm) ?? 99) < 20;
    const cat: MatchCategory = small ? "needs_review" : "possible_resolved";
    proposals.push({
      fromId: a.id,
      toId: null,
      fromStudyId: a.studyId,
      toStudyId: next[0]?.studyId ?? null,
      fromSeriesId: a.seriesId ?? null,
      toSeriesId: next[0]?.seriesId ?? null,
      category: cat,
      outcome: small ? "uncertain_correspondence" : "possible_resolved_finding",
      score: small ? 0.34 : 0.48,
      rationale: small
        ? "Not paired on the later study. Longest axis under 20 mm makes non-visualization unreliable, so this stays in review rather than being called resolved."
        : "No geometric counterpart met the pairing threshold on the later study. Non-visualization is not treated as proof of resolution.",
      provisional: true,
      attributionCategory: "insufficient_evidence",
    });
  });
  next.forEach((b, j) => {
    if (usedNext.has(j)) return;
    const contestedBy = contestedNext.get(j);
    if (contestedBy) {
      proposals.push({
        fromId: null,
        toId: b.id,
        fromStudyId: prior[0]?.studyId ?? null,
        toStudyId: b.studyId,
        fromSeriesId: prior[0]?.seriesId ?? null,
        toSeriesId: b.seriesId ?? null,
        category: "uncertain",
        outcome: "uncertain_correspondence",
        score: 0.4,
        rationale: `Competes with another later observation for the same earlier observation (${contestedBy}). Not called new until a clinician reviews it.`,
        provisional: true,
        attributionCategory: "insufficient_evidence",
        alternatives: [contestedBy],
      });
      return;
    }
    proposals.push({
      fromId: null,
      toId: b.id,
      fromStudyId: prior[0]?.studyId ?? null,
      toStudyId: b.studyId,
      fromSeriesId: prior[0]?.seriesId ?? null,
      toSeriesId: b.seriesId ?? null,
      category: "potentially_new",
      outcome: "possible_new_finding",
      score: 0.5,
      rationale:
        "No counterpart on the earlier study met the pairing threshold. This is a potential new observation, not a confirmed new lesion.",
      provisional: b.frame !== "image_registered",
      attributionCategory: "insufficient_evidence",
    });
  });
  return proposals;
}

export type StudyGroup = { studyId: string; date: string; snaps: Snap[] };

/**
 * Spatial match across chronologically ordered studies.
 *
 * Strictly validates and orders studies by parsed examination date (`date`), deduplicates
 * duplicate study IDs, resolves registration transformations consistently across both
 * series IDs (`${fixedSeriesId}:${movingSeriesId}`) and study IDs (`${fromStudyId}:${toStudyId}`),
 * validates transformation matrices, and gates correspondence confidence on registration quality.
 */
export function matchChronology(
  groupsOrSnaps: StudyGroup[] | Snap[],
  registrations?: Map<string, RegistrationLookupEntry> | null,
  options?: {
    clinicianDecisions?: ClinicianCorrespondenceDecision[];
    thresholds?: ReproTraceThresholds;
    /**
     * When true, observations without stored coordinates are not silently dropped: each is compared by
     * anatomy and measurement against earlier observations and reported as needing review (or as a
     * potential new observation). Default false keeps the original spatial-only behaviour.
     */
    includeNonSpatial?: boolean;
  },
): Proposal[] {
  let groups: StudyGroup[];
  if (groupsOrSnaps.length > 0 && !("snaps" in groupsOrSnaps[0])) {
    const byStudy = new Map<string, StudyGroup>();
    for (const s of groupsOrSnaps as Snap[]) {
      const existing = byStudy.get(s.studyId);
      if (existing) {
        existing.snaps.push(s);
      } else {
        byStudy.set(s.studyId, { studyId: s.studyId, date: s.date, snaps: [s] });
      }
    }
    groups = [...byStudy.values()];
  } else {
    groups = groupsOrSnaps as StudyGroup[];
  }

  const seenStudyIds = new Set<string>();
  const validGroups: Array<{ group: StudyGroup; ms: number; index: number }> = [];

  groups.forEach((g, idx) => {
    if (!g.studyId || seenStudyIds.has(g.studyId)) return;
    const ms = parseExaminationDateMs(g.date);
    if (ms === null) return;
    const spatialSnaps = g.snaps.filter((s) => s.centroidMm && s.frame !== "unavailable");
    if (spatialSnaps.length === 0) return;
    seenStudyIds.add(g.studyId);
    validGroups.push({
      group: { ...g, snaps: spatialSnaps },
      ms,
      index: idx,
    });
  });

  validGroups.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.index - b.index));

  const out: Proposal[] = [];
  for (let i = 1; i < validGroups.length; i += 1) {
    out.push(
      ...matchStudies(
        validGroups[i - 1].group.snaps,
        validGroups[i].group.snaps,
        undefined,
        registrations,
        options,
      ),
    );
  }
  if (options?.includeNonSpatial) {
    out.push(
      ...matchNonSpatial(groups, options?.thresholds ?? DEFAULT_REPROTRACE_THRESHOLDS, options?.clinicianDecisions ?? []),
    );
  }
  return out;
}

/**
 * Observations without coordinates (for example a single-plane ultrasound measurement) cannot be paired
 * spatially. Rather than dropping them, compare each against earlier observations of the same structure by
 * anatomy and measurement only, and always leave the outcome for clinician review.
 */
function matchNonSpatial(
  groups: StudyGroup[],
  thresholds: ReproTraceThresholds,
  decisions: ClinicianCorrespondenceDecision[],
): Proposal[] {
  const rejected = new Set(
    decisions.filter((d) => d.decision === "reject" && d.fromVersionId && d.toVersionId).map((d) => `${d.fromVersionId}->${d.toVersionId}`),
  );
  const dated = groups
    .map((g, index) => ({ g, ms: parseExaminationDateMs(g.date), index }))
    .filter((x): x is { g: StudyGroup; ms: number; index: number } => x.ms !== null)
    .sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.index - b.index));
  const out: Proposal[] = [];
  for (let k = 1; k < dated.length; k += 1) {
    const current = dated[k];
    const nonSpatial = current.g.snaps.filter((s) => !s.centroidMm || s.frame === "unavailable");
    if (nonSpatial.length === 0) continue;
    const earlier = dated.slice(0, k).flatMap((d) => d.g.snaps);
    for (const b of nonSpatial) {
      const scored = earlier
        .filter((a) => !rejected.has(`${a.id}->${b.id}`))
        .map((a) => ({ a, r: pairScore(a, b, thresholds) }))
        .filter((x): x is { a: Snap; r: NonNullable<ReturnType<typeof pairScore>> } => x.r !== null)
        .sort((x, y) => y.r.score - x.r.score);
      const top = scored[0];
      // Without coordinates the spatial bonus is impossible, so use a lower floor; the result is always review-only.
      if (!top || top.r.score < NON_SPATIAL_FLOOR) {
        out.push({
          fromId: null,
          toId: b.id,
          fromStudyId: dated[k - 1].g.studyId,
          toStudyId: b.studyId,
          fromSeriesId: null,
          toSeriesId: b.seriesId ?? null,
          category: "potentially_new",
          outcome: "possible_new_finding",
          score: 0.4,
          rationale:
            "Missing anatomical coordinates: this observation has no stored patient-space position, and no earlier observation of the same structure with a compatible label was found. A potential new observation, not a confirmed new lesion.",
          provisional: true,
          attributionCategory: "insufficient_evidence",
          registrationAvailability: describeRegistrationAvailability(b, b, null),
        });
        continue;
      }
      const rivals = scored.slice(1).filter((x) => x.r.score >= top.r.score - AMBIGUITY_MARGIN);
      out.push({
        fromId: top.a.id,
        toId: b.id,
        fromStudyId: top.a.studyId,
        toStudyId: b.studyId,
        fromSeriesId: top.a.seriesId ?? null,
        toSeriesId: b.seriesId ?? null,
        category: "needs_review",
        outcome: "uncertain_correspondence",
        score: Number(top.r.score.toFixed(2)),
        rationale: `Missing anatomical coordinates: compared on anatomical label and measurement only. ${top.r.notes.join(". ")}.${rivals.length ? ` ${rivals.length} other earlier observation(s) are similarly compatible (${rivals.map((x) => x.a.id).join(", ")}).` : ""}`,
        provisional: true,
        distanceMm: null,
        attributionCategory: "insufficient_evidence",
        alternatives: rivals.length ? rivals.map((x) => x.a.id) : undefined,
        registrationAvailability: describeRegistrationAvailability(top.a, b, null),
      });
    }
  }
  return out;
}

export type DiscCategory =
  | "measurable_difference"
  | "method_difference"
  | "segmentation_disagreement"
  | "reporting_inconsistency"
  | "unresolved_uncertainty"
  | "protocol_or_spacing_difference"
  | "image_quality_limitation"
  | "registration_uncertainty";

export type Discrepancy = {
  category: DiscCategory;
  attributionCategory?: ChangeAttributionCategory;
  summary: string;
  detail: string;
  leftRef: string;
  rightRef: string;
  volumeDeltaPct?: number | null;
  elapsedDays?: number | null;
  growthRateMm3PerMonth?: number | null;
  uncertaintyMm3?: number | null;
};

export type Measure = {
  id: string;
  findingId: string;
  date: string;
  modality: string;
  basis: string;
  locationLabel: string;
  longestMm: number | null;
  axesMm: [number, number, number] | null;
  volumeMm3?: number | null;
  spacingMm?: [number, number, number] | null;
  uncertaintyMm3?: number | null;
  source: string;
  reportLongestMm: number | null;
  quality: string;
};

export function sameMethodChange(a: Measure, b: Measure): Discrepancy | null {
  if (a.longestMm == null || b.longestMm == null) return null;
  if (a.modality !== b.modality) return null;

  // Enforce chronological order between a and b if both dates are parseable
  const msA = parseExaminationDateMs(a.date);
  const msB = parseExaminationDateMs(b.date);
  const [earlier, later] =
    msA !== null && msB !== null && msB < msA ? [b, a] : [a, b];

  const elapsedDays =
    msA !== null && msB !== null ? Math.abs(msB - msA) / (1000 * 60 * 60 * 24) : null;

  if (earlier.basis !== later.basis) {
    return {
      category: "unresolved_uncertainty",
      attributionCategory: "segmentation_method_difference",
      summary: "Same modality, different measurement basis",
      detail:
        "The lengths were not taken on the same recorded basis, so the numeric gap is not interpreted as growth or shrinkage.",
      leftRef: earlier.id,
      rightRef: later.id,
      elapsedDays,
    };
  }

  if ((earlier.quality === "limited" || later.quality === "limited") && earlier.longestMm != null && later.longestMm != null && earlier.longestMm > 0 && later.longestMm > 0) {
    const relQ =
      Math.abs(earlier.longestMm - later.longestMm) /
      Math.min(earlier.longestMm, later.longestMm);
    if (relQ > 0.15) {
      return {
        category: "unresolved_uncertainty",
        attributionCategory: "image_quality_limitation",
        summary: `Measurement difference under limited image quality (${earlier.date} to ${later.date})`,
        detail:
          "At least one study has limited image quality; apparent size difference may reflect motion or incomplete visualization rather than anatomical change.",
        leftRef: earlier.id,
        rightRef: later.id,
        elapsedDays,
      };
    }
  }

  // Check spacing difference if both specify spacingMm
  if (earlier.spacingMm && later.spacingMm) {
    const sliceDiff = Math.abs(earlier.spacingMm[2] - later.spacingMm[2]);
    if (sliceDiff > REPROTRACE_PARAMS.MAX_SLICE_THICKNESS_GAP_MM) {
      return {
        category: "unresolved_uncertainty",
        attributionCategory: "protocol_or_spacing_difference",
        summary: `Slice thickness differs (${earlier.spacingMm[2]} mm vs ${later.spacingMm[2]} mm)`,
        detail: `Acquisition slice thickness changed by ${sliceDiff.toFixed(1)} mm between ${earlier.date} and ${later.date}; partial-volume effects limit direct comparison.`,
        leftRef: earlier.id,
        rightRef: later.id,
        elapsedDays,
      };
    }
  }

  const v1 =
    earlier.volumeMm3 ??
    (earlier.axesMm ? ellipsoidVolumeMm3(earlier.axesMm) : null);
  const v2 =
    later.volumeMm3 ?? (later.axesMm ? ellipsoidVolumeMm3(later.axesMm) : null);
  const volumeDeltaPct =
    v1 != null && v2 != null && v1 > 0
      ? Number((((v2 - v1) / v1) * 100).toFixed(1))
      : null;
  const growthRateMm3PerMonth =
    v1 != null && v2 != null && elapsedDays != null && elapsedDays >= 14
      ? Number((((v2 - v1) / elapsedDays) * 30.4375).toFixed(1))
      : null;
  const u1 =
    earlier.uncertaintyMm3 ??
    (v1 != null ? computeVoxelBoundaryUncertainty(v1, earlier.spacingMm ?? undefined) : 0);
  const u2 =
    later.uncertaintyMm3 ??
    (v2 != null ? computeVoxelBoundaryUncertainty(v2, later.spacingMm ?? undefined) : 0);
  const combinedUncertaintyMm3 = Number(Math.hypot(u1, u2).toFixed(1));

  if (earlier.longestMm == null || later.longestMm == null || earlier.longestMm <= 0 || later.longestMm <= 0) return null;
  const rel =
    Math.abs(earlier.longestMm - later.longestMm) /
    Math.min(earlier.longestMm, later.longestMm);
  if (rel <= 0.15) return null;

  return {
    category: "measurable_difference",
    attributionCategory: "genuine_anatomical_change",
    summary: `Longest axis ${earlier.longestMm.toFixed(0)} mm (${earlier.date}) to ${later.longestMm.toFixed(0)} mm (${later.date})`,
    detail: `Relative change is ${(rel * 100).toFixed(0)}% where modality and measurement basis match. ReproTrace calls this a measurable difference only. It is not a determination of progression, response, or clinical significance.`,
    leftRef: earlier.id,
    rightRef: later.id,
    volumeDeltaPct,
    elapsedDays: elapsedDays != null ? Number(elapsedDays.toFixed(2)) : null,
    growthRateMm3PerMonth,
    uncertaintyMm3: combinedUncertaintyMm3 > 0 ? combinedUncertaintyMm3 : null,
  };
}

export function methodGap(a: Measure, b: Measure): Discrepancy | null {
  if (a.longestMm == null || b.longestMm == null) return null;
  if (a.modality === b.modality) return null;
  if (!a.locationLabel || a.locationLabel !== b.locationLabel) return null;
  return {
    category: "method_difference",
    attributionCategory: "protocol_or_spacing_difference",
    summary: `${a.modality} ${a.longestMm.toFixed(0)} mm vs ${b.modality} ${b.longestMm.toFixed(0)} mm (${a.locationLabel})`,
    detail:
      "Different modalities are not treated as a before-and-after of one measurement. Plane, boundary definition, and resolution commonly move the number without a biological change being knowable from these two values alone.",
    leftRef: a.id,
    rightRef: b.id,
  };
}

export function segmentationGap(a: Measure, b: Measure): Discrepancy | null {
  if (a.findingId !== b.findingId || a.source === b.source) return null;
  if (!a.axesMm || !b.axesMm) return null;
  const va = a.volumeMm3 ?? ellipsoidVolumeMm3(a.axesMm);
  const vb = b.volumeMm3 ?? ellipsoidVolumeMm3(b.axesMm);
  const rel = Math.abs(va - vb) / Math.min(va, vb);
  if (rel <= 0.2) return null;
  return {
    category: "segmentation_disagreement",
    attributionCategory: "segmentation_method_difference",
    summary: "Stored geometry and a later edit disagree by more than 20% volume",
    detail: `Ellipsoid volumes differ by ${(rel * 100).toFixed(0)}% (${Math.round(va)} mm³ vs ${Math.round(vb)} mm³). The earlier version is kept. Demonstration geometry is not a trained model output.`,
    leftRef: a.id,
    rightRef: b.id,
    volumeDeltaPct: Number((((vb - va) / va) * 100).toFixed(1)),
  };
}

export function reportGap(m: Measure): Discrepancy | null {
  if (m.longestMm == null || m.reportLongestMm == null) return null;
  const delta = Math.abs(m.longestMm - m.reportLongestMm);
  if (delta <= 3) return null;
  return {
    category: "reporting_inconsistency",
    attributionCategory: "insufficient_evidence",
    summary: `Report states ${m.reportLongestMm.toFixed(0)} mm; structured record states ${m.longestMm.toFixed(0)} mm`,
    detail:
      "The narrative measurement and the structured measurement disagree by more than 3 mm. Neither value is overwritten.",
    leftRef: m.id,
    rightRef: m.id,
  };
}

export type Explained = { text: string; source: string };

export function explainFinding(input: {
  structure: string;
  location: string;
  quote: string | null;
  axesMm: [number, number, number] | null;
  basis: string;
  verified: boolean;
  sourceName: string;
}): { paragraphs: Explained[]; insufficient: boolean } {
  const paragraphs: Explained[] = [];
  if (input.quote) {
    paragraphs.push({
      text: `The stored report says: “${input.quote}”`,
      source: "Clinical report excerpt stored with this finding",
    });
  }
  if (input.axesMm) {
    paragraphs.push({
      text: `The structured measurement kept for this version is ${input.axesMm.map((n) => n.toFixed(0)).join(" × ")} mm (${input.basis}), recorded at ${input.location}.`,
      source: input.sourceName,
    });
  } else {
    paragraphs.push({
      text: `A location is on file (${input.location}) but a three-axis measurement is not.`,
      source: input.sourceName,
    });
  }
  paragraphs.push({
    text: input.verified
      ? "A clinician review is attached to this version. That review does not by itself diagnose a condition or recommend treatment."
      : "This version has no clinician verification on file. It must not be read as a confirmed diagnosis.",
    source: "Review log",
  });
  paragraphs.push({
    text: "AnatomyBridge does not prescribe medication, recommend surgery, or infer malignancy from this record.",
    source: "Product safety policy",
  });
  return { paragraphs, insufficient: !input.quote };
}
