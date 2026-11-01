/**
 * DICOM Patient-Coordinate System (LPS) transformations and geometry validation.
 *
 * Implements DICOM Standard PS 3.3 C.7.6.2.1.1 (Image Position and Image Orientation Patient).
 * The patient coordinate system is right-handed and anatomical:
 *   +X = Patient Left (L)
 *   +Y = Patient Posterior (P)
 *   +Z = Patient Superior / Head (S)
 *
 * Converts image-index space and mesh vertices into genuine anatomical coordinates in millimetres,
 * and validates spacing and orientation before longitudinal comparison.
 */
import type { Mesh } from "./isosurface.ts";
import type { Vec3 } from "./volume.ts";

export type PatientFrame = {
  /** ImagePositionPatient (LPS mm) of the first slice in the stacked volume (z=0). */
  origin: Vec3;
  /** Direction cosines for the row axis (increasing column index x). Unit vector. */
  rowCosines: Vec3;
  /** Direction cosines for the column axis (increasing row index y). Unit vector. */
  colCosines: Vec3;
  /** Direction cosines along slice normal (increasing slice index z). Unit vector. */
  sliceCosines: Vec3;
  /** Voxel spacing [spacingX (col step), spacingY (row step), spacingZ (slice step)] in mm. */
  spacingMm: Vec3;
  /** DICOM Frame of Reference UID if available. */
  frameOfReferenceUid?: string | null;
};

export type PatientFrameValidation = {
  valid: boolean;
  reasons: string[];
  normalizedFrame: PatientFrame | null;
};

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

function normalize(v: Vec3): Vec3 {
  const n = norm(v);
  if (n < 1e-9) return [0, 0, 1];
  return [v[0] / n, v[1] / n, v[2] / n];
}

