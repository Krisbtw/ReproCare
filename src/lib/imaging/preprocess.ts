/**
 * Preprocessing with provenance. Every function returns a NEW volume plus an operation record; the input volume
 * is never modified, so the original scan stays available for display and re-processing.
 *
 * Implemented (all classical, deterministic):
 *   - percentile clip + rescale to [0, 1]           normalisePercentile
 *   - z-score normalisation (optionally inside a mask) normaliseZScore
 *   - separable Gaussian smoothing in millimetres    gaussianSmooth
 *   - 3x3x3 median filter                            medianFilter
 *   - trilinear resampling to a target spacing       resampleVolume
 *   - nearest-neighbour resampling for label masks   resampleMask
 *   - crop to a voxel box / around a mask            cropVolume, cropAroundMask
 *   - simple image-quality indicators                qualityIndicators
 *
 * Not implemented: bias-field (N4) correction, anisotropic diffusion, deformable resampling.
 */
import type { Mask, Vec3, Volume } from "./volume.ts";
import { vIndex } from "./volume.ts";

export type OpRecord = {
  op: string;
  params: Record<string, number | string | boolean | number[]>;
  inputDims: Vec3;
  inputSpacingMm: Vec3;
  outputDims: Vec3;
  outputSpacingMm: Vec3;
  note: string;
};

export type Processed = { volume: Volume; record: OpRecord };

function rec(op: string, params: OpRecord["params"], input: Volume | Mask, output: Volume | Mask, note: string): OpRecord {
  return {
    op,
    params,
    inputDims: [...input.dims] as Vec3,
    inputSpacingMm: [...input.spacingMm] as Vec3,
    outputDims: [...output.dims] as Vec3,
    outputSpacingMm: [...output.spacingMm] as Vec3,
    note,
  };
}

/** Percentile of the data (linear interpolation between order statistics). Copies; does not sort in place. */
export function percentile(data: Float32Array, p: number): number {
  if (data.length === 0) return NaN;
  const sorted = Float32Array.from(data).sort();
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function normalisePercentile(volume: Volume, lowPct = 0.5, highPct = 99.5): Processed {
  const lo = percentile(volume.data, lowPct);
  const hi = percentile(volume.data, highPct);
  const out = new Float32Array(volume.data.length);
  const span = hi - lo;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = span > 0 ? Math.min(1, Math.max(0, (volume.data[i] - lo) / span)) : 0;
  }
  const v: Volume = { dims: volume.dims, spacingMm: volume.spacingMm, data: out, ...(volume.geometry ? { geometry: volume.geometry } : {}) };
  return {
    volume: v,
    record: rec("normalise_percentile", { lowPct, highPct, low: lo, high: hi }, volume, v, span > 0 ? "Clipped to the percentile range and rescaled to 0–1." : "Flat volume: output set to 0."),
  };
}

export function normaliseZScore(volume: Volume, mask?: Mask): Processed {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let i = 0; i < volume.data.length; i += 1) {
    if (mask && !mask.data[i]) continue;
    const x = volume.data[i];
    sum += x;
    sum2 += x * x;
    n += 1;
  }
  const mean = n ? sum / n : 0;
  const sd = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
  const out = new Float32Array(volume.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = sd > 0 ? (volume.data[i] - mean) / sd : 0;
  const v: Volume = { dims: volume.dims, spacingMm: volume.spacingMm, data: out, ...(volume.geometry ? { geometry: volume.geometry } : {}) };
  return { volume: v, record: rec("normalise_zscore", { mean, sd, maskVoxels: n, masked: Boolean(mask) }, volume, v, sd > 0 ? "Mean 0, SD 1." : "Zero variance: output set to 0.") };
}

function kernel1d(sigmaVoxels: number): Float32Array {
  if (sigmaVoxels <= 0) return Float32Array.of(1);
  const r = Math.max(1, Math.ceil(3 * sigmaVoxels));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i += 1) {
    const w = Math.exp(-(i * i) / (2 * sigmaVoxels * sigmaVoxels));
    k[i + r] = w;
    sum += w;
  }
  for (let i = 0; i < k.length; i += 1) k[i] /= sum;
  return k;
}

function convolveAxis(src: Float32Array, dims: Vec3, axis: 0 | 1 | 2, k: Float32Array): Float32Array {
  if (k.length === 1) return src.slice();
  const out = new Float32Array(src.length);
  const r = (k.length - 1) / 2;
  const [nx, ny, nz] = dims;
  const n = dims[axis];
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const c = axis === 0 ? x : axis === 1 ? y : z;
        let acc = 0;
        for (let t = -r; t <= r; t += 1) {
          // Edge handling: clamp (replicate border).
          const p = Math.min(n - 1, Math.max(0, c + t));
          const xi = axis === 0 ? p : x;
          const yi = axis === 1 ? p : y;
          const zi = axis === 2 ? p : z;
          acc += src[xi + nx * (yi + ny * zi)] * k[t + r];
        }
        out[x + nx * (y + ny * z)] = acc;
      }
    }
  }
  return out;
}

