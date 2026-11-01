/**
 * Classical, non-learned segmentation: seeded region growing inside an intensity window, then cleanup.
 * This is NOT a trained model and has no anatomical knowledge. A clinician-placed seed decides what is segmented.
 * Every call returns the parameters and steps it used so the result carries its own processing history.
 */
import type { Mask, Vec3, Volume } from "./volume.ts";
import { NEIGHBORS_6, emptyMask, inBounds, maskVoxelCount, vIndex, voxelVolumeMl } from "./volume.ts";

export const SEGMENTER_ID = "classical-region-growing-v1";

export type Window = { lower: number; upper: number };

export type SegmentOptions = {
  seed: Vec3;
  /** Explicit intensity window. When absent it is estimated from the seed neighbourhood. */
  window?: Window;
  seedRadiusVoxels?: number;
  kSigma?: number;
  /** Closing radius in voxels (6-connected iterations). 0 disables. */
  closeIterations?: number;
  openIterations?: number;
  /** Refuse results larger than this fraction of the volume: that is leakage, not a lesion. */
  maxFractionOfVolume?: number;
};

export type SegmentResult = {
  segmenter: string;
  isLearnedModel: boolean;
  mask: Mask;
  window: Window;
  voxelCount: number;
  volumeMl: number;
  steps: string[];
  warnings: string[];
  accepted: boolean;
  note?: string;
};

export function windowFromSeed(volume: Volume, seed: Vec3, radius = 2, kSigma = 2.5): Window & { mean: number; sd: number; n: number } {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = seed[0] + dx;
        const y = seed[1] + dy;
        const z = seed[2] + dz;
        if (!inBounds(volume.dims, x, y, z)) continue;
        const v = volume.data[vIndex(volume.dims, x, y, z)];
        sum += v;
        sum2 += v * v;
        n += 1;
      }
    }
  }
  if (n === 0) throw new Error("Seed is outside the volume.");
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return { lower: mean - kSigma * sd, upper: mean + kSigma * sd, mean, sd, n };
}

export function regionGrow(volume: Volume, seed: Vec3, win: Window): Mask {
  const mask = emptyMask(volume.dims, volume.spacingMm);
  if (!inBounds(volume.dims, seed[0], seed[1], seed[2])) throw new Error("Seed is outside the volume.");
  const start = vIndex(volume.dims, seed[0], seed[1], seed[2]);
  const sv = volume.data[start];
  if (sv < win.lower || sv > win.upper) return mask;
  const [nx, ny] = volume.dims;
  const stack: number[] = [start];
  mask.data[start] = 1;
  while (stack.length) {
    const cur = stack.pop() as number;
    const z = Math.floor(cur / (nx * ny));
    const rem = cur - z * nx * ny;
    const y = Math.floor(rem / nx);
    const x = rem - y * nx;
    for (const [dx, dy, dz] of NEIGHBORS_6) {
      const xx = x + dx;
      const yy = y + dy;
      const zz = z + dz;
      if (!inBounds(volume.dims, xx, yy, zz)) continue;
      const j = vIndex(volume.dims, xx, yy, zz);
      if (mask.data[j]) continue;
      const v = volume.data[j];
      if (v < win.lower || v > win.upper) continue;
      mask.data[j] = 1;
      stack.push(j);
    }
  }
  return mask;
}

export function dilate(mask: Mask, iterations = 1): Mask {
  let cur = mask;
  for (let it = 0; it < iterations; it += 1) {
    const out = emptyMask(cur.dims, cur.spacingMm);
    for (let z = 0; z < cur.dims[2]; z += 1) {
      for (let y = 0; y < cur.dims[1]; y += 1) {
        for (let x = 0; x < cur.dims[0]; x += 1) {
          const i = vIndex(cur.dims, x, y, z);
          if (cur.data[i]) {
            out.data[i] = 1;
            continue;
          }
          for (const [dx, dy, dz] of NEIGHBORS_6) {
            if (inBounds(cur.dims, x + dx, y + dy, z + dz) && cur.data[vIndex(cur.dims, x + dx, y + dy, z + dz)]) {
              out.data[i] = 1;
              break;
            }
          }
        }
      }
    }
    cur = out;
  }
  return cur;
}

export function erode(mask: Mask, iterations = 1): Mask {
  let cur = mask;
  for (let it = 0; it < iterations; it += 1) {
    const out = emptyMask(cur.dims, cur.spacingMm);
    for (let z = 0; z < cur.dims[2]; z += 1) {
      for (let y = 0; y < cur.dims[1]; y += 1) {
        for (let x = 0; x < cur.dims[0]; x += 1) {
          const i = vIndex(cur.dims, x, y, z);
          if (!cur.data[i]) continue;
          let keep = 1;
          for (const [dx, dy, dz] of NEIGHBORS_6) {
            // Outside the grid counts as background, so objects touching the border erode there.
            if (!inBounds(cur.dims, x + dx, y + dy, z + dz) || !cur.data[vIndex(cur.dims, x + dx, y + dy, z + dz)]) {
              keep = 0;
              break;
            }
          }
          out.data[i] = keep;
        }
      }
    }
    cur = out;
  }
  return cur;
}

