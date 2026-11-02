/**
 * Mesh quality checks, Taubin smoothing, patient-coordinate transformation,
 * STL/OBJ exporters, and export coordinate geometry validation (Sprint 5 Task 1D & 1E).
 */
import type { Mesh } from "./isosurface.ts";
import {
  imageMmToPatientLps,
  type Vec3,
  type VolumePatientGeometry,
} from "./volume.ts";

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
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const key = Math.min(p, q) * v + Math.max(p, q);
      edges.set(key, (edges.get(key) ?? 0) + 1);
      union(p, q);
    }
    const ax = mesh.positions[a * 3],
      ay = mesh.positions[a * 3 + 1],
      az = mesh.positions[a * 3 + 2];
    const bx = mesh.positions[b * 3],
      by = mesh.positions[b * 3 + 1],
      bz = mesh.positions[b * 3 + 2];
    const cx = mesh.positions[c * 3],
      cy = mesh.positions[c * 3 + 1],
      cz = mesh.positions[c * 3 + 2];
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const wx = cx - ax,
      wy = cy - ay,
      wz = cz - az;
    const nx = uy * wz - uz * wy,
      ny = uz * wx - ux * wz,
      nz = ux * wy - uy * wx;
    const a2 = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    if (a2 < 1e-9 || a === b || b === c || a === c) degenerate += 1;
    area += a2;
    signed +=
      (ax * (by * cz - bz * cy) +
        ay * (bz * cx - bx * cz) +
        az * (bx * cy - by * cx)) /
      6;
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
export function taubinSmooth(
  mesh: Mesh,
  iterations = 10,
  lambda = 0.5,
  mu = -0.53,
): Mesh {
  const v = mesh.positions.length / 3;
  const nbrs: Set<number>[] = Array.from({ length: v }, () => new Set<number>());
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i],
      b = mesh.indices[i + 1],
      c = mesh.indices[i + 2];
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
      let sx = 0,
        sy = 0,
        sz = 0;
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
  return {
    positions: cur,
    indices: mesh.indices,
    ...(mesh.geometry ? { geometry: mesh.geometry } : {}),
    ...(mesh.coordinateSpace ? { coordinateSpace: mesh.coordinateSpace } : {}),
  };
}

/**
 * Transforms a mesh from `image_index_mm` (`[x * sx, y * sy, z * sz]`) into physical
 * DICOM LPS patient coordinates (`originMm + x*sx*rowCosines + y*sy*colCosines + z*sz*normalCosines`).
 * If the mesh is already in `patient_lps_mm`, returns a clone without double-applying the transform.
 */
export function transformMeshToPatientSpace(
  mesh: Mesh,
  geometryOverride?: VolumePatientGeometry | null,
): Mesh {
  const geom = geometryOverride ?? mesh.geometry;
  if (!geom || mesh.coordinateSpace === "patient_lps_mm") {
    return {
      positions: Float32Array.from(mesh.positions),
      indices: Uint32Array.from(mesh.indices),
      ...(geom ? { geometry: geom } : {}),
      coordinateSpace: geom ? "patient_lps_mm" : (mesh.coordinateSpace ?? "image_index_mm"),
    };
  }

  const outPositions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const lps = imageMmToPatientLps(
      [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]],
      geom,
    );
    outPositions[i] = lps[0];
    outPositions[i + 1] = lps[1];
    outPositions[i + 2] = lps[2];
  }

  // Check determinant of [rowCosines, colCosines, normalCosines]; if negative, flip triangle winding
  const [rx, ry, rz] = geom.rowCosines;
  const [cx, cy, cz] = geom.colCosines;
  const [nx, ny, nz] = geom.normalCosines;
  const det =
    rx * (cy * nz - cz * ny) -
    ry * (cx * nz - cz * nx) +
    rz * (cx * ny - cy * nx);

  const outIndices = Uint32Array.from(mesh.indices);
  if (det < 0) {
    for (let i = 0; i < outIndices.length; i += 3) {
      const tmp = outIndices[i + 1];
      outIndices[i + 1] = outIndices[i + 2];
      outIndices[i + 2] = tmp;
    }
  }

  return {
    positions: outPositions,
    indices: outIndices,
    geometry: geom,
    coordinateSpace: "patient_lps_mm",
  };
}

/**
 * Computes the vertex centroid and bounding box of a mesh in its current coordinate frame.
 */
