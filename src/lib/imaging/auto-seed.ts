/**
 * Automatic seed for "auto-place seed at lesion": the interior of the brightest compact region, not the
 * single brightest voxel. A lone maximum usually sits on the noisy lesion edge, so the seed neighbourhood
 * straddles lesion and background, the estimated intensity window becomes very wide, and region growing
 * leaks into the whole volume. Classical heuristic only; a clinician still judges the outline.
 */
import type { Vec3, Volume } from "./volume.ts";

export function findLesionSeed(volume: Volume, opts: { margin?: number; interiorRadius?: number } = {}): Vec3 {
  const [dx, dy, dz] = volume.dims;
  const m = opts.margin ?? 0.1;
  const x0 = Math.floor(dx * m), x1 = Math.max(x0 + 1, Math.ceil(dx * (1 - m)));
  const y0 = Math.floor(dy * m), y1 = Math.max(y0 + 1, Math.ceil(dy * (1 - m)));
  const z0 = Math.floor(dz * m), z1 = Math.max(z0 + 1, Math.ceil(dz * (1 - m)));
  const at = (x: number, y: number, z: number) => volume.data[x + dx * (y + dy * z)];
  const centre: Vec3 = [Math.floor(dx / 2), Math.floor(dy / 2), Math.floor(dz / 2)];

  // Robust background (median) and bright level (99.5th percentile) from a strided sample of the box.
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(((x1 - x0) * (y1 - y0) * (z1 - z0)) / 200000));
  let n = 0;
  for (let z = z0; z < z1; z++)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) if (n++ % stride === 0) sample.push(at(x, y, z));
  if (sample.length === 0) return centre;
  sample.sort((a, b) => a - b);
  const bg = sample[Math.floor(sample.length * 0.5)];
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.995))];
  if (!(hi > bg)) return centre;
  const t = bg + 0.6 * (hi - bg);

  // Light 3x3x3 mean so single noisy voxels neither qualify nor disqualify.
  const smooth = (x: number, y: number, z: number) => {
    let s = 0, c = 0;
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const a = x + i, b = y + j, d = z + k;
          if (a < 0 || b < 0 || d < 0 || a >= dx || b >= dy || d >= dz) continue;
          s += at(a, b, d);
          c++;
        }
    return s / c;
  };

  let sx = 0, sy = 0, sz = 0, cnt = 0;
  const bright: Vec3[] = [];
  for (let z = z0; z < z1; z++)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        if (at(x, y, z) >= t && smooth(x, y, z) >= t) {
          bright.push([x, y, z]);
          sx += x; sy += y; sz += z; cnt++;
        }
  if (cnt === 0) return centre;
  const c: Vec3 = [sx / cnt, sy / cnt, sz / cnt];

  // Prefer voxels whose whole neighbourhood is bright (interior), closest to the bright centroid.
  const r = opts.interiorRadius ?? 2;
  const interior = (x: number, y: number, z: number) => {
    for (let k = -1; k <= 1; k++)
      for (let j = -r; j <= r; j++)
        for (let i = -r; i <= r; i++) {
          const a = x + i, b = y + j, d = z + k;
          if (a < 0 || b < 0 || d < 0 || a >= dx || b >= dy || d >= dz) return false;
          if (smooth(a, b, d) < t) return false;
        }
    return true;
  };
  const byDist = bright
    .map((v) => ({ v, d: (v[0] - c[0]) ** 2 + (v[1] - c[1]) ** 2 + (v[2] - c[2]) ** 2 }))
    .sort((a, b) => a.d - b.d);
  for (const { v } of byDist.slice(0, 5000)) if (interior(v[0], v[1], v[2])) return v;
  return byDist[0].v;
}
