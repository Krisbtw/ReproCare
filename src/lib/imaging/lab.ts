/**
 * Pure helpers behind the Volume Lab screen: plane extraction, windowing, mask overlay, histogram, cropped meshing,
 * and the exported processing record. No DOM and no parser, so everything here runs in Node tests.
 *
 * Plane conventions (display only; no anatomical orientation is claimed):
 *   axis 2 = the acquired slice plane. Pixel (col,row) is voxel (x=col, y=row).
 *   axis 1 = reformat at fixed row index y. Pixel (col,row) is voxel (x=col, z=nz-1-row), slice index increases upward.
 *   axis 0 = reformat at fixed column index x. Pixel (col,row) is voxel (y=col, z=nz-1-row), slice index increases upward.
 */
import type { Mask, Vec3, Volume } from "./volume.ts";
import { emptyMask, vIndex } from "./volume.ts";
import { surfaceFromMask, type Mesh } from "./isosurface.ts";
import { meshQuality, taubinSmooth, type MeshQuality } from "./mesh.ts";
import type { MaskMeasurement } from "./metrics.ts";
import type { SegmentResult } from "./segment.ts";
import type { SeriesReport } from "./series.ts";

export type Axis = 0 | 1 | 2;
export type DisplayWindow = { center: number; width: number };

export type SliceImage = {
  axis: Axis;
  index: number;
  width: number;
  height: number;
  data: Float32Array;
  /** Physical size of one displayed pixel along its columns and rows, mm. */
  mmPerPx: [number, number];
};

export function planeSize(dims: Vec3, axis: Axis): [number, number] {
  if (axis === 2) return [dims[0], dims[1]];
  if (axis === 1) return [dims[0], dims[2]];
  return [dims[1], dims[2]];
}

export function planeMmPerPx(spacingMm: Vec3, axis: Axis): [number, number] {
  if (axis === 2) return [spacingMm[0], spacingMm[1]];
  if (axis === 1) return [spacingMm[0], spacingMm[2]];
  return [spacingMm[1], spacingMm[2]];
}

/** Linear voxel index for a displayed pixel of the plane at `index` along `axis`. */
function sourceIndex(dims: Vec3, axis: Axis, index: number, col: number, row: number): number {
  if (axis === 2) return vIndex(dims, col, row, index);
  if (axis === 1) return vIndex(dims, col, index, dims[2] - 1 - row);
  return vIndex(dims, index, col, dims[2] - 1 - row);
}

export function clampIndex(dims: Vec3, axis: Axis, index: number): number {
  return Math.min(dims[axis] - 1, Math.max(0, Math.round(index)));
}

function pullPlane<T extends Float32Array | Uint8Array>(
  src: T,
  dims: Vec3,
  axis: Axis,
  index: number,
  make: (n: number) => T,
): { width: number; height: number; data: T } {
  const [width, height] = planeSize(dims, axis);
  const i = clampIndex(dims, axis, index);
  const data = make(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      data[row * width + col] = src[sourceIndex(dims, axis, i, col, row)];
    }
  }
  return { width, height, data };
}

export function extractSlice(volume: Volume, axis: Axis, index: number): SliceImage {
  const i = clampIndex(volume.dims, axis, index);
  const p = pullPlane(volume.data, volume.dims, axis, i, (n) => new Float32Array(n) as Float32Array);
  return { axis, index: i, width: p.width, height: p.height, data: p.data, mmPerPx: planeMmPerPx(volume.spacingMm, axis) };
}

export function extractMaskSlice(mask: Mask, axis: Axis, index: number): Uint8Array {
  return pullPlane(mask.data, mask.dims, axis, index, (n) => new Uint8Array(n) as Uint8Array).data;
}

/** Voxel under displayed pixel (col,row) of the plane at `index`. */
export function pixelToVoxel(dims: Vec3, axis: Axis, index: number, col: number, row: number): Vec3 {
  const i = clampIndex(dims, axis, index);
  if (axis === 2) return [col, row, i];
  if (axis === 1) return [col, i, dims[2] - 1 - row];
  return [i, col, dims[2] - 1 - row];
}

/** Displayed pixel of a voxel in a plane of the given axis (the slice index itself is voxel[axis]). */
export function voxelToPixel(dims: Vec3, axis: Axis, voxel: Vec3): { col: number; row: number } {
  if (axis === 2) return { col: voxel[0], row: voxel[1] };
  if (axis === 1) return { col: voxel[0], row: dims[2] - 1 - voxel[2] };
  return { col: voxel[1], row: dims[2] - 1 - voxel[2] };
}

