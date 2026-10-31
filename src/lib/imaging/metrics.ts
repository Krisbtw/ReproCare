/**
 * Segmentation and geometry metrics. Every function returns null instead of inventing a number when the
 * inputs cannot support one (empty masks, mismatched grids).
 */
import type { Mask, Vec3 } from "./volume.ts";
import { NEIGHBORS_6, inBounds, maskVoxelCount, sameGrid, vIndex, voxelVolumeMl } from "./volume.ts";
import { labelComponents } from "./segment.ts";

export function dice(a: Mask, b: Mask): number | null {
  if (!sameGrid(a, b)) return null;
  let inter = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    if (a.data[i]) sa += 1;
    if (b.data[i]) sb += 1;
    if (a.data[i] && b.data[i]) inter += 1;
  }
  if (sa + sb === 0) return null;
  return (2 * inter) / (sa + sb);
}

export function jaccard(a: Mask, b: Mask): number | null {
  if (!sameGrid(a, b)) return null;
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    if (a.data[i] || b.data[i]) uni += 1;
    if (a.data[i] && b.data[i]) inter += 1;
  }
  return uni === 0 ? null : inter / uni;
}

/** Signed volume difference of `test` relative to `reference`, in percent. */
export function relativeVolumeDifferencePct(reference: Mask, test: Mask): number | null {
  if (!sameGrid(reference, test)) return null;
  const r = maskVoxelCount(reference);
  if (r === 0) return null;
  return ((maskVoxelCount(test) - r) / r) * 100;
}

function boundaryPoints(mask: Mask): Vec3[] {
  const pts: Vec3[] = [];
  const [nx, ny, nz] = mask.dims;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (!mask.data[vIndex(mask.dims, x, y, z)]) continue;
        let edge = false;
        for (const [dx, dy, dz] of NEIGHBORS_6) {
          if (!inBounds(mask.dims, x + dx, y + dy, z + dz) || !mask.data[vIndex(mask.dims, x + dx, y + dy, z + dz)]) {
            edge = true;
            break;
          }
        }
        if (edge) pts.push([x * mask.spacingMm[0], y * mask.spacingMm[1], z * mask.spacingMm[2]]);
      }
    }
  }
  return pts;
}

function directed(from: Vec3[], to: Vec3[]): number[] {
  // Uniform grid hash over `to` so cost stays near-linear for realistic masks.
  const cell = 4;
  const grid = new Map<string, Vec3[]>();
  const key = (p: Vec3) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const p of to) {
    const k = key(p);
    const arr = grid.get(k);
    if (arr) arr.push(p);
    else grid.set(k, [p]);
  }
  const out: number[] = [];
  for (const p of from) {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    const cz = Math.floor(p[2] / cell);
    let best = Infinity;
    for (let r = 0; r < 200; r += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        for (let dy = -r; dy <= r; dy += 1) {
          for (let dx = -r; dx <= r; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!arr) continue;
            for (const q of arr) {
              const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
              if (d < best) best = d;
            }
          }
        }
      }
      // Any point in ring r+1 or beyond is at least r*cell away.
      if (best <= r * cell) break;
    }
    out.push(best);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export type SurfaceDistances = {
  hausdorffMm: number;
  hd95Mm: number;
  meanSurfaceDistanceMm: number;
  note: string;
};

/**
 * Distances between boundary voxel centres. Because boundary voxels, not sub-voxel surfaces, are compared, values carry
 * a quantisation error of up to about one voxel.
 */
export function surfaceDistances(a: Mask, b: Mask): SurfaceDistances | null {
  if (!sameGrid(a, b)) return null;
  const pa = boundaryPoints(a);
  const pb = boundaryPoints(b);
  if (pa.length === 0 || pb.length === 0) return null;
  const ab = directed(pa, pb).sort((x, y) => x - y);
  const ba = directed(pb, pa).sort((x, y) => x - y);
  const all = ab.concat(ba);
  const mean = all.reduce((s, v) => s + v, 0) / all.length;
  return {
    hausdorffMm: Math.max(ab[ab.length - 1], ba[ba.length - 1]),
    hd95Mm: Math.max(percentile(ab, 95), percentile(ba, 95)),
    meanSurfaceDistanceMm: mean,
    note: "Boundary-voxel centre distances; quantisation error is up to about one voxel.",
  };
}

export type MaskMeasurement = {
  voxelCount: number;
  volumeMl: number;
  componentCount: number;
  largestComponentFraction: number;
  centroidMm: Vec3 | null;
  /** Extents along the three principal axes of the voxel cloud, longest first, mm (one voxel added per axis). */
  axesMm: Vec3 | null;
  longestMm: number | null;
  method: string;
};

function jacobiEigen3(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map((r) => r.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 3; q += 1) off += Math.abs(a[p][q]);
    if (off < 1e-12) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: [[v[0][0], v[1][0], v[2][0]], [v[0][1], v[1][1], v[2][1]], [v[0][2], v[1][2], v[2][2]]] };
}

export function measureMask(mask: Mask): MaskMeasurement {
  const count = maskVoxelCount(mask);
  const method = "principal-axis extents of voxel centres; not a clinician's caliper plane";
  if (count === 0) {
    return { voxelCount: 0, volumeMl: 0, componentCount: 0, largestComponentFraction: 0, centroidMm: null, axesMm: null, longestMm: null, method };
  }
  const { sizes } = labelComponents(mask);
  const pts: Vec3[] = [];
  const [nx, ny, nz] = mask.dims;
  let cx = 0, cy = 0, cz = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (!mask.data[vIndex(mask.dims, x, y, z)]) continue;
        const p: Vec3 = [x * mask.spacingMm[0], y * mask.spacingMm[1], z * mask.spacingMm[2]];
        pts.push(p);
        cx += p[0]; cy += p[1]; cz += p[2];
      }
    }
  }
  const c: Vec3 = [cx / count, cy / count, cz / count];
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i][j] += (d[i] * d[j]) / count;
  }
  const { vectors } = jacobiEigen3(cov);
  const extents = vectors.map((vec) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const t = (p[0] - c[0]) * vec[0] + (p[1] - c[1]) * vec[1] + (p[2] - c[2]) * vec[2];
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    // One mean voxel edge added: voxel centres span one voxel less than the object.
    const meanVoxel = (mask.spacingMm[0] + mask.spacingMm[1] + mask.spacingMm[2]) / 3;
    return hi - lo + meanVoxel;
  });
  extents.sort((a, b) => b - a);
  return {
    voxelCount: count,
    volumeMl: count * voxelVolumeMl(mask.spacingMm),
    componentCount: sizes.length,
    largestComponentFraction: Math.max(...sizes) / count,
    centroidMm: c,
    axesMm: [extents[0], extents[1], extents[2]],
    longestMm: extents[0],
    method,
  };
}