export type Components = { labels: Int32Array; sizes: number[] };

/** 6-connected component labelling on any grid. Labels start at 1; sizes[k-1] is the voxel count of label k. */
export function labelComponents(mask: Mask): Components {
  const labels = new Int32Array(mask.data.length);
  const sizes: number[] = [];
  const [nx, ny] = mask.dims;
  const stack: number[] = [];
  for (let i = 0; i < mask.data.length; i += 1) {
    if (!mask.data[i] || labels[i]) continue;
    const label = sizes.length + 1;
    let count = 0;
    labels[i] = label;
    stack.push(i);
    while (stack.length) {
      const cur = stack.pop() as number;
      count += 1;
      const z = Math.floor(cur / (nx * ny));
      const rem = cur - z * nx * ny;
      const y = Math.floor(rem / nx);
      const x = rem - y * nx;
      for (const [dx, dy, dz] of NEIGHBORS_6) {
        const xx = x + dx;
        const yy = y + dy;
        const zz = z + dz;
        if (!inBounds(mask.dims, xx, yy, zz)) continue;
        const j = vIndex(mask.dims, xx, yy, zz);
        if (!mask.data[j] || labels[j]) continue;
        labels[j] = label;
        stack.push(j);
      }
    }
    sizes.push(count);
  }
  return { labels, sizes };
}

export function keepLargestComponent(mask: Mask): Mask {
  const { labels, sizes } = labelComponents(mask);
  if (sizes.length <= 1) return mask;
  let best = 1;
  for (let k = 2; k <= sizes.length; k += 1) if (sizes[k - 1] > sizes[best - 1]) best = k;
  const out = emptyMask(mask.dims, mask.spacingMm);
  for (let i = 0; i < labels.length; i += 1) if (labels[i] === best) out.data[i] = 1;
  return out;
}

export function segmentFromSeed(volume: Volume, opts: SegmentOptions): SegmentResult {
  const steps: string[] = [];
  const warnings: string[] = [];
  const radius = opts.seedRadiusVoxels ?? 2;
  const k = opts.kSigma ?? 2.5;
  let win: Window;
  if (opts.window) {
    win = opts.window;
    steps.push(`intensity window supplied by user: ${win.lower.toFixed(1)} to ${win.upper.toFixed(1)}`);
  } else {
    const est = windowFromSeed(volume, opts.seed, radius, k);
    win = { lower: est.lower, upper: est.upper };
    steps.push(
      `intensity window from ${est.n} voxels around the seed: mean ${est.mean.toFixed(1)}, sd ${est.sd.toFixed(1)}, ±${k} sd → ${win.lower.toFixed(1)} to ${win.upper.toFixed(1)}`,
    );
    if (est.sd === 0) warnings.push("Seed neighbourhood has zero variance, so the window is a single value. Supply a window.");
  }
  let mask = regionGrow(volume, opts.seed, win);
  steps.push(`seeded 6-connected region growing from voxel (${opts.seed.join(", ")}): ${maskVoxelCount(mask)} voxels`);
  const closeN = opts.closeIterations ?? 1;
  const openN = opts.openIterations ?? 0;
  if (closeN > 0) {
    mask = erode(dilate(mask, closeN), closeN);
    steps.push(`morphological closing × ${closeN} (6-connected)`);
  }
  if (openN > 0) {
    mask = dilate(erode(mask, openN), openN);
    steps.push(`morphological opening × ${openN} (6-connected)`);
  }
  mask = keepLargestComponent(mask);
  steps.push("kept largest connected component");
  const count = maskVoxelCount(mask);
  const fraction = count / mask.data.length;
  const limit = opts.maxFractionOfVolume ?? 0.5;
  let accepted = count > 0;
  if (count === 0) warnings.push("Nothing was segmented. The seed may lie outside the chosen window.");
  if (fraction > limit) {
    accepted = false;
    warnings.push(
      `Region covers ${(fraction * 100).toFixed(0)}% of the volume. That is leakage into surrounding tissue, so the result is marked not accepted.`,
    );
  }
  if (count > 0 && count < 20) warnings.push("Fewer than 20 voxels were segmented. Measurements from this are unreliable.");
  return {
    segmenter: SEGMENTER_ID,
    isLearnedModel: false,
    mask,
    window: win,
    voxelCount: count,
    volumeMl: count * voxelVolumeMl(volume.spacingMm),
    steps,
    warnings,
    accepted,
  };
}
