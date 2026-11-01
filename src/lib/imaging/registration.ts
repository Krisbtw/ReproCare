/**
 * Rigid 3D image registration for longitudinal follow-up imaging.
 *
 * Estimates rigid alignment (3D translation + 3D rotation) between a fixed reference volume
 * and a moving follow-up volume using intensity-weighted spatial moments and principal axes of inertia.
 *
 * Coordinate convention & units:
 * - All physical positions, centroids, and translations are in millimetres (mm) in the 3D right-handed
 *   DICOM Patient Coordinate System (LPS: +X = Left, +Y = Posterior, +Z = Superior) or calibrated
 *   physical volume millimetre frame.
 * - Transformations map moving coordinates (p_moving, in mm) into fixed reference coordinates (p_fixed, in mm):
 *     p_fixed = R * (p_moving - movingCentroidMm) + centerOfRotationMm
 *   or equivalently via the canonical 4x4 row-major homogeneous matrix M:
 *     [x_fixed, y_fixed, z_fixed, 1]^T = M * [x_moving, y_moving, z_moving, 1]^T
 *   where the effective affine translation column is:
 *     t_affine = hasCentroids ? (centerOfRotationMm - R * movingCentroidMm) : translationMm.
 */
import type { Mask, Vec3, Volume } from "./volume.ts";
import { sampleTrilinear } from "./preprocess.ts";

export type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

/** Canonical 16-element row-major 4x4 homogeneous rigid transformation matrix (in mm). */
export type Matrix4x4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export type RegistrationTransform = {
  /** 3D translation in physical millimetres. */
  translationMm: Vec3;
  /** 3x3 orthonormal proper rotation matrix. det(R) = +1. */
  rotation: Matrix3x3;
  /** Center of rotation in physical millimetres (fixed volume centroid). */
  centerOfRotationMm: Vec3;
  /** Moving volume centroid in physical millimetres. */
  movingCentroidMm: Vec3;
  /** Canonical 16-element row-major 4x4 homogeneous transformation matrix mapping moving (mm) -> fixed (mm). */
  matrix4x4?: Matrix4x4;
};

export type RegistrationTransformInput =
  | RegistrationTransform
  | Matrix4x4
  | number[]
  | number[][]
  | {
      transform?: unknown;
      translation?: { x: number; y: number; z: number } | Vec3;
      rotation?: { x: number; y: number; z: number } | Matrix3x3;
      translationMm?: Vec3;
      centerOfRotationMm?: Vec3;
      movingCentroidMm?: Vec3;
      matrix4x4?: number[];
    };

export type TransformValidationResult = {
  valid: boolean;
  reason?: string;
  determinant?: number;
  orthonormalityError?: number;
  translationMagnitudeMm?: number;
  transform?: RegistrationTransform;
  matrix4x4?: Matrix4x4;
};

export type RegistrationResult = {
  transform: RegistrationTransform;
  /** Mean squared intensity difference after alignment (sampled). */
  residualMse: number;
  /** Estimated physical alignment residual in millimetres (mm). */
  residualMm: number;
  /** Normalized cross-correlation between aligned volumes [-1, 1]. */
  ncc: number;
  /** True when spatial correspondence is supported (valid transform, good overlap, positive NCC, reasonable deformation). */
  supported: boolean;
  /** Explicit registration status classification. */
  status: "verified" | "unverified" | "failed";
  /** True when the transformation matrix is a valid proper rigid transformation. */
  matrixValid: boolean;
  /** Number of overlapping voxel samples evaluated during correlation check. */
  overlapCount: number;
  notes: string[];
};

