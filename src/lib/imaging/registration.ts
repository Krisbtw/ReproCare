/**
 * Rigid 3D image registration for longitudinal follow-up imaging.
 *
 * Estimates rigid alignment (3D translation + 3D rotation) between a fixed reference volume
 * and a moving follow-up volume using intensity-weighted spatial moments and principal axes of inertia.
 *
 * Follow-up anatomical finding matches require genuine spatial correspondence:
 * finding locations must be evaluated in a registered physical frame, not unverified raw coordinate grids.
 */
import type { Mask, Vec3, Volume } from "./volume.ts";
import { sampleTrilinear } from "./preprocess.ts";

export type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

export type RegistrationTransform = {
  /** 3D translation in physical millimetres (applied after rotation around centerOfRotation). */
  translationMm: Vec3;
  /** 3x3 orthonormal rotation matrix. det(R) = +1. */
  rotation: Matrix3x3;
  /** Center of rotation in physical millimetres (fixed volume centroid). */
  centerOfRotationMm: Vec3;
  /** Moving volume centroid in physical millimetres. */
  movingCentroidMm: Vec3;
};

export type RegistrationResult = {
  transform: RegistrationTransform;
  /** Mean squared intensity difference after alignment (sampled). */
  residualMse: number;
  /** Normalized cross-correlation between aligned volumes [-1, 1]. */
  ncc: number;
  /** True when spatial correspondence is supported (good overlap, positive NCC, reasonable deformation). */
  supported: boolean;
  notes: string[];
};

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

function det3(m: Matrix3x3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
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

  const supported = count > 50 && ncc > 0.25 && shiftDist < 120;
  if (!supported) {
    notes.push("Registration quality is below confidence threshold; spatial correspondence cannot be guaranteed.");
  } else {
    notes.push(`NCC: ${ncc.toFixed(3)}, overlap points: ${count}`);
  }

  return { transform, residualMse, ncc, supported, notes };
}

/**
 * Transforms a point from moving physical coordinates into fixed reference coordinates.
 * p_fixed = R * (p_moving - movingCentroid) + fixedCentroid
 */
export function transformPoint(pointMm: Vec3, transform: RegistrationTransform): Vec3 {
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

/**
 * Inverse transforms a point from fixed reference coordinates into moving coordinates.
 */
export function inverseTransformPoint(pointMm: Vec3, transform: RegistrationTransform): Vec3 {
  const d: Vec3 = [
    pointMm[0] - transform.centerOfRotationMm[0],
    pointMm[1] - transform.centerOfRotationMm[1],
    pointMm[2] - transform.centerOfRotationMm[2],
  ];
  const Rinv = matTranspose(transform.rotation);
  const unrotated = matVec(Rinv, d);
  return [
    unrotated[0] + transform.movingCentroidMm[0],
    unrotated[1] + transform.movingCentroidMm[1],
    unrotated[2] + transform.movingCentroidMm[2],
  ];
}
