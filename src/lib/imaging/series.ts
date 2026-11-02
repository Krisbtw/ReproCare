/**
 * DICOM series geometry validation, multi-frame expansion, and physical LPS volume assembly
 * (Sprint 5 Task 1B, 1C, 1D).
 *
 * Works on plain per-slice records so it does not depend on a parser.
 * Nothing here resamples or invents slices: a series with gaps is reported, not silently repaired.
 */
import {
  buildVoxelToPatientAffine4x4,
  type DirectionCosines9,
  type Vec3,
  type Volume,
  type VolumePatientGeometry,
} from "./volume.ts";
import type { DicomRead } from "../dicom/codec.ts";

export type SliceGeometry = {
  id: string;
  seriesUid: string | null;
  sopInstanceUid?: string | null;
  instanceNumber: number | null;
  /** ImagePositionPatient, mm. */
  positionMm: Vec3 | null;
  /** ImageOrientationPatient: row direction cosines then column direction cosines. */
  orientation: [number, number, number, number, number, number] | null;
  /** PixelSpacing as [row spacing, column spacing], mm. */
  pixelSpacingMm: [number, number] | null;
  rows: number;
  cols: number;
  sliceThicknessMm: number | null;
  transferSyntax?: string | null;
  patientPosition?: string | null;
  frameOfReferenceUid?: string | null;
};

export type IssueSeverity = "error" | "warning";

export type SeriesIssue = {
  code:
    | "empty"
    | "mixed_series"
    | "mixed_matrix"
    | "mixed_pixel_spacing"
    | "missing_geometry"
    | "bad_orientation"
    | "mixed_orientation"
    | "duplicate_position"
    | "duplicate_sop_instance"
    | "mixed_transfer_syntax"
    | "mixed_patient_position"
    | "missing_slices"
    | "irregular_spacing"
    | "thickness_spacing_mismatch"
    | "instance_order_disagrees";
  severity: IssueSeverity;
  message: string;
  sliceIds: string[];
};

export type SeriesReport = {
  /** Slice ids in spatial order along the slice normal. Empty when spatial order could not be established. */
  orderedIds: string[];
  spatiallyOrdered: boolean;
  normal: Vec3 | null;
  /** Median centre-to-centre distance between neighbouring slices. */
  sliceSpacingMm: number | null;
  pixelSpacingMm: [number, number] | null;
  rows: number;
  cols: number;
  issues: SeriesIssue[];
  /** True only when a gap-free, consistently oriented volume can be stacked without resampling. */
  volumeReady: boolean;
  /** Complete physical DICOM LPS coordinate frame of the stacked volume (origin at ordered slice 0). */
  geometry?: VolumePatientGeometry | null;
};

