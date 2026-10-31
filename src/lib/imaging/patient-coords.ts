/**
 * DICOM Patient-Coordinate System (LPS) transformations.
 *
 * Implements DICOM Standard PS 3.3 C.7.6.2.1.1 (Image Position and Image Orientation Patient).
 * The patient coordinate system is right-handed and anatomical:
 *   +X = Patient Left (L)
 *   +Y = Patient Posterior (P)
 *   +Z = Patient Superior / Head (S)
 *
 * Converts image-index space and mesh vertices into genuine anatomical coordinates in millimetres.
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
  const rowCosines: Vec3 = normalize([orientation[0], orientation[1], orientation[2]]);
  const colCosines: Vec3 = normalize([orientation[3], orientation[4], orientation[5]]);

  let sliceCosines: Vec3;
  if (secondSliceOrigin) {
    const diff: Vec3 = [
      secondSliceOrigin[0] - origin[0],
      secondSliceOrigin[1] - origin[1],
      secondSliceOrigin[2] - origin[2],
    ];
    sliceCosines = normalize(diff);
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