const MAX_PHYSICAL_TRANSLATION_MM = 500;
const ORTHONORMAL_TOL = 1e-2;
const DET_TOL = 2e-2;
const HOMOGENEOUS_ROW_TOL = 1e-4;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && isFiniteNum(v[0]) && isFiniteNum(v[1]) && isFiniteNum(v[2]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function matVec(m: Matrix3x3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function matMul(a: Matrix3x3, b: Matrix3x3): Matrix3x3 {
  const res: Matrix3x3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      res[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return res;
}

function matTranspose(m: Matrix3x3): Matrix3x3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function det3(m: Matrix3x3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/**
 * Builds a 3x3 proper rotation matrix from XYZ Euler angles (in radians).
 */
export function eulerToRotationMatrix(rx: number, ry: number, rz: number): Matrix3x3 {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);

  const Rx: Matrix3x3 = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ];
  const Ry: Matrix3x3 = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const Rz: Matrix3x3 = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  return matMul(Rz, matMul(Ry, Rx));
}

function hasNonZeroCentroids(centerOfRotationMm: Vec3, movingCentroidMm: Vec3): boolean {
  return (
    Math.abs(centerOfRotationMm[0]) > 1e-9 ||
    Math.abs(centerOfRotationMm[1]) > 1e-9 ||
    Math.abs(centerOfRotationMm[2]) > 1e-9 ||
    Math.abs(movingCentroidMm[0]) > 1e-9 ||
    Math.abs(movingCentroidMm[1]) > 1e-9 ||
    Math.abs(movingCentroidMm[2]) > 1e-9
  );
}

/**
 * Computes the canonical 16-element row-major 4x4 homogeneous transformation matrix
 * mapping moving physical coordinates (mm) to fixed reference coordinates (mm).
 */
export function toMatrix4x4(transform: RegistrationTransform): Matrix4x4 {
  const R = transform.rotation;
  let tx: number, ty: number, tz: number;
  if (hasNonZeroCentroids(transform.centerOfRotationMm, transform.movingCentroidMm)) {
    const rotMoving = matVec(R, transform.movingCentroidMm);
    tx = transform.centerOfRotationMm[0] - rotMoving[0];
    ty = transform.centerOfRotationMm[1] - rotMoving[1];
    tz = transform.centerOfRotationMm[2] - rotMoving[2];
  } else {
    tx = transform.translationMm[0];
    ty = transform.translationMm[1];
    tz = transform.translationMm[2];
  }
  return [
    R[0][0], R[0][1], R[0][2], tx,
    R[1][0], R[1][1], R[1][2], ty,
    R[2][0], R[2][1], R[2][2], tz,
    0, 0, 0, 1,
  ];
}

/**
 * Validates a 3x3 rotation matrix for finite values, orthonormality (R^T R = I), and proper rotation (det(R) = +1).
 */
export function validateRotationMatrix(R: unknown): { valid: boolean; reason?: string; determinant?: number; orthonormalityError?: number } {
  if (!Array.isArray(R) || R.length !== 3) {
    return { valid: false, reason: "Rotation matrix must be a 3x3 array." };
  }
  for (let r = 0; r < 3; r += 1) {
    if (!Array.isArray(R[r]) || R[r].length !== 3) {
      return { valid: false, reason: `Rotation matrix row ${r} must have 3 elements.` };
    }
    for (let c = 0; c < 3; c += 1) {
      if (!isFiniteNum(R[r][c])) {
        return { valid: false, reason: `Rotation matrix element [${r}][${c}] is not a finite number.` };
      }
    }
  }
  const m = R as Matrix3x3;
  const rtR = matMul(matTranspose(m), m);
  let maxOrthoErr = 0;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const expected = r === c ? 1 : 0;
      const err = Math.abs(rtR[r][c] - expected);
      if (err > maxOrthoErr) maxOrthoErr = err;
    }
  }
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-4) {
    return { valid: false, reason: `Rotation matrix is singular (det = ${d.toFixed(4)}).`, determinant: d, orthonormalityError: maxOrthoErr };
  }
  if (d < 0) {
    return { valid: false, reason: `Rotation matrix is an improper reflection (det = ${d.toFixed(4)} < 0; expected +1).`, determinant: d, orthonormalityError: maxOrthoErr };
  }
  if ( maxOrthoErr > ORTHONORMAL_TOL || Math.abs(d - 1) > DET_TOL ) {
    return {
      valid: false,
      reason: `Rotation matrix is not orthonormal rigid (det = ${d.toFixed(4)}, orthoError = ${maxOrthoErr.toFixed(4)}).`,
      determinant: d,
      orthonormalityError: maxOrthoErr,
    };
  }
  return { valid: true, determinant: d, orthonormalityError: maxOrthoErr };
}