export function voxelValue(volume: Volume, v: Vec3): number | null {
  const [nx, ny, nz] = volume.dims;
  if (v[0] < 0 || v[1] < 0 || v[2] < 0 || v[0] >= nx || v[1] >= ny || v[2] >= nz) return null;
  return volume.data[vIndex(volume.dims, v[0], v[1], v[2])];
}

function sampled(volume: Volume, maxSamples = 250_000): Float32Array {
  const n = volume.data.length;
  const stride = Math.max(1, Math.floor(n / maxSamples));
  const out = new Float32Array(Math.ceil(n / stride));
  let k = 0;
  for (let i = 0; i < n; i += stride) out[k++] = volume.data[i];
  return out.subarray(0, k);
}

function percentile(sortedAsc: Float32Array, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = Math.min(sortedAsc.length - 1, Math.max(0, (p / 100) * (sortedAsc.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/** Display window from intensity percentiles. Display only; it never feeds segmentation. */
export function autoWindow(volume: Volume, lowPct = 1, highPct = 99.5): DisplayWindow & { min: number; max: number } {
  const s = sampled(volume).slice().sort();
  const lo = percentile(s, lowPct);
  const hi = percentile(s, highPct);
  const width = Math.max(1e-6, hi - lo);
  return { center: lo + width / 2, width, min: s.length ? s[0] : 0, max: s.length ? s[s.length - 1] : 0 };
}

export type Histogram = { counts: number[]; lo: number; hi: number; binWidth: number };

/** Intensity histogram over [0.1th, 99.9th] percentile; values beyond fall into the end bins. */
export function histogram(volume: Volume, bins = 96): Histogram {
  const s = sampled(volume).slice().sort();
  const lo = percentile(s, 0.1);
  let hi = percentile(s, 99.9);
  if (hi <= lo) hi = lo + 1;
  const counts = new Array<number>(bins).fill(0);
  const binWidth = (hi - lo) / bins;
  for (let i = 0; i < s.length; i += 1) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((s[i] - lo) / binWidth)));
    counts[b] += 1;
  }
  return { counts, lo, hi, binWidth };
}

export type Overlay = { r: number; g: number; b: number; alpha: number };

/** Grayscale RGBA for one slice with an optional mask tint. `maskSlice` must be the same plane as `slice`. */
export function renderSlice(slice: SliceImage, win: DisplayWindow, maskSlice?: Uint8Array | null, overlay?: Overlay): Uint8ClampedArray<ArrayBuffer> {
  const n = slice.width * slice.height;
  const out = new Uint8ClampedArray(n * 4);
  const lo = win.center - win.width / 2;
  const inv = 255 / Math.max(1e-9, win.width);
  const a = overlay?.alpha ?? 0;
  for (let i = 0; i < n; i += 1) {
    let g = (slice.data[i] - lo) * inv;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    let r = g, gg = g, b = g;
    if (maskSlice && overlay && maskSlice[i]) {
      r = r * (1 - a) + overlay.r * a;
      gg = gg * (1 - a) + overlay.g * a;
      b = b * (1 - a) + overlay.b * a;
    }
    const o = i * 4;
    out[o] = r;
    out[o + 1] = gg;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
  return out;
}

/** Number of mask voxels on each slice along an axis (for a "where is the mask" strip). */
export function maskCountsAlong(mask: Mask, axis: Axis): number[] {
  const out = new Array<number>(mask.dims[axis]).fill(0);
  const [nx, ny, nz] = mask.dims;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (mask.data[vIndex(mask.dims, x, y, z)]) out[axis === 0 ? x : axis === 1 ? y : z] += 1;
      }
    }
  }
  return out;
}

