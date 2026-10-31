/** Shared voxel containers. Index order is x + nx * (y + ny * z). Spacing is millimetres per voxel step along x, y, z. */

export type Vec3 = [number, number, number];

export type Volume = {
  dims: Vec3;
  spacingMm: Vec3;
  data: Float32Array;
};

export type Mask = {
  dims: Vec3;
  spacingMm: Vec3;
  data: Uint8Array;
};

export function vIndex(dims: Vec3, x: number, y: number, z: number): number {
  return x + dims[0] * (y + dims[1] * z);
}

export function inBounds(dims: Vec3, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < dims[0] && y < dims[1] && z < dims[2];
}

export function voxelVolumeMl(spacingMm: Vec3): number {
  return (spacingMm[0] * spacingMm[1] * spacingMm[2]) / 1000;
}

export function emptyMask(dims: Vec3, spacingMm: Vec3): Mask {
  return { dims, spacingMm, data: new Uint8Array(dims[0] * dims[1] * dims[2]) };
}

export function maskVoxelCount(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i += 1) if (mask.data[i]) n += 1;
  return n;
}

export function sameGrid(a: { dims: Vec3; spacingMm: Vec3 }, b: { dims: Vec3; spacingMm: Vec3 }): boolean {
  return (
    a.dims[0] === b.dims[0] &&
    a.dims[1] === b.dims[1] &&
    a.dims[2] === b.dims[2] &&
    a.spacingMm.every((s, i) => Math.abs(s - b.spacingMm[i]) < 1e-6)
  );
}

export const NEIGHBORS_6: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Ellipsoid label on an anisotropic grid. Centre defaults to the grid centre. Used for phantoms and tests only. */
export function ellipsoidMask(
  dims: Vec3,
  spacingMm: Vec3,
  radiiMm: Vec3,
  centreMm?: Vec3,
): Mask {
  const mask = emptyMask(dims, spacingMm);
  const c: Vec3 =
    centreMm ?? [((dims[0] - 1) / 2) * spacingMm[0], ((dims[1] - 1) / 2) * spacingMm[1], ((dims[2] - 1) / 2) * spacingMm[2]];
  for (let z = 0; z < dims[2]; z += 1) {
    for (let y = 0; y < dims[1]; y += 1) {
      for (let x = 0; x < dims[0]; x += 1) {
        const dx = (x * spacingMm[0] - c[0]) / radiiMm[0];
        const dy = (y * spacingMm[1] - c[1]) / radiiMm[1];
        const dz = (z * spacingMm[2] - c[2]) / radiiMm[2];
        if (dx * dx + dy * dy + dz * dz <= 1) mask.data[vIndex(dims, x, y, z)] = 1;
      }
    }
  }
  return mask;
}