/**
 * Validates and normalizes any supported transformation representation into the single canonical
 * RegistrationTransform structure (with its 4x4 homogeneous matrix attached).
 */
export function validateTransformMatrix(input: unknown): TransformValidationResult {
  if (input == null) {
    return { valid: false, reason: "Transformation is missing (null or undefined)." };
  }

  let raw: unknown = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { valid: false, reason: "Transformation JSON string is malformed." };
    }
  }

  // Unwrap wrapper objects `{ transform: ... }` if passed
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "transform" in (raw as Record<string, unknown>) &&
    (raw as Record<string, unknown>).transform != null &&
    !("rotation" in (raw as Record<string, unknown>) && "translationMm" in (raw as Record<string, unknown>))
  ) {
    raw = (raw as Record<string, unknown>).transform;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return { valid: false, reason: "Nested transformation JSON string is malformed." };
      }
    }
  }

  // Case 1: Flat 16-element 4x4 row-major array
  if (Array.isArray(raw) && raw.length === 16 && raw.every((x) => !Array.isArray(x))) {
    for (let i = 0; i < 16; i += 1) {
      if (!isFiniteNum(raw[i])) {
        return { valid: false, reason: `4x4 matrix element at index ${i} is not a finite number.` };
      }
    }
    const m = raw as number[];
    if (
      Math.abs(m[12]) > HOMOGENEOUS_ROW_TOL ||
      Math.abs(m[13]) > HOMOGENEOUS_ROW_TOL ||
      Math.abs(m[14]) > HOMOGENEOUS_ROW_TOL ||
      Math.abs(m[15] - 1) > HOMOGENEOUS_ROW_TOL
    ) {
      return {
        valid: false,
        reason: `Invalid 4x4 homogeneous bottom row [${m[12]}, ${m[13]}, ${m[14]}, ${m[15]}]; expected [0, 0, 0, 1].`,
      };
    }
    const rotation: Matrix3x3 = [
      [m[0], m[1], m[2]],
      [m[4], m[5], m[6]],
      [m[8], m[9], m[10]],
    ];
    const rotCheck = validateRotationMatrix(rotation);
    if (!rotCheck.valid) return rotCheck;

    const translationMm: Vec3 = [m[3], m[7], m[11]];
    const tMag = Math.sqrt(dot(translationMm, translationMm));
    if (tMag > MAX_PHYSICAL_TRANSLATION_MM) {
      return { valid: false, reason: `Translation magnitude (${tMag.toFixed(1)} mm) exceeds physical limit (${MAX_PHYSICAL_TRANSLATION_MM} mm).` };
    }
    const matrix4x4: Matrix4x4 = [
      m[0], m[1], m[2], m[3],
      m[4], m[5], m[6], m[7],
      m[8], m[9], m[10], m[11],
      0, 0, 0, 1,
    ];
    const transform: RegistrationTransform = {
      translationMm,
      rotation,
      centerOfRotationMm: [0, 0, 0],
      movingCentroidMm: [0, 0, 0],
      matrix4x4,
    };
    return {
      valid: true,
      determinant: rotCheck.determinant,
      orthonormalityError: rotCheck.orthonormalityError,
      translationMagnitudeMm: tMag,
      transform,
      matrix4x4,
    };
  }

  // Case 2: Nested 4x4 array
  if (Array.isArray(raw) && raw.length === 4 && raw.every((row) => Array.isArray(row) && row.length === 4)) {
    const flat = (raw as number[][]).flat();
    return validateTransformMatrix(flat);
  }

  // If it's any other array, it has wrong dimensions
  if (Array.isArray(raw)) {
    return { valid: false, reason: `Unsupported transformation array length (${raw.length}); expected 16-element 4x4 matrix.` };
  }

  if (!raw || typeof raw !== "object") {
    return { valid: false, reason: "Transformation must be an object or 4x4 matrix array." };
  }

  const obj = raw as Record<string, unknown>;

  // Case 3: Canonical RegistrationTransform object `{ translationMm, rotation, centerOfRotationMm, movingCentroidMm }`
  if ("translationMm" in obj || "centerOfRotationMm" in obj || "movingCentroidMm" in obj) {
    const translationMm: Vec3 | null = isVec3(obj.translationMm)
      ? [obj.translationMm[0], obj.translationMm[1], obj.translationMm[2]]
      : null;
    if (!translationMm) {
      return { valid: false, reason: "RegistrationTransform.translationMm must be a finite [x, y, z] triple in mm." };
    }
    const rotCheck = validateRotationMatrix(obj.rotation);
    if (!rotCheck.valid) return rotCheck;

    const centerOfRotationMm: Vec3 = isVec3(obj.centerOfRotationMm)
      ? [obj.centerOfRotationMm[0], obj.centerOfRotationMm[1], obj.centerOfRotationMm[2]]
      : [0, 0, 0];
    const movingCentroidMm: Vec3 = isVec3(obj.movingCentroidMm)
      ? [obj.movingCentroidMm[0], obj.movingCentroidMm[1], obj.movingCentroidMm[2]]
      : [0, 0, 0];

    if (obj.centerOfRotationMm !== undefined && !isVec3(obj.centerOfRotationMm)) {
      return { valid: false, reason: "RegistrationTransform.centerOfRotationMm must be a finite [x, y, z] triple in mm." };
    }
    if (obj.movingCentroidMm !== undefined && !isVec3(obj.movingCentroidMm)) {
      return { valid: false, reason: "RegistrationTransform.movingCentroidMm must be a finite [x, y, z] triple in mm." };
    }

    const baseTransform: RegistrationTransform = {
      translationMm,
      rotation: obj.rotation as Matrix3x3,
      centerOfRotationMm,
      movingCentroidMm,
    };
    const matrix4x4 = toMatrix4x4(baseTransform);
    const effTranslation: Vec3 = [matrix4x4[3], matrix4x4[7], matrix4x4[11]];
    const tMag = Math.sqrt(dot(effTranslation, effTranslation));
    if (tMag > MAX_PHYSICAL_TRANSLATION_MM) {
      return { valid: false, reason: `Effective translation magnitude (${tMag.toFixed(1)} mm) exceeds physical limit (${MAX_PHYSICAL_TRANSLATION_MM} mm).` };
    }
    baseTransform.matrix4x4 = matrix4x4;
    return {
      valid: true,
      determinant: rotCheck.determinant,
      orthonormalityError: rotCheck.orthonormalityError,
      translationMagnitudeMm: tMag,
      transform: baseTransform,
      matrix4x4,
    };
  }

  // Case 4: `{ translation: { x, y, z } | [x, y, z], rotation?: { x, y, z } | Matrix3x3 }`
  if ("translation" in obj && obj.translation != null) {
    let translationMm: Vec3 | null = null;
    if (isVec3(obj.translation)) {
      translationMm = [obj.translation[0], obj.translation[1], obj.translation[2]];
    } else if (typeof obj.translation === "object") {
      const t = obj.translation as Record<string, unknown>;
      if (isFiniteNum(t.x) && isFiniteNum(t.y) && isFiniteNum(t.z)) {
        translationMm = [t.x, t.y, t.z];
      }
    }
    if (!translationMm) {
      return { valid: false, reason: "Translation must have finite x, y, z coordinates in mm." };
    }

    let rotation: Matrix3x3 = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    if (obj.rotation != null) {
      if (Array.isArray(obj.rotation)) {
        const rotCheck = validateRotationMatrix(obj.rotation);
        if (!rotCheck.valid) return rotCheck;
        rotation = obj.rotation as Matrix3x3;
      } else if (typeof obj.rotation === "object") {
        const r = obj.rotation as Record<string, unknown>;
        if (!isFiniteNum(r.x) || !isFiniteNum(r.y) || !isFiniteNum(r.z)) {
          return { valid: false, reason: "Euler rotation must have finite x, y, z angles." };
        }
        rotation = eulerToRotationMatrix(r.x, r.y, r.z);
      } else {
        return { valid: false, reason: "Invalid rotation property structure." };
      }
    }

    const rotCheck = validateRotationMatrix(rotation);
    if (!rotCheck.valid) return rotCheck;

    const tMag = Math.sqrt(dot(translationMm, translationMm));
    if (tMag > MAX_PHYSICAL_TRANSLATION_MM) {
      return { valid: false, reason: `Translation magnitude (${tMag.toFixed(1)} mm) exceeds physical limit (${MAX_PHYSICAL_TRANSLATION_MM} mm).` };
    }

    const transform: RegistrationTransform = {
      translationMm,
      rotation,
      centerOfRotationMm: [0, 0, 0],
      movingCentroidMm: [0, 0, 0],
    };
    const matrix4x4 = toMatrix4x4(transform);
    transform.matrix4x4 = matrix4x4;
    return {
      valid: true,
      determinant: rotCheck.determinant,
      orthonormalityError: rotCheck.orthonormalityError,
      translationMagnitudeMm: tMag,
      transform,
      matrix4x4,
    };
  }

  // Case 5: Object with `matrix4x4`
  if ("matrix4x4" in obj && Array.isArray(obj.matrix4x4)) {
    return validateTransformMatrix(obj.matrix4x4);
  }

  return { valid: false, reason: "Unrecognized transformation format." };
}

