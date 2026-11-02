/**
 * Shared voxel containers and physical DICOM patient-coordinate geometry (Sprint 5 Task 1D).
 * Index order is x + nx * (y + ny * z). Spacing is millimetres per voxel step along x, y, z.
 */

export type Vec3 = [number, number, number];

export type DirectionCosines9 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type VolumePatientGeometry = {
  /** Physical LPS position (mm) of the centre of voxel (0, 0, 0) from ImagePositionPatient (0020,0032). */
  originMm: Vec3;
  /** Unit direction cosine vector along increasing column index x (rowCosines from ImageOrientationPatient[0..2]). */
  rowCosines: Vec3;
  /** Unit direction cosine vector along increasing row index y (colCosines from ImageOrientationPatient[3..5]). */
  colCosines: Vec3;
  /** Unit slice-stacking normal vector along increasing slice index z (rowCosines × colCosines). */
  normalCosines: Vec3;
  /** Flattened 9-element direction cosine matrix [rowX, rowY, rowZ, colX, colY, colZ, normX, normY, normZ]. */
  directionCosines: DirectionCosines9;
  /** PatientPosition (0018,5100), e.g., HFS, FFS, HFP, FFP. */
  patientPosition?: string | null;
  /** FrameOfReferenceUID (0020,0052). */
  frameOfReferenceUid?: string | null;
  /** SeriesInstanceUID (0020,000E). */
  seriesUid?: string | null;
  /** TransferSyntaxUID (0002,0010). */
  transferSyntax?: string | null;
  /** Coordinate convention, always DICOM LPS (+X Left, +Y Posterior, +Z Superior). */
  coordinateSystem?: "DICOM_LPS";
};

export type Volume = {
  dims: Vec3;
  spacingMm: Vec3;
  data: Float32Array;
  /** Optional physical DICOM patient-space geometry preserved throughout reconstruction, preprocessing, segmentation, and mesh export. */
  geometry?: VolumePatientGeometry;
};

export type Mask = {
  dims: Vec3;
  spacingMm: Vec3;
  data: Uint8Array;
  /** Optional physical DICOM patient-space geometry inherited from the source volume. */
  geometry?: VolumePatientGeometry;
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

export function emptyMask(dims: Vec3, spacingMm: Vec3, geometry?: VolumePatientGeometry): Mask {
  return {
    dims,
    spacingMm,
    data: new Uint8Array(dims[0] * dims[1] * dims[2]),
    ...(geometry ? { geometry } : {}),
  };
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

/**
 * Converts an image-index coordinate `(xMm, yMm, zMm) = (x * sx, y * sy, z * sz)` into
 * physical DICOM LPS patient coordinates `(L, P, S)` using `VolumePatientGeometry`.
 */
export function imageMmToPatientLps(
  imageMm: Vec3,
  geometry?: VolumePatientGeometry | null,
): Vec3 {
  if (!geometry) return [imageMm[0], imageMm[1], imageMm[2]];
  const [ix, iy, iz] = imageMm;
  const { originMm, rowCosines, colCosines, normalCosines } = geometry;
  return [
    originMm[0] + ix * rowCosines[0] + iy * colCosines[0] + iz * normalCosines[0],
    originMm[1] + ix * rowCosines[1] + iy * colCosines[1] + iz * normalCosines[1],
    originMm[2] + ix * rowCosines[2] + iy * colCosines[2] + iz * normalCosines[2],
  ];
}

/**
 * Converts a continuous or integer voxel coordinate `(vx, vy, vz)` into physical DICOM LPS mm.
 */
export function voxelToPatientLps(
  voxel: Vec3,
  spacingMm: Vec3,
  geometry?: VolumePatientGeometry | null,
): Vec3 {
  return imageMmToPatientLps(
    [voxel[0] * spacingMm[0], voxel[1] * spacingMm[1], voxel[2] * spacingMm[2]],
    geometry,
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
  geometry?: VolumePatientGeometry,
): Mask {
  const mask = emptyMask(dims, spacingMm, geometry);
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