function isFiniteTriple(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/**
 * Validates voxel spacing and patient orientation geometry before computing patient-space
 * coordinates or comparing findings across studies.
 */
export function validatePatientFrame(
  frame: Partial<PatientFrame> | null | undefined,
): PatientFrameValidation {
  if (!frame || typeof frame !== "object") {
    return {
      valid: false,
      reasons: ["Patient coordinate frame is missing (no DICOM position or orientation metadata)."],
      normalizedFrame: null,
    };
  }

  const reasons: string[] = [];
  if (!isFiniteTriple(frame.spacingMm) || frame.spacingMm.some((s) => s <= 0 || s > 500)) {
    reasons.push(
      `Invalid or missing voxel spacing ${JSON.stringify(frame.spacingMm)}; physical millimetres cannot be established.`,
    );
  }
  if (!isFiniteTriple(frame.origin)) {
    reasons.push("Missing or non-finite ImagePositionPatient (origin).");
  }
  if (!isFiniteTriple(frame.rowCosines) || !isFiniteTriple(frame.colCosines)) {
    reasons.push("Missing or non-finite ImageOrientationPatient direction cosines.");
  }

  if (reasons.length > 0) {
    return { valid: false, reasons, normalizedFrame: null };
  }

  const rNorm = norm(frame.rowCosines!);
  const cNorm = norm(frame.colCosines!);
  if (rNorm < 1e-4 || cNorm < 1e-4) {
    return {
      valid: false,
      reasons: ["Zero-length row or column direction cosine vector."],
      normalizedFrame: null,
    };
  }

  const rowUnit: Vec3 = [frame.rowCosines![0] / rNorm, frame.rowCosines![1] / rNorm, frame.rowCosines![2] / rNorm];
  const colUnit: Vec3 = [frame.colCosines![0] / cNorm, frame.colCosines![1] / cNorm, frame.colCosines![2] / cNorm];
  const orthoDot = Math.abs(dot(rowUnit, colUnit));
  if (orthoDot > 0.05) {
    return {
      valid: false,
      reasons: [`Row and column direction cosines are not orthogonal (|dot| = ${orthoDot.toFixed(4)} > 0.05).`],
      normalizedFrame: null,
    };
  }

  const rightHandNormal = normalize(cross(rowUnit, colUnit));
  let sliceUnit: Vec3 = rightHandNormal;
  if (isFiniteTriple(frame.sliceCosines)) {
    const sNorm = norm(frame.sliceCosines);
    if (sNorm < 1e-4) {
      return {
        valid: false,
        reasons: ["Zero-length slice normal vector."],
        normalizedFrame: null,
      };
    }
    sliceUnit = [frame.sliceCosines[0] / sNorm, frame.sliceCosines[1] / sNorm, frame.sliceCosines[2] / sNorm];
    // Slice normal must align with cross(row, col) (either +1 or -1 depending on slice acquisition order)
    const align = Math.abs(dot(sliceUnit, rightHandNormal));
    if (align < 0.95) {
      return {
        valid: false,
        reasons: [`Slice normal vector is not orthogonal to image plane (alignment ${align.toFixed(4)} < 0.95).`],
        normalizedFrame: null,
      };
    }
  }

  return {
    valid: true,
    reasons: [],
    normalizedFrame: {
      origin: [frame.origin![0], frame.origin![1], frame.origin![2]],
      rowCosines: rowUnit,
      colCosines: colUnit,
      sliceCosines: sliceUnit,
      spacingMm: [frame.spacingMm![0], frame.spacingMm![1], frame.spacingMm![2]],
      frameOfReferenceUid: frame.frameOfReferenceUid ?? null,
    },
  };
}

/**
 * Builds a patient coordinate frame from DICOM ImagePositionPatient, ImageOrientationPatient, and spacing.
 */
export function createPatientFrame(
  origin: Vec3,
  orientation: [number, number, number, number, number, number],
  spacingMm: Vec3,
  secondSliceOrigin?: Vec3 | null,
  frameOfReferenceUid?: string | null,
): PatientFrame {
  if (!isFiniteTriple(spacingMm) || spacingMm.some((s) => s <= 0)) {
    throw new Error(`Invalid voxel spacing [${spacingMm.join(", ")}]: all spacing axes must be finite and > 0 mm.`);
  }
  if (!isFiniteTriple(origin)) {
    throw new Error("Invalid ImagePositionPatient origin: must be three finite numbers in mm.");
  }
  if (!Array.isArray(orientation) || orientation.length !== 6 || orientation.some((v) => !Number.isFinite(v))) {
    throw new Error("Invalid ImageOrientationPatient: expected 6 finite direction cosines.");
  }

  const rowRaw: Vec3 = [orientation[0], orientation[1], orientation[2]];
  const colRaw: Vec3 = [orientation[3], orientation[4], orientation[5]];
  if (norm(rowRaw) < 1e-6 || norm(colRaw) < 1e-6) {
    throw new Error("Invalid ImageOrientationPatient: zero-length direction vector.");
  }

  const rowCosines: Vec3 = normalize(rowRaw);
  const colCosines: Vec3 = normalize(colRaw);
  if (Math.abs(dot(rowCosines, colCosines)) > 0.05) {
    throw new Error("Invalid ImageOrientationPatient: row and column direction cosines are not orthogonal.");
  }

  let sliceCosines: Vec3;
  if (secondSliceOrigin) {
    const diff: Vec3 = [
      secondSliceOrigin[0] - origin[0],
      secondSliceOrigin[1] - origin[1],
      secondSliceOrigin[2] - origin[2],
    ];
    sliceCosines = norm(diff) > 1e-6 ? normalize(diff) : normalize(cross(rowCosines, colCosines));
  } else {
    sliceCosines = normalize(cross(rowCosines, colCosines));
  }

  return {
    origin,
    rowCosines,
    colCosines,
    sliceCosines,
    spacingMm,
    frameOfReferenceUid: frameOfReferenceUid ?? null,
  };
}

/**
 * Transforms an image-index millimetre position [ux, uy, uz] (voxelIndex * spacing) to DICOM LPS patient mm.
 *
 * P_patient = Origin + ux * rowCosines + uy * colCosines + uz * sliceCosines
 */
export function imageMmToPatient(ptMm: Vec3, frame: PatientFrame): Vec3 {
  return [
    frame.origin[0] + ptMm[0] * frame.rowCosines[0] + ptMm[1] * frame.colCosines[0] + ptMm[2] * frame.sliceCosines[0],
    frame.origin[1] + ptMm[0] * frame.rowCosines[1] + ptMm[1] * frame.colCosines[1] + ptMm[2] * frame.sliceCosines[1],
    frame.origin[2] + ptMm[0] * frame.rowCosines[2] + ptMm[1] * frame.colCosines[2] + ptMm[2] * frame.sliceCosines[2],
  ];
}

/**
 * Transforms continuous voxel indices [vx, vy, vz] directly to DICOM LPS patient mm.
 */
export function voxelToPatient(voxel: Vec3, frame: PatientFrame): Vec3 {
  const ptMm: Vec3 = [
    voxel[0] * frame.spacingMm[0],
    voxel[1] * frame.spacingMm[1],
    voxel[2] * frame.spacingMm[2],
  ];
  return imageMmToPatient(ptMm, frame);
}

/**
 * Transforms DICOM LPS patient mm back to image-index millimetres [ux, uy, uz].
 * Uses projection onto the orthonormal row, column, and slice direction vectors.
 */
export function patientToImageMm(patientMm: Vec3, frame: PatientFrame): Vec3 {
  const d: Vec3 = [
    patientMm[0] - frame.origin[0],
    patientMm[1] - frame.origin[1],
    patientMm[2] - frame.origin[2],
  ];
  return [dot(d, frame.rowCosines), dot(d, frame.colCosines), dot(d, frame.sliceCosines)];
}

/**
 * Transforms DICOM LPS patient mm back to voxel indices [vx, vy, vz].
 */
export function patientToVoxel(patientMm: Vec3, frame: PatientFrame): Vec3 {
  const imgMm = patientToImageMm(patientMm, frame);
  return [
    imgMm[0] / frame.spacingMm[0],
    imgMm[1] / frame.spacingMm[1],
    imgMm[2] / frame.spacingMm[2],
  ];
}

/**
 * Transforms all vertex positions of a mesh from image-index millimetres into DICOM LPS Patient coordinates.
 * Returns a new mesh with identical topology and transformed vertex coordinates.
 */
export function transformMeshToPatient(mesh: Mesh, frame: PatientFrame): Mesh {
  const count = mesh.positions.length;
  const positions = new Float32Array(count);

  for (let i = 0; i < count; i += 3) {
    const ptMm: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    const p = imageMmToPatient(ptMm, frame);
    positions[i] = p[0];
    positions[i + 1] = p[1];
    positions[i + 2] = p[2];
  }

  return {
    positions,
    indices: mesh.indices.slice(),
  };
}

/**
 * Computes bounding box and center for a mesh in its coordinate frame.
 */
export function meshBounds(mesh: Mesh): { min: Vec3; max: Vec3; center: Vec3; span: Vec3 } {
  if (mesh.positions.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], span: [0, 0, 0] };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    const z = mesh.positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const min: Vec3 = [minX, minY, minZ];
  const max: Vec3 = [maxX, maxY, maxZ];
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const span: Vec3 = [maxX - minX, maxY - minY, maxZ - minZ];
  return { min, max, center, span };
}