/**
 * Converts a valid 4x4 matrix into a canonical RegistrationTransform, or throws if invalid.
 */
export function fromMatrix4x4(matrix: number[] | number[][]): RegistrationTransform {
  const res = validateTransformMatrix(matrix);
  if (!res.valid || !res.transform) {
    throw new Error(res.reason ?? "Invalid 4x4 transformation matrix.");
  }
  return res.transform;
}

/**
 * Parses and validates any supported registration transformation representation, returning null if invalid.
 */
export function parseRegistrationTransform(input: unknown): RegistrationTransform | null {
  const res = validateTransformMatrix(input);
  return res.valid && res.transform ? res.transform : null;
}

/**
 * Computes intensity-weighted center of mass (centroid) and 3x3 covariance matrix in millimetres.
 */
export function volumeMoments(
  volume: Volume,
  mask?: Mask,
): { centroidMm: Vec3; covariance: Matrix3x3; totalMass: number } {
  const [nx, ny, nz] = volume.dims;
  const [sx, sy, sz] = volume.spacingMm;
  let totalMass = 0;
  let mx = 0, my = 0, mz = 0;

  for (let z = 0; z < nz; z += 1) {
    const pz = z * sz;
    for (let y = 0; y < ny; y += 1) {
      const py = y * sy;
      for (let x = 0; x < nx; x += 1) {
        const idx = x + nx * (y + ny * z);
        if (mask && !mask.data[idx]) continue;
        const val = Math.max(0, volume.data[idx]);
        totalMass += val;
        const px = x * sx;
        mx += px * val;
        my += py * val;
        mz += pz * val;
      }
    }
  }

  if (totalMass <= 1e-6) {
    const center: Vec3 = [(nx * sx) / 2, (ny * sy) / 2, (nz * sz) / 2];
    return {
      centroidMm: center,
      covariance: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      totalMass: 0,
    };
  }

  const cx = mx / totalMass;
  const cy = my / totalMass;
  const cz = mz / totalMass;

  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (let z = 0; z < nz; z += 1) {
    const dz = z * sz - cz;
    for (let y = 0; y < ny; y += 1) {
      const dy = y * sy - cy;
      for (let x = 0; x < nx; x += 1) {
        const idx = x + nx * (y + ny * z);
        if (mask && !mask.data[idx]) continue;
        const val = Math.max(0, volume.data[idx]);
        const dx = x * sx - cx;
        cxx += dx * dx * val;
        cyy += dy * dy * val;
        czz += dz * dz * val;
        cxy += dx * dy * val;
        cxz += dx * dz * val;
        cyz += dy * dz * val;
      }
    }
  }

  const covariance: Matrix3x3 = [
    [cxx / totalMass, cxy / totalMass, cxz / totalMass],
    [cxy / totalMass, cyy / totalMass, cyz / totalMass],
    [cxz / totalMass, cyz / totalMass, czz / totalMass],
  ];

  return { centroidMm: [cx, cy, cz], covariance, totalMass };
}