/** Separable Gaussian with sigma given in millimetres, so anisotropic voxels are smoothed by the same physical amount. */
export function gaussianSmooth(volume: Volume, sigmaMm: number): Processed {
  let data = volume.data;
  const sig: Vec3 = [sigmaMm / volume.spacingMm[0], sigmaMm / volume.spacingMm[1], sigmaMm / volume.spacingMm[2]];
  for (const axis of [0, 1, 2] as const) data = convolveAxis(data, volume.dims, axis, kernel1d(sig[axis]));
  const v: Volume = { dims: volume.dims, spacingMm: volume.spacingMm, data: data === volume.data ? volume.data.slice() : data };
  return {
    volume: v,
    record: rec("gaussian_smooth", { sigmaMm, sigmaVoxels: sig.map((x) => Number(x.toFixed(3))) }, volume, v, "Separable Gaussian, border replicated. Blurs edges as well as noise."),
  };
}

/** 3x3x3 median (26-neighbourhood plus centre), border voxels use the in-bounds neighbours only. */
export function medianFilter(volume: Volume): Processed {
  const [nx, ny, nz] = volume.dims;
  const out = new Float32Array(volume.data.length);
  const buf = new Float32Array(27);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        let n = 0;
        for (let dz = -1; dz <= 1; dz += 1) {
          const zz = z + dz;
          if (zz < 0 || zz >= nz) continue;
          for (let dy = -1; dy <= 1; dy += 1) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) continue;
            for (let dx = -1; dx <= 1; dx += 1) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx) continue;
              buf[n] = volume.data[xx + nx * (yy + ny * zz)];
              n += 1;
            }
          }
        }
        const w = buf.subarray(0, n).sort();
        out[x + nx * (y + ny * z)] = n % 2 ? w[(n - 1) / 2] : (w[n / 2 - 1] + w[n / 2]) / 2;
      }
    }
  }
  const v: Volume = { dims: volume.dims, spacingMm: volume.spacingMm, data: out, ...(volume.geometry ? { geometry: volume.geometry } : {}) };
  return { volume: v, record: rec("median_3x3x3", {}, volume, v, "Edge-preserving for isolated noise; can remove structures thinner than one voxel.") };
}

/** Trilinear sample at continuous voxel coordinates. Outside the grid returns `outside`. */
export function sampleTrilinear(volume: Volume, x: number, y: number, z: number, outside = 0): number {
  const [nx, ny, nz] = volume.dims;
  if (x < 0 || y < 0 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) return outside;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = Math.min(nx - 1, x0 + 1);
  const y1 = Math.min(ny - 1, y0 + 1);
  const z1 = Math.min(nz - 1, z0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const d = volume.data;
  const at = (a: number, b: number, c: number) => d[a + nx * (b + ny * c)];
  const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
  const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
  const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
  const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

function resampledDims(dims: Vec3, spacing: Vec3, target: Vec3): Vec3 {
  return [0, 1, 2].map((a) => Math.max(1, Math.floor(((dims[a] - 1) * spacing[a]) / target[a]) + 1)) as Vec3;
}

export const MAX_RESAMPLED_VOXELS = 24_000_000;

/** Trilinear resampling onto a grid with the same physical origin (voxel 0 centre) and the target spacing. */
export function resampleVolume(volume: Volume, targetSpacingMm: Vec3): Processed {
  if (targetSpacingMm.some((s) => !(s > 0))) throw new Error("Target spacing must be positive.");
  const dims = resampledDims(volume.dims, volume.spacingMm, targetSpacingMm);
  if (dims[0] * dims[1] * dims[2] > MAX_RESAMPLED_VOXELS) throw new Error("Resampled volume would be too large for this browser.");
  const out = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z += 1) {
    const sz = (z * targetSpacingMm[2]) / volume.spacingMm[2];
    for (let y = 0; y < dims[1]; y += 1) {
      const sy = (y * targetSpacingMm[1]) / volume.spacingMm[1];
      for (let x = 0; x < dims[0]; x += 1) {
        out[x + dims[0] * (y + dims[1] * z)] = sampleTrilinear(volume, (x * targetSpacingMm[0]) / volume.spacingMm[0], sy, sz);
      }
    }
  }
  const v: Volume = { dims, spacingMm: [...targetSpacingMm] as Vec3, data: out };
  return {
    volume: v,
    record: rec("resample_trilinear", { targetSpacingMm: [...targetSpacingMm] }, volume, v, "Trilinear interpolation. Upsampling thick slices interpolates between them; it does not recover detail that was not acquired."),
  };
}

/** Nearest-neighbour resampling for label masks, so labels are never blended. */
export function resampleMask(mask: Mask, targetSpacingMm: Vec3): { mask: Mask; record: OpRecord } {
  const dims = resampledDims(mask.dims, mask.spacingMm, targetSpacingMm);
  const out = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z += 1) {
    const sz = Math.min(mask.dims[2] - 1, Math.round((z * targetSpacingMm[2]) / mask.spacingMm[2]));
    for (let y = 0; y < dims[1]; y += 1) {
      const sy = Math.min(mask.dims[1] - 1, Math.round((y * targetSpacingMm[1]) / mask.spacingMm[1]));
      for (let x = 0; x < dims[0]; x += 1) {
        const sx = Math.min(mask.dims[0] - 1, Math.round((x * targetSpacingMm[0]) / mask.spacingMm[0]));
        out[x + dims[0] * (y + dims[1] * z)] = mask.data[vIndex(mask.dims, sx, sy, sz)];
      }
    }
  }
  const m: Mask = { dims, spacingMm: [...targetSpacingMm] as Vec3, data: out };
  return { mask: m, record: rec("resample_nearest_mask", { targetSpacingMm: [...targetSpacingMm] }, mask, m, "Nearest neighbour; labels are not blended.") };
}