export function computeMeshBoundsAndCentroid(mesh: Mesh): {
  centroidMm: Vec3;
  minMm: Vec3;
  maxMm: Vec3;
} {
  const v = mesh.positions.length / 3;
  if (v === 0) {
    return { centroidMm: [0, 0, 0], minMm: [0, 0, 0], maxMm: [0, 0, 0] };
  }
  const minMm: Vec3 = [Infinity, Infinity, Infinity];
  const maxMm: Vec3 = [-Infinity, -Infinity, -Infinity];
  let sx = 0,
    sy = 0,
    sz = 0;
  for (let i = 0; i < v; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    sx += x;
    sy += y;
    sz += z;
    if (x < minMm[0]) minMm[0] = x;
    if (y < minMm[1]) minMm[1] = y;
    if (z < minMm[2]) minMm[2] = z;
    if (x > maxMm[0]) maxMm[0] = x;
    if (y > maxMm[1]) maxMm[1] = y;
    if (z > maxMm[2]) maxMm[2] = z;
  }
  return {
    centroidMm: [sx / v, sy / v, sz / v],
    minMm,
    maxMm,
  };
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
    const a = mesh.indices[i * 3],
      b = mesh.indices[i * 3 + 1],
      c = mesh.indices[i * 3 + 2];
    const p = (k: number) => [
      mesh.positions[k * 3],
      mesh.positions[k * 3 + 1],
      mesh.positions[k * 3 + 2],
    ];
    const pa = p(a),
      pb = p(b),
      pc = p(c);
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    let n = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((x) => x / len);
    for (const x of n) {
      dv.setFloat32(o, x, true);
      o += 4;
    }
    for (const q of [pa, pb, pc])
      for (const x of q) {
        dv.setFloat32(o, x, true);
        o += 4;
      }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

/**
 * Exports a mesh directly in physical DICOM LPS patient coordinates as Binary STL.
 */
export function toPatientSpaceBinaryStl(
  mesh: Mesh,
  geometry?: VolumePatientGeometry | null,
  label = "AnatomyBridge DICOM_LPS mesh (mm)",
): Uint8Array {
  const patientMesh = transformMeshToPatientSpace(mesh, geometry);
  return toBinaryStl(patientMesh, label);
}

export function toObj(mesh: Mesh, name = "anatomybridge_mesh"): string {
  const spaceLabel = mesh.coordinateSpace === "patient_lps_mm" ? "DICOM_LPS_mm" : "image_index_mm";
  const lines = [`# AnatomyBridge mesh, units: millimetres, space: ${spaceLabel}`, `o ${name}`];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(
      `v ${mesh.positions[i].toFixed(4)} ${mesh.positions[i + 1].toFixed(4)} ${mesh.positions[i + 2].toFixed(4)}`,
    );
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(
      `f ${mesh.indices[i] + 1} ${mesh.indices[i + 1] + 1} ${mesh.indices[i + 2] + 1}`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Exports a mesh directly in physical DICOM LPS patient coordinates as Wavefront OBJ.
 */
export function toPatientSpaceObj(
  mesh: Mesh,
  geometry?: VolumePatientGeometry | null,
  name = "anatomybridge_lps_mesh",
): string {
  const patientMesh = transformMeshToPatientSpace(mesh, geometry);
  return toObj(patientMesh, name);
}

/**
 * Validates that an exported Binary STL or Wavefront OBJ preserves the expected physical
 * coordinates of the mesh (Sprint 5 Task 1D & 1E).
 */
export function validateExportedMeshGeometry(
  sourceMesh: Mesh,
  exported: Uint8Array | string,
  expectedGeometry?: VolumePatientGeometry | null,
  toleranceMm = 1e-2,
): {
  valid: boolean;
  format: "stl" | "obj";
  triangleCount: number;
  exportedCentroidMm: Vec3;
  expectedCentroidMm: Vec3;
  maxCoordinateErrorMm: number;
  reason?: string;
} {
  const refMesh = expectedGeometry
    ? transformMeshToPatientSpace(sourceMesh, expectedGeometry)
    : sourceMesh;
  const expectedBounds = computeMeshBoundsAndCentroid(refMesh);

  if (typeof exported === "string") {
    const verts: Vec3[] = [];
    let faces = 0;
    for (const line of exported.split(/\r?\n/)) {
      if (line.startsWith("v ")) {
        const parts = line.slice(2).trim().split(/\s+/).map(Number);
        if (parts.length === 3 && parts.every(Number.isFinite)) {
          verts.push([parts[0], parts[1], parts[2]]);
        }
      } else if (line.startsWith("f ")) {
        faces++;
      }
    }
    if (verts.length !== refMesh.positions.length / 3) {
      return {
        valid: false,
        format: "obj",
        triangleCount: faces,
        exportedCentroidMm: [0, 0, 0],
        expectedCentroidMm: expectedBounds.centroidMm,
        maxCoordinateErrorMm: Infinity,
        reason: `Vertex count mismatch: exported ${verts.length}, expected ${refMesh.positions.length / 3}.`,
      };
    }
    let maxErr = 0;
    let sx = 0,
      sy = 0,
      sz = 0;
    for (let i = 0; i < verts.length; i++) {
      const [vx, vy, vz] = verts[i];
      sx += vx;
      sy += vy;
      sz += vz;
      const err = Math.hypot(
        vx - refMesh.positions[i * 3],
        vy - refMesh.positions[i * 3 + 1],
        vz - refMesh.positions[i * 3 + 2],
      );
      if (err > maxErr) maxErr = err;
    }
    const exportedCentroidMm: Vec3 = [
      sx / Math.max(1, verts.length),
      sy / Math.max(1, verts.length),
      sz / Math.max(1, verts.length),
    ];
    return {
      valid: maxErr <= toleranceMm && faces === refMesh.indices.length / 3,
      format: "obj",
      triangleCount: faces,
      exportedCentroidMm,
      expectedCentroidMm: expectedBounds.centroidMm,
      maxCoordinateErrorMm: maxErr,
      ...(maxErr > toleranceMm
        ? { reason: `Max coordinate error ${maxErr.toFixed(4)} mm exceeds tolerance ${toleranceMm} mm.` }
        : {}),
    };
  }

  // Binary STL validation
  if (exported.byteLength < 84) {
    return {
      valid: false,
      format: "stl",
      triangleCount: 0,
      exportedCentroidMm: [0, 0, 0],
      expectedCentroidMm: expectedBounds.centroidMm,
      maxCoordinateErrorMm: Infinity,
      reason: "Binary STL is shorter than 84-byte header.",
    };
  }
  const dv = new DataView(exported.buffer, exported.byteOffset, exported.byteLength);
  const tCount = dv.getUint32(80, true);
  const expectedT = refMesh.indices.length / 3;
  if (tCount !== expectedT || exported.byteLength !== 84 + 50 * tCount) {
    return {
      valid: false,
      format: "stl",
      triangleCount: tCount,
      exportedCentroidMm: [0, 0, 0],
      expectedCentroidMm: expectedBounds.centroidMm,
      maxCoordinateErrorMm: Infinity,
      reason: `Triangle count or byte size mismatch in STL (${tCount} vs ${expectedT}).`,
    };
  }

  let maxErr = 0;
  const minStl: Vec3 = [Infinity, Infinity, Infinity];
  const maxStl: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < tCount; t++) {
    const baseOffset = 84 + t * 50 + 12; // skip 12-byte normal
    for (let k = 0; k < 3; k++) {
      const vIdx = refMesh.indices[t * 3 + k];
      const vx = dv.getFloat32(baseOffset + k * 12, true);
      const vy = dv.getFloat32(baseOffset + k * 12 + 4, true);
      const vz = dv.getFloat32(baseOffset + k * 12 + 8, true);
      if (vx < minStl[0]) minStl[0] = vx;
      if (vy < minStl[1]) minStl[1] = vy;
      if (vz < minStl[2]) minStl[2] = vz;
      if (vx > maxStl[0]) maxStl[0] = vx;
      if (vy > maxStl[1]) maxStl[1] = vy;
      if (vz > maxStl[2]) maxStl[2] = vz;

      const err = Math.hypot(
        vx - refMesh.positions[vIdx * 3],
        vy - refMesh.positions[vIdx * 3 + 1],
        vz - refMesh.positions[vIdx * 3 + 2],
      );
      if (err > maxErr) maxErr = err;
    }
  }

  const exportedCentroidMm: Vec3 = [
    (minStl[0] + maxStl[0]) / 2,
    (minStl[1] + maxStl[1]) / 2,
    (minStl[2] + maxStl[2]) / 2,
  ];
  const expectedBoxCenter: Vec3 = [
    (expectedBounds.minMm[0] + expectedBounds.maxMm[0]) / 2,
    (expectedBounds.minMm[1] + expectedBounds.maxMm[1]) / 2,
    (expectedBounds.minMm[2] + expectedBounds.maxMm[2]) / 2,
  ];

  return {
    valid: maxErr <= toleranceMm,
    format: "stl",
    triangleCount: tCount,
    exportedCentroidMm,
    expectedCentroidMm: expectedBoxCenter,
    maxCoordinateErrorMm: maxErr,
  };
}