/**
 * Jacobi eigenvalue algorithm for 3x3 symmetric matrix.
 * Returns sorted eigenvalues (descending) and orthonormal eigenvectors matrix V (columns are eigenvectors).
 */
export function eigen3x3(A: Matrix3x3): { values: Vec3; vectors: Matrix3x3 } {
  let V: Matrix3x3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let a: Matrix3x3 = [
    [A[0][0], A[0][1], A[0][2]],
    [A[1][0], A[1][1], A[1][2]],
    [A[2][0], A[2][1], A[2][2]],
  ];

  for (let iter = 0; iter < 50; iter += 1) {
    let p = 0, q = 1;
    let maxOff = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(a[1][2]); }

    if (maxOff < 1e-9) break;

    const diff = a[q][q] - a[p][p];
    let t: number;
    if (Math.abs(diff) < 1e-12) {
      t = a[p][q] > 0 ? 1 : -1;
    } else {
      const phi = diff / (2 * a[p][q]);
      t = 1 / (Math.abs(phi) + Math.sqrt(phi * phi + 1));
      if (phi < 0) t = -t;
    }

    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    const tau = s / (1 + c);
    const apq = a[p][q];

    a[p][p] -= t * apq;
    a[q][q] += t * apq;
    a[p][q] = 0;
    a[q][p] = 0;

    for (let j = 0; j < 3; j += 1) {
      if (j !== p && j !== q) {
        const ajp = a[j][p];
        const ajq = a[j][q];
        a[j][p] = ajp - s * (ajq + tau * ajp);
        a[p][j] = a[j][p];
        a[j][q] = ajq + s * (ajp - tau * ajq);
        a[q][j] = a[j][q];
      }
    }

    for (let j = 0; j < 3; j += 1) {
      const vjp = V[j][p];
      const vjq = V[j][q];
      V[j][p] = vjp - s * (vjq + tau * vjp);
      V[j][q] = vjq + s * (vjp - tau * vjq);
    }
  }

  // Sort eigenvalues descending
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const sortedValues: Vec3 = [a[order[0]][order[0]], a[order[1]][order[1]], a[order[2]][order[2]]];
  const sortedVectors: Matrix3x3 = [
    [V[0][order[0]], V[0][order[1]], V[0][order[2]]],
    [V[1][order[0]], V[1][order[1]], V[1][order[2]]],
    [V[2][order[0]], V[2][order[1]], V[2][order[2]]],
  ];

  return { values: sortedValues, vectors: sortedVectors };
}

