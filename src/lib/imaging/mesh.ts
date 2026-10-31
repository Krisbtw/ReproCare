/** Mesh quality checks, Taubin smoothing, and exporters. All numbers come from the mesh itself. */
import type { Mesh } from "./isosurface.ts";

export type MeshQuality = {
  vertexCount: number;
  triangleCount: number;
  edgeCount: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  watertight: boolean;
  eulerCharacteristic: number;
  degenerateTriangles: number;
  componentCount: number;
  surfaceAreaMm2: number;
  /** Signed volume from the divergence theorem. Meaningful only when watertight and consistently oriented. */
  enclosedVolumeMl: number | null;
};

export function meshQuality(mesh: Mesh): MeshQuality {
  const v = mesh.positions.length / 3;
  const t = mesh.indices.length / 3;
  const edges = new Map<number, number>();
  const parent = new Int32Array(v).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  let area = 0;
  let signed = 0;
  let degenerate = 0;
  const used = new Uint8Array(v);
  for (let i = 0; i < t; i += 1) {
    const a = mesh.indices[i * 3];
    const b = mesh.indices[i * 3 + 1];
    const c = mesh.indices[i * 3 + 2];
    used[a] = used[b] = used[c] = 1;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = Math.min(p, q) * v + Math.max(p, q);
      edges.set(key, (edges.get(key) ?? 0) + 1);
      union(p, q);
    }
    const ax = mesh.positions[a * 3], ay = mesh.positions[a * 3 + 1], az = mesh.positions[a * 3 + 2];
    const bx = mesh.positions[b * 3], by = mesh.positions[b * 3 + 1], bz = mesh.positions[b * 3 + 2];
    const cx = mesh.positions[c * 3], cy = mesh.positions[c * 3 + 1], cz = mesh.positions[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const a2 = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    if (a2 < 1e-9 || a === b || b === c || a === c) degenerate += 1;
    area += a2;
    signed += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of edges.values()) {
    if (n === 1) boundary += 1;
    else if (n > 2) nonManifold += 1;
  }
  const roots = new Set<number>();
  let usedV = 0;
  for (let i = 0; i < v; i += 1) {
    if (!used[i]) continue;
    usedV += 1;
    roots.add(find(i));
  }
  const watertight = t > 0 && boundary === 0 && nonManifold === 0;
  return {
    vertexCount: usedV,
    triangleCount: t,
    edgeCount: edges.size,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    watertight,
    eulerCharacteristic: usedV - edges.size + t,
    degenerateTriangles: degenerate,
    componentCount: roots.size,
    surfaceAreaMm2: area,
    enclosedVolumeMl: watertight ? signed / 1000 : null,
  };
}

/** Taubin lambda|mu smoothing: smooths without the steady shrinkage of plain Laplacian smoothing. */
export function taubinSmooth(mesh: Mesh, iterations = 10, lambda = 0.5, mu = -0.53): Mesh {
  const v = mesh.positions.length / 3;
  const nbrs: Set<number>[] = Array.from({ length: v }, () => new Set<number>());
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
    nbrs[a].add(b).add(c);
    nbrs[b].add(a).add(c);
    nbrs[c].add(a).add(b);
  }
  let cur: Float32Array = Float32Array.from(mesh.positions);
  const step = (src: Float32Array, factor: number): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < v; i += 1) {
      const n = nbrs[i];
      if (n.size === 0) {
        out[i * 3] = src[i * 3];
        out[i * 3 + 1] = src[i * 3 + 1];
        out[i * 3 + 2] = src[i * 3 + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (const j of n) {
        sx += src[j * 3];
        sy += src[j * 3 + 1];
        sz += src[j * 3 + 2];
      }
      out[i * 3] = src[i * 3] + factor * (sx / n.size - src[i * 3]);
      out[i * 3 + 1] = src[i * 3 + 1] + factor * (sy / n.size - src[i * 3 + 1]);
      out[i * 3 + 2] = src[i * 3 + 2] + factor * (sz / n.size - src[i * 3 + 2]);
    }
    return out;
  };
  for (let i = 0; i < iterations; i += 1) {
    cur = step(step(cur, lambda), mu);
  }
  return { positions: cur, indices: mesh.indices };
}

/** Binary STL, units millimetres. 80-byte header + uint32 count + 50 bytes per triangle. */
export function toBinaryStl(mesh: Mesh, label = "AnatomyBridge mesh (mm)"): Uint8Array {
  const t = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + 50 * t);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(label.slice(0, 79));
  new Uint8Array(buf).set(head, 0);
  dv.setUint32(80, t, true);
  let o = 84;
  for (let i = 0; i < t; i += 1) {
    const a = mesh.indices[i * 3], b = mesh.indices[i * 3 + 1], c = mesh.indices[i * 3 + 2];
    const p = (k: number) => [mesh.positions[k * 3], mesh.positions[k * 3 + 1], mesh.positions[k * 3 + 2]];
    const pa = p(a), pb = p(b), pc = p(c);
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((x) => x / len);
    for (const x of n) { dv.setFloat32(o, x, true); o += 4; }
    for (const q of [pa, pb, pc]) for (const x of q) { dv.setFloat32(o, x, true); o += 4; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

export function toObj(mesh: Mesh, name = "anatomybridge_mesh"): string {
  const lines = [`# AnatomyBridge mesh, units: millimetres`, `o ${name}`];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i].toFixed(4)} ${mesh.positions[i + 1].toFixed(4)} ${mesh.positions[i + 2].toFixed(4)}`);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(`f ${mesh.indices[i] + 1} ${mesh.indices[i + 1] + 1} ${mesh.indices[i + 2] + 1}`);
  }
  return lines.join("\n") + "\n";
}