export function cropVolume(volume: Volume, lo: Vec3, hi: Vec3): Processed & { originVoxels: Vec3 } {
  const a = lo.map((v, i) => Math.max(0, Math.min(volume.dims[i] - 1, Math.floor(v)))) as Vec3;
  const b = hi.map((v, i) => Math.max(a[i], Math.min(volume.dims[i] - 1, Math.floor(v)))) as Vec3;
  const dims: Vec3 = [b[0] - a[0] + 1, b[1] - a[1] + 1, b[2] - a[2] + 1];
  const out = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z += 1)
    for (let y = 0; y < dims[1]; y += 1)
      for (let x = 0; x < dims[0]; x += 1) out[x + dims[0] * (y + dims[1] * z)] = volume.data[vIndex(volume.dims, x + a[0], y + a[1], z + a[2])];
  const v: Volume = { dims, spacingMm: volume.spacingMm, data: out };
  return { volume: v, originVoxels: a, record: rec("crop", { lo: a, hi: b }, volume, v, "Region of interest. Voxel (0,0,0) of the output is the input voxel 'lo'.") };
}

export function cropAroundMask(volume: Volume, mask: Mask, marginMm: number): (Processed & { originVoxels: Vec3 }) | null {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const [nx, ny, nz] = mask.dims;
  for (let z = 0; z < nz; z += 1)
    for (let y = 0; y < ny; y += 1)
      for (let x = 0; x < nx; x += 1) {
        if (!mask.data[x + nx * (y + ny * z)]) continue;
        const p = [x, y, z];
        for (let i = 0; i < 3; i += 1) {
          lo[i] = Math.min(lo[i], p[i]);
          hi[i] = Math.max(hi[i], p[i]);
        }
      }
  if (!Number.isFinite(lo[0])) return null;
  const m = volume.spacingMm.map((s) => Math.ceil(marginMm / s));
  return cropVolume(volume, [lo[0] - m[0], lo[1] - m[1], lo[2] - m[2]], [hi[0] + m[0], hi[1] + m[1], hi[2] + m[2]]);
}

export type QualityIndicators = {
  /** Robust noise estimate: median absolute deviation of first differences along x, scaled to SD (MAD*1.4826/sqrt(2)). */
  noiseSd: number;
  /** 99th-1st percentile range divided by the noise estimate. A rough contrast-to-noise indicator, not a clinical SNR. */
  dynamicRangeToNoise: number | null;
  /** Through-plane spacing divided by the finer in-plane spacing. Above about 3, reformats and small-lesion measurements are unreliable. */
  anisotropy: number;
  flags: string[];
};

export function qualityIndicators(volume: Volume): QualityIndicators {
  const [nx, ny, nz] = volume.dims;
  const diffs: number[] = [];
  const stride = Math.max(1, Math.floor((nx * ny * nz) / 200_000));
  let i = 0;
  for (let z = 0; z < nz; z += 1)
    for (let y = 0; y < ny; y += 1)
      for (let x = 0; x + 1 < nx; x += 1) {
        i += 1;
        if (i % stride) continue;
        const a = volume.data[x + nx * (y + ny * z)];
        const b = volume.data[x + 1 + nx * (y + ny * z)];
        diffs.push(Math.abs(a - b));
      }
  diffs.sort((p, q) => p - q);
  const mad = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
  const noiseSd = (mad * 1.4826) / Math.SQRT2;
  const range = percentile(volume.data, 99) - percentile(volume.data, 1);
  const anisotropy = volume.spacingMm[2] / Math.min(volume.spacingMm[0], volume.spacingMm[1]);
  const flags: string[] = [];
  if (anisotropy > 3) flags.push(`Slices are ${anisotropy.toFixed(1)}× thicker than the in-plane pixels; through-plane measurements and reformats are coarse.`);
  const drn = noiseSd > 0 ? range / noiseSd : null;
  if (drn != null && drn < 5) flags.push("Intensity range is small relative to the noise estimate; boundaries may be unreliable.");
  if (nz < 8) flags.push("Fewer than 8 slices; 3D measurements are coarse.");
  return { noiseSd, dynamicRangeToNoise: drn, anisotropy, flags };
}