/**
 * Calculates rigid registration (translation + rotation) aligning moving volume to fixed volume.
 */
export function registerVolumes(
  fixed: Volume,
  moving: Volume,
  options?: { fixedMask?: Mask; movingMask?: Mask },
): RegistrationResult {
  const mf = volumeMoments(fixed, options?.fixedMask);
  const mm = volumeMoments(moving, options?.movingMask);

  const ef = eigen3x3(mf.covariance);
  const em = eigen3x3(mm.covariance);

  let R: Matrix3x3;
  const isotropicF = (ef.values[0] - ef.values[2]) / (ef.values[0] + 1e-6) < 0.1;
  const isotropicM = (em.values[0] - em.values[2]) / (em.values[0] + 1e-6) < 0.1;

  if (isotropicF || isotropicM) {
    R = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  } else {
    // Initial rotation matrix R = Vf * Vm^T
    R = matMul(ef.vectors, matTranspose(em.vectors));
    // Ensure proper rotation (det = +1)
    if (det3(R) < 0) {
      const emV = [
        [em.vectors[0][0], em.vectors[0][1], -em.vectors[0][2]],
        [em.vectors[1][0], em.vectors[1][1], -em.vectors[1][2]],
        [em.vectors[2][0], em.vectors[2][1], -em.vectors[2][2]],
      ] as Matrix3x3;
      R = matMul(ef.vectors, matTranspose(emV));
    }
  }

  // Translation in mm from moving centroid to fixed centroid:
  // p_fixed = R * (p_moving - mm.centroid) + mf.centroid
  const translationMm: Vec3 = [
    mf.centroidMm[0] - mm.centroidMm[0],
    mf.centroidMm[1] - mm.centroidMm[1],
    mf.centroidMm[2] - mm.centroidMm[2],
  ];

  const transform: RegistrationTransform = {
    translationMm,
    rotation: R,
    centerOfRotationMm: mf.centroidMm,
    movingCentroidMm: mm.centroidMm,
  };
  transform.matrix4x4 = toMatrix4x4(transform);

  const notes: string[] = [];
  const shiftDist = Math.sqrt(dot(translationMm, translationMm));
  notes.push(`Centroid shift: ${shiftDist.toFixed(1)} mm`);

  // Sample correlation
  const [nx, ny, nz] = fixed.dims;
  let sumF = 0, sumM = 0, sumFM = 0, sumF2 = 0, sumM2 = 0;
  let count = 0;
  let sumSqrDiff = 0;

  const stride = Math.max(1, Math.floor((nx * ny * nz) / 5000));
  for (let z = 0; z < nz; z += stride) {
    for (let y = 0; y < ny; y += stride) {
      for (let x = 0; x < nx; x += stride) {
        const ptFixed: Vec3 = [x * fixed.spacingMm[0], y * fixed.spacingMm[1], z * fixed.spacingMm[2]];
        const ptMoving = inverseTransformPoint(ptFixed, transform);
        const vxM = ptMoving[0] / moving.spacingMm[0];
        const vyM = ptMoving[1] / moving.spacingMm[1];
        const vzM = ptMoving[2] / moving.spacingMm[2];

        if (
          vxM >= 0 && vxM <= moving.dims[0] - 1 &&
          vyM >= 0 && vyM <= moving.dims[1] - 1 &&
          vzM >= 0 && vzM <= moving.dims[2] - 1
        ) {
          const valF = fixed.data[x + nx * (y + ny * z)];
          const valM = sampleTrilinear(moving, vxM, vyM, vzM, 0);
          sumF += valF;
          sumM += valM;
          sumFM += valF * valM;
          sumF2 += valF * valF;
          sumM2 += valM * valM;
          const diff = valF - valM;
          sumSqrDiff += diff * diff;
          count += 1;
        }
      }
    }
  }

  let ncc = 0;
  if (count > 20) {
    const meanF = sumF / count;
    const meanM = sumM / count;
    const varF = Math.max(0, sumF2 / count - meanF * meanF);
    const varM = Math.max(0, sumM2 / count - meanM * meanM);
    const cov = sumFM / count - meanF * meanM;
    if (varF > 1e-4 && varM > 1e-4) {
      ncc = cov / Math.sqrt(varF * varM);
    }
  }
  const residualMse = count > 0 ? sumSqrDiff / count : Infinity;

  // Estimate physical alignment residual in mm from principal-axis standard deviation mismatch
  const stdF: Vec3 = [Math.sqrt(Math.max(0, ef.values[0])), Math.sqrt(Math.max(0, ef.values[1])), Math.sqrt(Math.max(0, ef.values[2]))];
  const stdM: Vec3 = [Math.sqrt(Math.max(0, em.values[0])), Math.sqrt(Math.max(0, em.values[1])), Math.sqrt(Math.max(0, em.values[2]))];
  const extentDiffMm = Math.sqrt(
    Math.pow(stdF[0] - stdM[0], 2) +
    Math.pow(stdF[1] - stdM[1], 2) +
    Math.pow(stdF[2] - stdM[2], 2),
  );
  const residualMm = count > 0 && ncc > 0 ? Number((extentDiffMm + Math.max(0, 1 - ncc) * 2.0).toFixed(3)) : Infinity;

  const validation = validateTransformMatrix(transform);
  const matrixValid = validation.valid;
  const emptyMass = mf.totalMass <= 1e-6 || mm.totalMass <= 1e-6;
  const supported = matrixValid && !emptyMass && count > 50 && ncc > 0.25 && shiftDist < 120 && residualMm <= 15.0;
  const status: "verified" | "unverified" | "failed" = supported
    ? (ncc >= 0.5 ? "verified" : "unverified")
    : "failed";

  if (!supported) {
    notes.push("Registration quality is below confidence threshold; spatial correspondence cannot be guaranteed.");
  } else {
    notes.push(`NCC: ${ncc.toFixed(3)}, residual: ${residualMm.toFixed(2)} mm, overlap points: ${count}`);
  }

  return {
    transform,
    residualMse,
    residualMm,
    ncc,
    supported,
    status,
    matrixValid,
    overlapCount: count,
    notes,
  };
}

