/**
 * DICOM series geometry checks. Works on plain per-slice records so it does not depend on a parser.
 * Nothing here resamples or invents slices: a series with gaps is reported, not silently repaired.
 */
import type { Vec3, Volume } from "./volume.ts";

export type SliceGeometry = {
  id: string;
  seriesUid: string | null;
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
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
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
    instanceNumber: inst && inst.length === 1 ? inst[0] : null,
    positionMm: pos && pos.length === 3 ? (pos as Vec3) : null,
    orientation: ori && ori.length === 6 ? (ori as SliceGeometry["orientation"]) : null,
    pixelSpacingMm: ps && ps.length === 2 ? ([ps[0], ps[1]] as [number, number]) : null,
    rows,
    cols,
    sliceThicknessMm: thick && thick.length === 1 ? thick[0] : null,
  };
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
  };
  if (slices.length === 0) {
    issues.push({ code: "empty", severity: "error", message: "No slices were provided.", sliceIds: [] });
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
      sliceIds: slices.filter((s) => s.rows !== report.rows || s.cols !== report.cols).map((s) => s.id),
    });
  }

  const missing = slices.filter((s) => !s.positionMm || !s.orientation || !s.pixelSpacingMm);
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
      Math.abs((s.pixelSpacingMm as number[])[0] - (first.pixelSpacingMm as number[])[0]) > 1e-3 ||
      Math.abs((s.pixelSpacingMm as number[])[1] - (first.pixelSpacingMm as number[])[1]) > 1e-3,
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
  if (Math.abs(norm(row0) - 1) > UNIT_TOL || Math.abs(norm(col0) - 1) > UNIT_TOL || Math.abs(dot(row0, col0)) > ORTHO_TOL) {
    issues.push({
      code: "bad_orientation",
      severity: "error",
      message: "Image orientation vectors are not unit length and perpendicular, so the slice plane is not well defined.",
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
      message: "Slices have different orientations (for example a localiser mixed into the series, or gantry tilt).",
      sliceIds: mixedOri.map((s) => s.id),
    });
    return report;
  }

  const normal = cross(row0, col0);
  report.normal = normal;
  const withPos = slices.map((s) => ({ s, d: dot(s.positionMm as Vec3, normal) }));
  withPos.sort((a, b) => a.d - b.d);
  report.orderedIds = withPos.map((p) => p.s.id);
  report.spatiallyOrdered = true;

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
      message: "Slice spacing varies by more than 10% in places. Distances along the slice axis are approximate.",
      sliceIds: irregularIds,
    });
  }
  const thicknesses = slices.map((s) => s.sliceThicknessMm).filter((n): n is number => n != null && Number.isFinite(n));
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
    const asc = instanced.every((p, i) => i === 0 || (p.s.instanceNumber as number) > (instanced[i - 1].s.instanceNumber as number));
    const desc = instanced.every((p, i) => i === 0 || (p.s.instanceNumber as number) < (instanced[i - 1].s.instanceNumber as number));
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
 * Stacks per-slice pixel arrays (row-major, rows × cols, already rescaled to real intensities) into one volume.
 * Refuses when the series report is not volume-ready. x = column index, y = row index, z = slice index in spatial order.
 */
export function buildVolume(report: SeriesReport, pixelsById: Map<string, Float32Array>): Volume {
  if (!report.volumeReady || !report.pixelSpacingMm || report.sliceSpacingMm == null) {
    throw new Error("Series is not volume-ready: " + report.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" "));
  }
  const nx = report.cols;
  const ny = report.rows;
  const nz = report.orderedIds.length;
  const data = new Float32Array(nx * ny * nz);
  report.orderedIds.forEach((id, z) => {
    const px = pixelsById.get(id);
    if (!px || px.length !== nx * ny) throw new Error(`Pixel data missing or wrong size for slice ${id}.`);
    data.set(px, z * nx * ny);
  });
  // PixelSpacing is [between rows (y step), between columns (x step)].
  return {
    dims: [nx, ny, nz],
    spacingMm: [report.pixelSpacingMm[1], report.pixelSpacingMm[0], report.sliceSpacingMm],
    data,
  };
}
