/** Cuberille surface from a binary label volume. Not Marching Cubes — block faces, which stay watertight for a solid mask. */

export type SurfaceStats = {
  positions: Float32Array;
  indices: Uint32Array;
  voxelCount: number;
  componentCount: number;
  volumeMl: number;
  triangleCount: number;
  spacingMm: number;
};

export function labelEllipsoid(
  n: number,
  spacingMm: number,
  radiiMm: [number, number, number],
): Uint8Array {
  const grid = new Uint8Array(n * n * n);
  const c = (n - 1) / 2;
  const [rx, ry, rz] = radiiMm;
  for (let z = 0; z < n; z += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const dx = ((x - c) * spacingMm) / rx;
        const dy = ((y - c) * spacingMm) / ry;
        const dz = ((z - c) * spacingMm) / rz;
        if (dx * dx + dy * dy + dz * dz <= 1) grid[x + n * (y + n * z)] = 1;
      }
    }
  }
  return grid;
}

function idx(n: number, x: number, y: number, z: number): number {
  return x + n * (y + n * z);
}

export function countComponents(grid: Uint8Array, n: number): number {
  const seen = new Uint8Array(grid.length);
  let count = 0;
  const stack: number[] = [];
  for (let i = 0; i < grid.length; i += 1) {
    if (!grid[i] || seen[i]) continue;
    count += 1;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const cur = stack.pop() as number;
      const z = Math.floor(cur / (n * n));
      const y = Math.floor((cur - z * n * n) / n);
      const x = cur - z * n * n - y * n;
      const nbrs: [number, number, number][] = [
        [x - 1, y, z],
        [x + 1, y, z],
        [x, y - 1, z],
        [x, y + 1, z],
        [x, y, z - 1],
        [x, y, z + 1],
      ];
      for (const [nx, ny, nz] of nbrs) {
        if (nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n) continue;
        const j = idx(n, nx, ny, nz);
        if (!grid[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return count;
}

const FACES: { dx: number; dy: number; dz: number; corners: [number, number, number][] }[] = [
  {
    dx: 1, dy: 0, dz: 0,
    corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  },
  {
    dx: -1, dy: 0, dz: 0,
    corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  },
  {
    dx: 0, dy: 1, dz: 0,
    corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  },
  {
    dx: 0, dy: -1, dz: 0,
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  },
  {
    dx: 0, dy: 0, dz: 1,
    corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  },
  {
    dx: 0, dy: 0, dz: -1,
    corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  },
];

export function extractSurface(grid: Uint8Array, n: number, spacingMm: number): SurfaceStats {
  const positions: number[] = [];
  const indices: number[] = [];
  let voxelCount = 0;
  const origin = ((n - 1) / 2) * spacingMm;
  for (let z = 0; z < n; z += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if (!grid[idx(n, x, y, z)]) continue;
        voxelCount += 1;
        for (const face of FACES) {
          const nx = x + face.dx;
          const ny = y + face.dy;
          const nz = z + face.dz;
          const outside =
            nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n || !grid[idx(n, nx, ny, nz)];
          if (!outside) continue;
          const base = positions.length / 3;
          for (const [cx, cy, cz] of face.corners) {
            positions.push((x + cx) * spacingMm - origin, (y + cy) * spacingMm - origin, (z + cz) * spacingMm - origin);
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    voxelCount,
    componentCount: countComponents(grid, n),
    volumeMl: (voxelCount * spacingMm * spacingMm * spacingMm) / 1000,
    triangleCount: indices.length / 3,
    spacingMm,
  };
}

export function analyticEllipsoidMl(radiiMm: [number, number, number]): number {
  return ((4 / 3) * Math.PI * radiiMm[0] * radiiMm[1] * radiiMm[2]) / 1000;
}