/**
 * Transforms a point from moving physical coordinates (mm) into fixed reference coordinates (mm).
 * Supports canonical RegistrationTransform objects, 4x4 matrices (16-element or 4x4 nested), and translation/rotation objects.
 */
export function transformPoint(pointMm: Vec3, transformInput: RegistrationTransformInput): Vec3 {
  if (!isVec3(pointMm)) {
    throw new Error("Invalid 3D point coordinates: expected finite [x, y, z] in millimetres.");
  }
  const validation = validateTransformMatrix(transformInput);
  if (!validation.valid || !validation.transform) {
    throw new Error(`Invalid transformation matrix: ${validation.reason ?? "validation failed"}`);
  }
  const transform = validation.transform;
  if (hasNonZeroCentroids(transform.centerOfRotationMm, transform.movingCentroidMm)) {
    const d: Vec3 = [
      pointMm[0] - transform.movingCentroidMm[0],
      pointMm[1] - transform.movingCentroidMm[1],
      pointMm[2] - transform.movingCentroidMm[2],
    ];
    const rotated = matVec(transform.rotation, d);
    return [
      rotated[0] + transform.centerOfRotationMm[0],
      rotated[1] + transform.centerOfRotationMm[1],
      rotated[2] + transform.centerOfRotationMm[2],
    ];
  }
  const rotated = matVec(transform.rotation, pointMm);
  return [
    rotated[0] + transform.translationMm[0],
    rotated[1] + transform.translationMm[1],
    rotated[2] + transform.translationMm[2],
  ];
}

