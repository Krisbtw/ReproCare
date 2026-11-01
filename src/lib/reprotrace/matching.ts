/**
 * ReproTrace Cross-Examination Matching logic.
 * Computes spatial correspondence and volumetric consistency across longitudinal findings
 * using the unified 3D rigid transformation representation and quality gating.
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
  type: "likely_same" | "potentially_new" | "requires_review" | "uncertain";
  spatialDistance: number;
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
  registration?: RegistrationResultTransform | RegistrationTransform | Matrix4x4 | number[] | number[][] | null,
): unknown {
  if (!registration) return null;
  if (Array.isArray(registration)) return registration;
  if (typeof registration === "object" && "transform" in registration && registration.transform != null) {
    return registration.transform;
  }
  if (typeof registration === "object" && "matrix" in registration && (registration as { matrix?: unknown }).matrix != null) {
    return (registration as { matrix?: unknown }).matrix;
  }
  return registration;
}

/**
 * Calculates Euclidean distance (in mm) between two 3D anatomical coordinates after applying
 * the validated registration transformation from moving (coord2) to fixed (coord1) space.
 */
export function calculateSpatialDistance(
  coord1: FindingCoord | Vec3,
  coord2: FindingCoord | Vec3,
  registration?: RegistrationResultTransform | RegistrationTransform | Matrix4x4 | number[] | number[][] | null,
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
 * Explicitly prevents `likely_same` matching when registration is missing across different studies/series,
 * when registration failed, when the transformation matrix is invalid, or when registration quality is insufficient.
 */
export function matchFindings(
  finding1: FindingItem,
  finding2: FindingItem,
  registration?: RegistrationResultTransform | RegistrationLookupEntry | null,
): MatchResult {
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
      ("transform" in registration || "matrix" in registration || "status" in registration || "supported" in registration)
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

  // If registration is unsupported (missing, failed, invalid matrix, series mismatch, or low quality),
  // never silently treat the two findings as the same lesion.
  if (!evaluated.quality.supported || !evaluated.transform) {
    const rawDist = calculateSpatialDistance(p1, p2, null);
    return {
      confidence: "low",
      type: "requires_review",
      spatialDistance: Number(rawDist.toFixed(2)),
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: evaluated.quality.notes.join(". ") || "Spatial correspondence could not be established.",
    };
  }

  const spatialDistance = calculateSpatialDistance(p1, p2, evaluated.transform);

  const labelMatch =
    finding1.anatomicalLabel.toLowerCase().trim() ===
    finding2.anatomicalLabel.toLowerCase().trim();

  const baseVol = Math.max(finding1.volume, 1e-4);
  const volumeDelta = Math.abs(finding1.volume - finding2.volume) / baseVol;

  if (spatialDistance < 10 && labelMatch && volumeDelta < 0.2) {
    return {
      confidence: "high",
      type: "likely_same",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      provisional: false,
      registrationQuality: evaluated.quality,
      rationale: `Matched within ${spatialDistance.toFixed(2)} mm in registered space. ${evaluated.quality.notes.join(". ")}`,
    };
  } else if (spatialDistance < 20 && labelMatch) {
    return {
      confidence: "medium",
      type: "potentially_new",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: `Moderate spatial separation (${spatialDistance.toFixed(2)} mm) or volume change (${(volumeDelta * 100).toFixed(1)}%).`,
    };
  } else {
    return {
      confidence: "low",
      type: "requires_review",
      spatialDistance: Number(spatialDistance.toFixed(2)),
      provisional: true,
      registrationQuality: evaluated.quality,
      rationale: `Spatial distance (${spatialDistance.toFixed(2)} mm) or anatomical label mismatch requires clinician review.`,
    };
  }
}
