/**
 * Marching tetrahedra isosurface on an anisotropic grid.
 * Chosen over a 256-case Marching Cubes table because the Kuhn six-tetrahedra split is face-consistent between
 * neighbouring cells, so closed objects come out watertight without ambiguous-case patches. Triangles are oriented
 * so normals point out of the region where value > iso.
 */
import type { Mask, Vec3, Volume } from "./volume.ts";
import { vIndex } from "./volume.ts";

export type Mesh = {
  /** x,y,z in millimetres in image-index space (voxel index × spacing). */
  positions: Float32Array;
  indices: Uint32Array;
};

const CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

// Kuhn / Freudenthal triangulation: six tetrahedra along the 0→6 diagonal.
const TETS: [number, number, number, number][] = [
  [0, 1, 2, 6],
  [0, 1, 5, 6],
  [0, 3, 2, 6],
  [0, 3, 7, 6],
  [0, 4, 5, 6],
  [0, 4, 7, 6],
];

export function boxBlur(volume: Volume, iterations: number): Volume {
  let src = volume.data;
  const [nx, ny, nz] = volume.dims;
  for (let it = 0; it < iterations; it += 1) {
    const dst = new Float32Array(src.length);
    for (let z = 0; z < nz; z += 1) {
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          let sum = 0;
          for (let dz = -1; dz <= 1; dz += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                const xx = Math.min(nx - 1, Math.max(0, x + dx));
                const yy = Math.min(ny - 1, Math.max(0, y + dy));
                const zz = Math.min(nz - 1, Math.max(0, z + dz));
                sum += src[vIndex(volume.dims, xx, yy, zz)];
              }
            }
          }
          dst[vIndex(volume.dims, x, y, z)] = sum / 27;
        }
      }
    }
    src = dst;
  }
  return { dims: volume.dims, spacingMm: volume.spacingMm, data: src };
}

/** Pads a mask with one empty voxel on every side so surfaces close at the grid boundary. */
export function padMask(mask: Mask): { volume: Volume; offsetVoxels: Vec3 } {
  const [nx, ny, nz] = mask.dims;
  const dims: Vec3 = [nx + 2, ny + 2, nz + 2];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (mask.data[vIndex(mask.dims, x, y, z)]) data[vIndex(dims, x + 1, y + 1, z + 1)] = 1;
      }
    }
  }
  return { volume: { dims, spacingMm: mask.spacingMm, data }, offsetVoxels: [1, 1, 1] };
}

export function extractIsosurface(volume: Volume, iso: number): Mesh {
  const { dims, spacingMm, data } = volume;
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const positions: number[] = [];
  const indices: number[] = [];
  const edgeVertex = new Map<number, number>();

  const gridPos = (gi: number): Vec3 => {
    const z = Math.floor(gi / (nx * ny));
    const rem = gi - z * nx * ny;
    const y = Math.floor(rem / nx);
    const x = rem - y * nx;
    return [x * spacingMm[0], y * spacingMm[1], z * spacingMm[2]];
  };

  const vertexOnEdge = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * total + hi;
    const hit = edgeVertex.get(key);
    if (hit !== undefined) return hit;
    const va = data[lo];
    const vb = data[hi];
    const t = (iso - va) / (vb - va);
    const pa = gridPos(lo);
    const pb = gridPos(hi);
    const id = positions.length / 3;
    positions.push(pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1]), pa[2] + t * (pb[2] - pa[2]));
    edgeVertex.set(key, id);
    return id;
  };

  const P = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];

  const emit = (a: number, b: number, c: number, awayFrom: Vec3 | null, toward: Vec3 | null) => {
    const pa = P(a);
    const pb = P(b);
    const pc = P(c);
    const u: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const v: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const cen: Vec3 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
    let ref: Vec3;
    if (awayFrom) ref = [cen[0] - awayFrom[0], cen[1] - awayFrom[1], cen[2] - awayFrom[2]];
    else ref = [(toward as Vec3)[0] - cen[0], (toward as Vec3)[1] - cen[1], (toward as Vec3)[2] - cen[2]];
    const flip = n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0;
    if (flip) indices.push(a, c, b);
    else indices.push(a, b, c);
  };

  for (let z = 0; z < nz - 1; z += 1) {
    for (let y = 0; y < ny - 1; y += 1) {
      for (let x = 0; x < nx - 1; x += 1) {
        const g = CORNERS.map(([cx, cy, cz]) => vIndex(dims, x + cx, y + cy, z + cz));
        const val = g.map((i) => data[i]);
        let any = false;
        let all = true;
        for (const v of val) {
          if (v > iso) any = true;
          else all = false;
        }
        if (!any || all) continue;
        for (const tet of TETS) {
          const ids = tet.map((k) => g[k]);
          const inside = tet.map((k) => val[k] > iso);
          const nIn = inside.filter(Boolean).length;
          if (nIn === 0 || nIn === 4) continue;
          const ins = ids.filter((_, i) => inside[i]);
          const outs = ids.filter((_, i) => !inside[i]);
          if (nIn === 1) {
            const a = vertexOnEdge(ins[0], outs[0]);
            const b = vertexOnEdge(ins[0], outs[1]);
            const c = vertexOnEdge(ins[0], outs[2]);
            emit(a, b, c, gridPos(ins[0]), null);
          } else if (nIn === 3) {
            const a = vertexOnEdge(outs[0], ins[0]);
            const b = vertexOnEdge(outs[0], ins[1]);
            const c = vertexOnEdge(outs[0], ins[2]);
            emit(a, b, c, null, gridPos(outs[0]));
          } else {
            const a = vertexOnEdge(ins[0], outs[0]);
            const b = vertexOnEdge(ins[0], outs[1]);
            const c = vertexOnEdge(ins[1], outs[1]);
            const d = vertexOnEdge(ins[1], outs[0]);
            const mi = gridPos(ins[0]);
            const mj = gridPos(ins[1]);
            const inMid: Vec3 = [(mi[0] + mj[0]) / 2, (mi[1] + mj[1]) / 2, (mi[2] + mj[2]) / 2];
            emit(a, b, c, inMid, null);
            emit(a, c, d, inMid, null);
          }
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/**
 * Surface of a binary mask. The mask is padded, lightly blurred so the surface falls between voxel centres,
 * then extracted at 0.5. Blurring slightly rounds corners; volume from the mesh and from voxels can differ a little,
 * and both are reported separately elsewhere.
 */
export function surfaceFromMask(mask: Mask, blurIterations = 1): Mesh {
  const { volume, offsetVoxels } = padMask(mask);
  const smooth = blurIterations > 0 ? boxBlur(volume, blurIterations) : volume;
  const mesh = extractIsosurface(smooth, 0.5);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] -= offsetVoxels[0] * mask.spacingMm[0];
    mesh.positions[i + 1] -= offsetVoxels[1] * mask.spacingMm[1];
    mesh.positions[i + 2] -= offsetVoxels[2] * mask.spacingMm[2];
  }
  return mesh;
}