/**
 * Inverse transforms a point from fixed reference coordinates (mm) into moving coordinates (mm).
 */
export function inverseTransformPoint(pointMm: Vec3, transformInput: RegistrationTransformInput): Vec3 {
  if (!isVec3(pointMm)) {
    throw new Error("Invalid 3D point coordinates: expected finite [x, y, z] in millimetres.");
  }
  const validation = validateTransformMatrix(transformInput);
  if (!validation.valid || !validation.transform) {
    throw new Error(`Invalid transformation matrix: ${validation.reason ?? "validation failed"}`);
  }
  const transform = validation.transform;
  const Rinv = matTranspose(transform.rotation);
  if (hasNonZeroCentroids(transform.centerOfRotationMm, transform.movingCentroidMm)) {
    const d: Vec3 = [
      pointMm[0] - transform.centerOfRotationMm[0],
      pointMm[1] - transform.centerOfRotationMm[1],
      pointMm[2] - transform.centerOfRotationMm[2],
    ];
    const unrotated = matVec(Rinv, d);
    return [
      unrotated[0] + transform.movingCentroidMm[0],
      unrotated[1] + transform.movingCentroidMm[1],
      unrotated[2] + transform.movingCentroidMm[2],
    ];
  }
  const d: Vec3 = [
    pointMm[0] - transform.translationMm[0],
    pointMm[1] - transform.translationMm[1],
    pointMm[2] - transform.translationMm[2],
  ];
  return matVec(Rinv, d);
}