/** Smallest box holding every mask voxel, grown by `margin` voxels and clamped to the grid. Null for an empty mask. */
export function cropToBoundingBox(mask: Mask, margin: number): { mask: Mask; originVoxels: Vec3 } | null {
  const [nx, ny, nz] = mask.dims;
  const lo: Vec3 = [nx, ny, nz];
  const hi: Vec3 = [-1, -1, -1];
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (!mask.data[vIndex(mask.dims, x, y, z)]) continue;
        if (x < lo[0]) lo[0] = x;
        if (y < lo[1]) lo[1] = y;
        if (z < lo[2]) lo[2] = z;
        if (x > hi[0]) hi[0] = x;
        if (y > hi[1]) hi[1] = y;
        if (z > hi[2]) hi[2] = z;
      }
    }
  }
  if (hi[0] < 0) return null;
  const a: Vec3 = [Math.max(0, lo[0] - margin), Math.max(0, lo[1] - margin), Math.max(0, lo[2] - margin)];
  const b: Vec3 = [Math.min(nx - 1, hi[0] + margin), Math.min(ny - 1, hi[1] + margin), Math.min(nz - 1, hi[2] + margin)];
  const dims: Vec3 = [b[0] - a[0] + 1, b[1] - a[1] + 1, b[2] - a[2] + 1];
  const out = emptyMask(dims, mask.spacingMm, mask.geometry);
  for (let z = 0; z < dims[2]; z += 1) {
    for (let y = 0; y < dims[1]; y += 1) {
      for (let x = 0; x < dims[0]; x += 1) {
        out.data[vIndex(dims, x, y, z)] = mask.data[vIndex(mask.dims, x + a[0], y + a[1], z + a[2])];
      }
    }
  }
  return { mask: out, originVoxels: a };
}

export type MeshOptions = { blurIterations?: number; taubinIterations?: number };

/**
 * Surface of a mask in image-index millimetres. The mask is cropped to its bounding box first, because blurring and
 * scanning the whole grid dominates the cost on a typical MRI matrix. The margin exceeds the blur radius, so the result
 * is identical to meshing the full grid.
 */
export function meshFromMask(mask: Mask, opts: MeshOptions = {}): { mesh: Mesh; quality: MeshQuality; blurIterations: number; taubinIterations: number } | null {
  const blur = opts.blurIterations ?? 1;
  const taubin = opts.taubinIterations ?? 0;
  const crop = cropToBoundingBox(mask, blur + 2);
  if (!crop) return null;
  let mesh = surfaceFromMask(crop.mask, blur);
  const [ox, oy, oz] = [crop.originVoxels[0] * mask.spacingMm[0], crop.originVoxels[1] * mask.spacingMm[1], crop.originVoxels[2] * mask.spacingMm[2]];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] += ox;
    mesh.positions[i + 1] += oy;
    mesh.positions[i + 2] += oz;
  }
  if (taubin > 0 && mesh.indices.length > 0) mesh = taubinSmooth(mesh, taubin);
  if (mask.geometry) mesh.geometry = mask.geometry;
  return { mesh, quality: meshQuality(mesh), blurIterations: blur, taubinIterations: taubin };
}

export type ProcessingRecord = ReturnType<typeof buildProcessingRecord>;

/**
 * Provenance for one segmentation, as plain JSON. It deliberately omits file names (slice ids), patient identifiers
 * and any pixel data. It states what the segmenter is and is not.
 */
export function buildProcessingRecord(input: {
  now: Date;
  modality: string | null;
  seriesDescription: string | null;
  calibrated: boolean;
  report: SeriesReport;
  volume: Volume;
  skippedFileCount: number;
  seed: Vec3;
  seedValue: number | null;
  result: SegmentResult;
  measurement: MaskMeasurement;
  mesh: { quality: MeshQuality; blurIterations: number; taubinIterations: number } | null;
}) {
  return {
    kind: "anatomybridge.volume-lab.processing-record",
    version: 1,
    createdAt: input.now.toISOString(),
    notice:
      "Classical seeded region growing chosen and placed by a person. It is not a trained model, has no anatomical knowledge, and is not clinically validated. Mesh coordinates are image-index millimetres, not patient coordinates.",
    source: {
      modality: input.modality,
      seriesDescription: input.seriesDescription,
      sliceCount: input.report.orderedIds.length,
      dims: input.volume.dims,
      voxelSpacingMm: input.volume.spacingMm,
      intensitiesCalibrated: input.calibrated,
      skippedFileCount: input.skippedFileCount,
      seriesIssues: input.report.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
    },
    segmentation: {
      segmenter: input.result.segmenter,
      isLearnedModel: input.result.isLearnedModel,
      accepted: input.result.accepted,
      seedVoxel: input.seed,
      seedIntensity: input.seedValue,
      intensityWindow: input.result.window,
      voxelCount: input.result.voxelCount,
      volumeMl: input.result.volumeMl,
      steps: input.result.steps,
      warnings: input.result.warnings,
    },
    measurement: input.measurement,
    mesh: input.mesh,
  };
}