const UNIT_TOL = 0.02;
const ORTHO_TOL = 0.02;
const SAME_ORIENT_TOL = 0.01;
const SPACING_REL_TOL = 0.1;
const GAP_FACTOR = 1.5;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalizeVec(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}
function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Parses a DICOM multi-value decimal string such as "0\\0\\0" or "1\\0\\0\\0\\1\\0". */
export function parseDs(value: string | undefined | null): number[] | null {
  if (!value) return null;
  const parts = value.split("\\").map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

export function geometryFromMetadata(
  id: string,
  metadata: Record<string, string>,
  rows: number,
  cols: number,
): SliceGeometry {
  const pos = parseDs(metadata["Image position patient"]);
  const ori = parseDs(metadata["Image orientation patient"]);
  const ps = parseDs(metadata["Pixel spacing"]);
  const thick = parseDs(metadata["Slice thickness"]);
  const inst = parseDs(metadata["Instance number"]);
  return {
    id,
    seriesUid: metadata["Series UID"] ?? null,
    sopInstanceUid: metadata["SOP instance UID"] ?? null,
    instanceNumber: inst && inst.length === 1 ? inst[0] : null,
    positionMm: pos && pos.length === 3 ? (pos as Vec3) : null,
    orientation: ori && ori.length === 6 ? (ori as SliceGeometry["orientation"]) : null,
    pixelSpacingMm: ps && ps.length === 2 ? ([ps[0], ps[1]] as [number, number]) : null,
    rows,
    cols,
    sliceThicknessMm: thick && thick.length === 1 ? thick[0] : null,
    transferSyntax: metadata["Transfer syntax"] ?? null,
    patientPosition: metadata["Patient position"] ?? null,
    frameOfReferenceUid: metadata["Frame of reference UID"] ?? null,
  };
}

/**
 * Expands a single-frame or multi-frame `DicomRead` into individual `SliceGeometry` entries
 * and a `Map<string, Float32Array>` of calibrated pixel buffers for `analyzeSeries` / `buildVolume`.
 */
export function expandMultiFrameDicomToSeries(
  idPrefix: string,
  read: DicomRead,
): {
  slices: SliceGeometry[];
  pixelsById: Map<string, Float32Array>;
} {
  const slices: SliceGeometry[] = [];
  const pixelsById = new Map<string, Float32Array>();
  const baseGeom = geometryFromMetadata(idPrefix, read.metadata, read.rows, read.cols);

  const count = Math.max(1, read.numberOfFrames);
  for (let f = 0; f < count; f++) {
    const frameId = count === 1 ? idPrefix : `${idPrefix}#frame-${f + 1}`;
    const pf = read.perFrameMetadata?.[f];
    const framePos = pf?.positionMm ?? read.framePositionsMm[f] ?? (f === 0 ? baseGeom.positionMm : null);
    const frameOri = pf?.orientation ?? baseGeom.orientation;
    const framePs = pf?.pixelSpacingMm ?? baseGeom.pixelSpacingMm;
    const frameThick = pf?.sliceThicknessMm ?? baseGeom.sliceThicknessMm;
    slices.push({
      ...baseGeom,
      id: frameId,
      sopInstanceUid:
        baseGeom.sopInstanceUid && count > 1
          ? `${baseGeom.sopInstanceUid}.${f + 1}`
          : baseGeom.sopInstanceUid,
      instanceNumber: count > 1 ? f + 1 : baseGeom.instanceNumber,
      positionMm: framePos,
      orientation: frameOri,
      pixelSpacingMm: framePs,
      sliceThicknessMm: frameThick,
    });
    const frameBuf = read.frameFloatPixels[f];
    if (frameBuf) {
      pixelsById.set(frameId, frameBuf);
    }
  }

  return { slices, pixelsById };
}

export function analyzeSeries(slices: SliceGeometry[]): SeriesReport {
  const issues: SeriesIssue[] = [];
  const report: SeriesReport = {
    orderedIds: [],
    spatiallyOrdered: false,
    normal: null,
    sliceSpacingMm: null,
    pixelSpacingMm: null,
    rows: 0,
    cols: 0,
    issues,
    volumeReady: false,
    geometry: null,
  };
  if (slices.length === 0) {
    issues.push({
      code: "empty",
      severity: "error",
      message: "No slices were provided.",
      sliceIds: [],
    });
    return report;
  }

  report.rows = slices[0].rows;
  report.cols = slices[0].cols;

  const uids = new Set(slices.map((s) => s.seriesUid ?? ""));
  if (uids.size > 1) {
    issues.push({
      code: "mixed_series",
      severity: "error",
      message: "Slices belong to more than one series UID. Load one series at a time.",
      sliceIds: slices.map((s) => s.id),
    });
  }
  if (slices.some((s) => s.rows !== report.rows || s.cols !== report.cols)) {
    issues.push({
      code: "mixed_matrix",
      severity: "error",
      message: "Slices do not share one rows × columns matrix.",
      sliceIds: slices
        .filter((s) => s.rows !== report.rows || s.cols !== report.cols)
        .map((s) => s.id),
    });
  }

  // Check duplicate SOPInstanceUIDs when populated
  const seenSop = new Map<string, string>();
  const dupSopSliceIds: string[] = [];
  for (const s of slices) {
    if (s.sopInstanceUid) {
      if (seenSop.has(s.sopInstanceUid)) {
        dupSopSliceIds.push(s.id);
      } else {
        seenSop.set(s.sopInstanceUid, s.id);
      }
    }
  }
  if (dupSopSliceIds.length > 0) {
    issues.push({
      code: "duplicate_sop_instance",
      severity: "error",
      message: "Duplicate SOPInstanceUID detected in series.",
      sliceIds: dupSopSliceIds,
    });
  }

  // Check transfer syntax consistency across slices
  const nonEmptySyntaxes = new Set(
    slices.map((s) => s.transferSyntax).filter((t): t is string => Boolean(t)),
  );
  if (nonEmptySyntaxes.size > 1) {
    issues.push({
      code: "mixed_transfer_syntax",
      severity: "warning",
      message: `Series slices use multiple transfer syntaxes (${[...nonEmptySyntaxes].join(", ")}).`,
      sliceIds: slices.map((s) => s.id),
    });
  }

  // Check PatientPosition consistency across slices
  const nonEmptyPositions = new Set(
    slices.map((s) => s.patientPosition).filter((p): p is string => Boolean(p)),
  );
  if (nonEmptyPositions.size > 1) {
    issues.push({
      code: "mixed_patient_position",
      severity: "error",
      message: `Slices have conflicting PatientPosition values (${[...nonEmptyPositions].join(" vs ")}).`,
      sliceIds: slices.map((s) => s.id),
    });
  }

  const missing = slices.filter(
    (s) => !s.positionMm || !s.orientation || !s.pixelSpacingMm,
  );
  if (missing.length) {
    issues.push({
      code: "missing_geometry",
      severity: "error",
      message:
        "Position, orientation, or pixel spacing is missing on some slices. Their place in space cannot be verified, so no millimetre measurement is offered.",
      sliceIds: missing.map((s) => s.id),
    });
    return report;
  }

  const first = slices[0];
  report.pixelSpacingMm = first.pixelSpacingMm;
  const psBad = slices.filter(
    (s) =>
      Math.abs((s.pixelSpacingMm as number[])[0] - (first.pixelSpacingMm as number[])[0]) >
        1e-3 ||
      Math.abs((s.pixelSpacingMm as number[])[1] - (first.pixelSpacingMm as number[])[1]) >
        1e-3,
  );
  if (psBad.length) {
    issues.push({
      code: "mixed_pixel_spacing",
      severity: "error",
      message: "Pixel spacing differs between slices.",
      sliceIds: psBad.map((s) => s.id),
    });
  }

  const row0 = (first.orientation as number[]).slice(0, 3) as Vec3;
  const col0 = (first.orientation as number[]).slice(3, 6) as Vec3;
  if (
    Math.abs(norm(row0) - 1) > UNIT_TOL ||
    Math.abs(norm(col0) - 1) > UNIT_TOL ||
    Math.abs(dot(row0, col0)) > ORTHO_TOL
  ) {
    issues.push({
      code: "bad_orientation",
      severity: "error",
      message:
        "Image orientation vectors are not unit length and perpendicular, so the slice plane is not well defined.",
      sliceIds: [first.id],
    });
    return report;
  }
  const mixedOri = slices.filter((s) => {
    const o = s.orientation as number[];
    return o.some((v, i) => Math.abs(v - (first.orientation as number[])[i]) > SAME_ORIENT_TOL);
  });
  if (mixedOri.length) {
    issues.push({
      code: "mixed_orientation",
      severity: "error",
      message:
        "Slices have different orientations (for example a localiser mixed into the series, or gantry tilt).",
      sliceIds: mixedOri.map((s) => s.id),
    });
    return report;
  }

  const unitRow = normalizeVec(row0);
  const unitCol = normalizeVec(col0);
  const normal = normalizeVec(cross(unitRow, unitCol));
  report.normal = normal;
  const withPos = slices.map((s) => ({ s, d: dot(s.positionMm as Vec3, normal) }));
  withPos.sort((a, b) => a.d - b.d);
  report.orderedIds = withPos.map((p) => p.s.id);
  report.spatiallyOrdered = true;

  const firstOrderedSlice = withPos[0].s;
  const originMm = firstOrderedSlice.positionMm as Vec3;
  const directionCosines: DirectionCosines9 = [
    unitRow[0], unitRow[1], unitRow[2],
    unitCol[0], unitCol[1], unitCol[2],
    normal[0], normal[1], normal[2],
  ];

  report.geometry = {
    originMm: [originMm[0], originMm[1], originMm[2]],
    rowCosines: unitRow,
    colCosines: unitCol,
    normalCosines: normal,
    directionCosines,
    patientPosition: firstOrderedSlice.patientPosition ?? null,
    frameOfReferenceUid: firstOrderedSlice.frameOfReferenceUid ?? null,
    seriesUid: firstOrderedSlice.seriesUid ?? null,
    transferSyntax: firstOrderedSlice.transferSyntax ?? null,
    coordinateSystem: "DICOM_LPS",
  };

  const deltas: number[] = [];
  const dupIds: string[] = [];
  for (let i = 1; i < withPos.length; i += 1) {
    const d = withPos[i].d - withPos[i - 1].d;
    if (d < 1e-3) dupIds.push(withPos[i].s.id);
    else deltas.push(d);
  }
  if (dupIds.length) {
    issues.push({
      code: "duplicate_position",
      severity: "error",
      message: "More than one slice sits at the same position along the slice normal.",
      sliceIds: dupIds,
    });
  }
  if (deltas.length === 0) {
    return report;
  }
  const step = median(deltas);
  report.sliceSpacingMm = step;

  const gapIds: string[] = [];
  let missingCount = 0;
  const irregularIds: string[] = [];
  for (let i = 1; i < withPos.length; i += 1) {
    const d = withPos[i].d - withPos[i - 1].d;
    if (d < 1e-3) continue;
    if (d > GAP_FACTOR * step) {
      gapIds.push(withPos[i].s.id);
      missingCount += Math.max(1, Math.round(d / step) - 1);
    } else if (Math.abs(d - step) / step > SPACING_REL_TOL) {
      irregularIds.push(withPos[i].s.id);
    }
  }
  if (gapIds.length) {
    issues.push({
      code: "missing_slices",
      severity: "error",
      message: `About ${missingCount} slice${missingCount === 1 ? "" : "s"} appear to be missing (${gapIds.length} gap${gapIds.length === 1 ? "" : "s"}). The series is not stacked into a volume.`,
      sliceIds: gapIds,
    });
  }
  if (irregularIds.length) {
    issues.push({
      code: "irregular_spacing",
      severity: "warning",
      message:
        "Slice spacing varies by more than 10% in places. Distances along the slice axis are approximate.",
      sliceIds: irregularIds,
    });
  }
  const thicknesses = slices
    .map((s) => s.sliceThicknessMm)
    .filter((n): n is number => n != null && Number.isFinite(n));
  const thick = thicknesses.length ? median(thicknesses) : NaN;
  if (Number.isFinite(thick) && Math.abs(thick - step) / step > 0.2) {
    issues.push({
      code: "thickness_spacing_mismatch",
      severity: "warning",
      message: `Slice thickness (${thick.toFixed(2)} mm) and centre spacing (${step.toFixed(2)} mm) differ by more than 20%, so slices overlap or leave gaps by protocol.`,
      sliceIds: [],
    });
  }

  const instanced = withPos.filter((p) => p.s.instanceNumber != null);
  if (instanced.length === withPos.length && withPos.length > 2) {
    const asc = instanced.every(
      (p, i) =>
        i === 0 ||
        (p.s.instanceNumber as number) > (instanced[i - 1].s.instanceNumber as number),
    );
    const desc = instanced.every(
      (p, i) =>
        i === 0 ||
        (p.s.instanceNumber as number) < (instanced[i - 1].s.instanceNumber as number),
    );
    if (!asc && !desc) {
      issues.push({
        code: "instance_order_disagrees",
        severity: "warning",
        message: "Instance numbers do not follow spatial order. Spatial position was used.",
        sliceIds: [],
      });
    }
  }

  report.volumeReady = !issues.some((i) => i.severity === "error");
  return report;
}

/**
 * Stacks per-slice pixel arrays (row-major, rows × cols, already rescaled to real intensities) into one volume
 * and attaches the physical DICOM patient geometry (`VolumePatientGeometry`).
 * Refuses when the series report is not volume-ready. x = column index, y = row index, z = slice index in spatial order.
 */
export function buildVolume(
  report: SeriesReport,
  pixelsById: Map<string, Float32Array>,
): Volume {
  if (!report.volumeReady || !report.pixelSpacingMm || report.sliceSpacingMm == null) {
    throw new Error(
      "Series is not volume-ready: " +
        report.issues
          .filter((i) => i.severity === "error")
          .map((i) => i.message)
          .join(" "),
    );
  }
  const nx = report.cols;
  const ny = report.rows;
  const nz = report.orderedIds.length;
  const data = new Float32Array(nx * ny * nz);
  report.orderedIds.forEach((id, z) => {
    const px = pixelsById.get(id);
    if (!px || px.length !== nx * ny) {
      throw new Error(`Pixel data missing or wrong size for slice ${id}.`);
    }
    data.set(px, z * nx * ny);
  });
  // PixelSpacing is [between rows (y step), between columns (x step)].
  const spacingMm: Vec3 = [report.pixelSpacingMm[1], report.pixelSpacingMm[0], report.sliceSpacingMm];
  const geometryWithAffine: VolumePatientGeometry | undefined = report.geometry
    ? {
        ...report.geometry,
        affine4x4: buildVoxelToPatientAffine4x4(report.geometry, spacingMm),
      }
    : undefined;
  return {
    dims: [nx, ny, nz],
    spacingMm,
    data,
    ...(geometryWithAffine ? { geometry: geometryWithAffine } : {}),
  };
}
