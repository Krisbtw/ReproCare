/**
 * Client for the optional Python imaging service (imaging-service/, FastAPI).
 *
 * Scope:
 *   1. Independent geometry cross-check of a DICOM series (`/series/inspect`).
 *   2. Runtime validation and medical-image geometry alignment verification of AI
 *      segmentation responses (`/segment/{model_id}`) so Volume Lab never accepts or
 *      displays a mask whose dimensions, voxel spacing, origin, orientation, or
 *      coordinate frame disagree with the source MRI scan.
 */
import type { SeriesReport } from "./series.ts";
import type { Mask, Vec3 } from "./volume.ts";

export const SERVICE_MAX_FILES = 1000; // imaging-service/app/main.py MAX_FILES
export const SERVICE_MAX_BYTES_EACH = 64 * 1024 * 1024; // MAX_BYTES_EACH
export const SERVICE_TIMEOUT_MS = 60_000;

export type ServiceProblem = { code: string; message: string };

export type ServiceSeriesReport = {
  n_files: number;
  n_readable: number;
  n_unreadable: number;
  series_uids: number;
  slice_count: number;
  rows: number | null;
  columns: number | null;
  pixel_spacing_mm: [number, number] | null;
  slice_spacing_mm: number | null;
  problems: ServiceProblem[];
  safe_metadata: Record<string, unknown>;
  volume_ready: boolean;
  origin_lps_mm?: [number, number, number] | null;
  direction_cosines?: number[] | null;
  frame_of_reference_uid?: string | null;
};

export type ServiceHealth = { status: string; service: string; any_model_connected: boolean };

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Accepts only an absolute http(s) URL. Returns it without a trailing slash, or null. */
export function serviceUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null; // never put credentials in a URL
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Configured bearer token or API key for authenticating with the imaging service. */
export function serviceToken(raw?: string | null | undefined): string | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t.length > 0 ? t : null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);

/** Runtime shape check of /series/inspect output. Returns null rather than trusting a malformed body. */
export function parseServiceReport(json: unknown): ServiceSeriesReport | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (typeof j.volume_ready !== "boolean" || !isNum(j.slice_count) || !Array.isArray(j.problems)) return null;
  const ps = j.pixel_spacing_mm;
  const pixel = Array.isArray(ps) && ps.length === 2 && isNum(ps[0]) && isNum(ps[1]) ? ([ps[0], ps[1]] as [number, number]) : null;
  const problems: ServiceProblem[] = [];
  for (const p of j.problems) {
    if (!p || typeof p !== "object") return null;
    const code = (p as Record<string, unknown>).code;
    const message = (p as Record<string, unknown>).message ?? (p as Record<string, unknown>).detail;
    if (typeof code !== "string") return null;
    problems.push({ code, message: typeof message === "string" ? message : "" });
  }
  const orig = j.origin_lps_mm;
  const originLps =
    Array.isArray(orig) && orig.length === 3 && isNum(orig[0]) && isNum(orig[1]) && isNum(orig[2])
      ? ([orig[0], orig[1], orig[2]] as [number, number, number])
      : null;
  const dir = j.direction_cosines;
  const dirCosines =
    Array.isArray(dir) && (dir.length === 6 || dir.length === 9) && dir.every(isNum) ? (dir as number[]) : null;

  return {
    n_files: numOrNull(j.n_files) ?? 0,
    n_readable: numOrNull(j.n_readable) ?? 0,
    n_unreadable: numOrNull(j.n_unreadable) ?? 0,
    series_uids: numOrNull(j.series_uids) ?? 0,
    slice_count: j.slice_count,
    rows: numOrNull(j.rows),
    columns: numOrNull(j.columns),
    pixel_spacing_mm: pixel,
    slice_spacing_mm: numOrNull(j.slice_spacing_mm),
    problems,
    safe_metadata: j.safe_metadata && typeof j.safe_metadata === "object" ? (j.safe_metadata as Record<string, unknown>) : {},
    volume_ready: j.volume_ready,
    origin_lps_mm: originLps,
    direction_cosines: dirCosines,
    frame_of_reference_uid: typeof j.frame_of_reference_uid === "string" ? j.frame_of_reference_uid : null,
  };
}

/* ------------------------------------------------------------------ */
/* AI Segmentation Response & Geometry Alignment Validation            */
/* ------------------------------------------------------------------ */

export type ParsedSegmentationResponse = {
  modelId: string;
  modelName: string;
  isLearnedModel: boolean;
  architecture: string;
  modelVersion: string | null;
  datasetVersion: string | null;
  checkpointSha256: string | null;
  trainingMode: string | null;
  isClinicalGrade: boolean;
  shapeZyx: [number, number, number];
  spacingZyxMm: [number, number, number];
  originLpsMm: [number, number, number] | null;
  directionCosines: number[] | null;
  frameOfReferenceUid: string | null;
  labels: Record<string, string>;
  maskB64Zlib: string;
  note: string;
};

export type SourceScanGeometry = {
  dims: Vec3; // [nx, ny, nz]
  spacingMm: Vec3; // [dx, dy, dz]
  originLpsMm?: Vec3 | null;
  directionCosines?: number[] | null; // 6 or 9 elements (rowCosines, colCosines[, normal])
  frameOfReferenceUid?: string | null;
};

export type GeometryAlignmentCheck = {
  aligned: boolean;
  problems: string[];
};

/**
 * Parse and validate the JSON payload returned by `/segment/{model_id}` (both new and legacy field shapes).
 */
export function parseSegmentationResponse(raw: unknown): ParsedSegmentationResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;

  const shape = j.shape_zyx;
  if (
    !Array.isArray(shape) ||
    shape.length !== 3 ||
    !isNum(shape[0]) ||
    !isNum(shape[1]) ||
    !isNum(shape[2]) ||
    shape[0] <= 0 ||
    shape[1] <= 0 ||
    shape[2] <= 0
  ) {
    return null;
  }

  const sp = j.spacing_zyx_mm;
  if (
    !Array.isArray(sp) ||
    sp.length !== 3 ||
    !isNum(sp[0]) ||
    !isNum(sp[1]) ||
    !isNum(sp[2]) ||
    sp[0] <= 0 ||
    sp[1] <= 0 ||
    sp[2] <= 0
  ) {
    return null;
  }

  const maskStr =
    typeof j.mask_b64_zlib === "string" && j.mask_b64_zlib.length > 0
      ? j.mask_b64_zlib
      : typeof j.mask === "string" && j.mask.length > 0
        ? j.mask
        : null;
  if (!maskStr) return null;

  const rawLabels = (j.labels ?? j.label_map) as Record<string, unknown> | undefined;
  const labels: Record<string, string> = {};
  if (rawLabels && typeof rawLabels === "object") {
    for (const [k, v] of Object.entries(rawLabels)) {
      if (typeof v === "string") labels[String(k)] = v;
    }
  }
  if (Object.keys(labels).length === 0) return null;

  const modelObj = (j.model && typeof j.model === "object" ? j.model : {}) as Record<string, unknown>;
  const provObj = (j.provenance && typeof j.provenance === "object" ? j.provenance : {}) as Record<string, unknown>;

  const modelId =
    typeof modelObj.id === "string"
      ? modelObj.id
      : typeof j.model_id === "string"
        ? j.model_id
        : "umd_monai_fibroid";
  const modelName =
    typeof modelObj.name === "string"
      ? modelObj.name
      : typeof provObj.model_name === "string"
        ? provObj.model_name
        : modelId;
  const architecture =
    typeof modelObj.architecture === "string"
      ? modelObj.architecture
      : typeof provObj.architecture === "string"
        ? provObj.architecture
        : "SimpleUnet3D (custom 3D U-Net)";
  const modelVersion =
    typeof modelObj.model_version === "string"
      ? modelObj.model_version
      : typeof provObj.model_version === "string"
        ? provObj.model_version
        : null;
  const datasetVersion =
    typeof modelObj.dataset_version === "string"
      ? modelObj.dataset_version
      : typeof provObj.dataset_version === "string"
        ? provObj.dataset_version
        : null;
  const checkpointSha256 =
    typeof modelObj.checkpoint_sha256 === "string"
      ? modelObj.checkpoint_sha256
      : typeof provObj.checkpoint_sha256 === "string"
        ? provObj.checkpoint_sha256
        : null;
  const trainingMode =
    typeof modelObj.training_mode === "string"
      ? modelObj.training_mode
      : typeof provObj.training_mode === "string"
        ? provObj.training_mode
        : null;
  const isClinicalGrade = Boolean(modelObj.is_clinical_grade ?? provObj.is_clinical_grade ?? false);

  const orig = j.origin_lps_mm;
  const originLpsMm: [number, number, number] | null =
    Array.isArray(orig) && orig.length === 3 && isNum(orig[0]) && isNum(orig[1]) && isNum(orig[2])
      ? [orig[0], orig[1], orig[2]]
      : null;

  const dir = j.direction_cosines;
  const directionCosines: number[] | null =
    Array.isArray(dir) && (dir.length === 6 || dir.length === 9) && dir.every(isNum) ? (dir as number[]) : null;

  const frameOfReferenceUid =
    typeof j.frame_of_reference_uid === "string" && j.frame_of_reference_uid.trim()
      ? j.frame_of_reference_uid.trim()
      : null;

  const note =
    typeof j.note === "string" && j.note.trim()
      ? j.note.trim()
      : `Experimental learned model output (${architecture}). Not clinically validated; requires clinician verification.`;

  return {
    modelId,
    modelName,
    isLearnedModel: Boolean(modelObj.is_learned_model ?? true),
    architecture,
    modelVersion,
    datasetVersion,
    checkpointSha256,
    trainingMode,
    isClinicalGrade,
    shapeZyx: [Math.round(shape[0]), Math.round(shape[1]), Math.round(shape[2])],
    spacingZyxMm: [sp[0], sp[1], sp[2]],
    originLpsMm,
    directionCosines,
    frameOfReferenceUid,
    labels,
    maskB64Zlib: maskStr,
    note,
  };
}

/**
 * Validate that a returned AI segmentation mask aligns with the source MRI scan's
 * dimensions, voxel spacing, origin, orientation cosines, and coordinate frame.
 */
export function validateSegmentationGeometryAlignment(
  source: SourceScanGeometry,
  seg: ParsedSegmentationResponse,
): GeometryAlignmentCheck {
  const problems: string[] = [];
  const [nz, ny, nx] = seg.shapeZyx;
  const [dz, dy, dx] = seg.spacingZyxMm;

  if (source.dims[0] !== nx || source.dims[1] !== ny || source.dims[2] !== nz) {
    problems.push(
      `Dimension mismatch: source scan is [${source.dims.join(", ")}] (X, Y, Z), but segmentation mask is [${nx}, ${ny}, ${nz}].`,
    );
  }

  const spTol = 0.02;
  if (
    Math.abs(source.spacingMm[0] - dx) > spTol ||
    Math.abs(source.spacingMm[1] - dy) > spTol ||
    Math.abs(source.spacingMm[2] - dz) > spTol
  ) {
    problems.push(
      `Voxel spacing mismatch: source scan is [${source.spacingMm.map((v) => v.toFixed(3)).join(", ")}] mm, ` +
        `but segmentation mask is [${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)}] mm.`,
    );
  }

  if (source.originLpsMm && seg.originLpsMm) {
    const origTol = 0.25; // mm
    const maxDiff = Math.max(
      Math.abs(source.originLpsMm[0] - seg.originLpsMm[0]),
      Math.abs(source.originLpsMm[1] - seg.originLpsMm[1]),
      Math.abs(source.originLpsMm[2] - seg.originLpsMm[2]),
    );
    if (maxDiff > origTol) {
      problems.push(
        `Origin mismatch: source scan origin [${source.originLpsMm.map((v) => v.toFixed(2)).join(", ")}] mm ` +
          `differs from segmentation origin [${seg.originLpsMm.map((v) => v.toFixed(2)).join(", ")}] mm.`,
      );
    }
  }

  if (source.directionCosines && seg.directionCosines) {
    const nCmp = Math.min(6, source.directionCosines.length, seg.directionCosines.length);
    for (let i = 0; i < nCmp; i++) {
      if (Math.abs(source.directionCosines[i] - seg.directionCosines[i]) > 0.02) {
        problems.push("Orientation mismatch: direction cosines of segmentation mask disagree with source MRI scan.");
        break;
      }
    }
  }

  if (
    source.frameOfReferenceUid &&
    seg.frameOfReferenceUid &&
    source.frameOfReferenceUid !== seg.frameOfReferenceUid
  ) {
    problems.push(
      `Coordinate frame mismatch: FrameOfReferenceUID '${seg.frameOfReferenceUid}' != '${source.frameOfReferenceUid}'.`,
    );
  }

  return { aligned: problems.length === 0, problems };
}

/**
 * Extract a binary `Mask` for a specific class (`targetClass === 0` selects all foreground `> 0`,
 * otherwise selects `label === targetClass`) from a decompressed multi-class label volume.
 */
export function extractClassMaskFromVolume(
  decompressedLabels: Uint8Array,
  shapeZyx: [number, number, number],
  spacingZyxMm: [number, number, number],
  targetClass: number,
  allowedLabels?: Record<string, string>,
): { mask: Mask; voxelCount: number; classVoxelCounts: Record<string, number> } {
  const [nz, ny, nx] = shapeZyx;
  const expectedLength = nx * ny * nz;
  if (decompressedLabels.length !== expectedLength) {
    throw new Error(
      `Decompressed segmentation buffer length (${decompressedLabels.length}) does not match volume dimensions ${nx}×${ny}×${nz} (${expectedLength}).`,
    );
  }

  const allowedSet = allowedLabels
    ? new Set(Object.keys(allowedLabels).map((k) => Number(k)))
    : null;

  const maskData = new Uint8Array(expectedLength);
  let targetCount = 0;
  const classVoxelCounts: Record<string, number> = {};

  for (let i = 0; i < expectedLength; i++) {
    const val = decompressedLabels[i];
    if (allowedSet && !allowedSet.has(val)) {
      throw new Error(`Predicted segmentation contains unknown label value ${val}.`);
    }
    const key = String(val);
    classVoxelCounts[key] = (classVoxelCounts[key] ?? 0) + 1;
    const match = targetClass === 0 ? (val > 0 ? 1 : 0) : val === targetClass ? 1 : 0;
    maskData[i] = match;
    if (match) targetCount++;
  }

  const mask: Mask = {
    dims: [nx, ny, nz],
    spacingMm: [spacingZyxMm[2], spacingZyxMm[1], spacingZyxMm[0]],
    data: maskData,
  };

  return { mask, voxelCount: targetCount, classVoxelCounts };
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

/** Browser issue code -> service problem code, only where both check the same thing. */
export const COMPARABLE_CODES: Record<string, string> = {
  mixed_series: "mixed_series",
  mixed_matrix: "mixed_matrix",
  mixed_pixel_spacing: "mixed_pixel_spacing",
  mixed_orientation: "mixed_orientation",
  duplicate_position: "duplicate_positions",
  missing_slices: "slice_gap",
};

export type CrossCheckRow = {
  item: string;
  browser: string;
  service: string;
  /** null = not comparable (one side cannot say). */
  agree: boolean | null;
  note?: string;
};

export type CrossCheck = {
  rows: CrossCheckRow[];
  comparable: number;
  agreeing: number;
  summary: string;
};

const SPACING_ABS_TOL = 1e-3;
const SPACING_REL_TOL = 0.005;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(SPACING_ABS_TOL, SPACING_REL_TOL * Math.max(Math.abs(a), Math.abs(b)));
const mm = (n: number | null | undefined, d = 3) => (n == null ? "n/a" : `${n.toFixed(d)} mm`);

/**
 * Compares the browser report with the service report for the same files.
 * `browserSlicesRead` = slices the browser could read geometry for (decoded, uncompressed).
 */
export function compareReports(browser: SeriesReport, browserSlicesRead: number, service: ServiceSeriesReport): CrossCheck {
  const rows: CrossCheckRow[] = [];
  const add = (item: string, b: string, s: string, agree: boolean | null, note?: string) => rows.push({ item, browser: b, service: s, agree, ...(note ? { note } : {}) });

  add("Volume ready", browser.volumeReady ? "yes" : "no", service.volume_ready ? "yes" : "no", browser.volumeReady === service.volume_ready);

  const sliceNote =
    browserSlicesRead !== service.slice_count
      ? "Counts can differ for honest reasons: the browser skips compressed files and the service skips files without position and orientation."
      : undefined;
  add("Slices with usable geometry", String(browserSlicesRead), String(service.slice_count), browserSlicesRead === service.slice_count, sliceNote);

  if (browser.rows && service.rows != null && service.columns != null) {
    add("Matrix (columns × rows)", `${browser.cols} × ${browser.rows}`, `${service.columns} × ${service.rows}`, browser.cols === service.columns && browser.rows === service.rows);
  } else {
    add("Matrix (columns × rows)", browser.rows ? `${browser.cols} × ${browser.rows}` : "n/a", service.rows != null ? `${service.columns} × ${service.rows}` : "n/a", null, "One side did not report a matrix.");
  }

  const bp = browser.pixelSpacingMm;
  const sp = service.pixel_spacing_mm;
  if (bp && sp) {
    add("Pixel spacing (row, column)", `${mm(bp[0])}, ${mm(bp[1])}`, `${mm(sp[0])}, ${mm(sp[1])}`, close(bp[0], sp[0]) && close(bp[1], sp[1]));
  } else {
    add("Pixel spacing (row, column)", bp ? `${mm(bp[0])}, ${mm(bp[1])}` : "n/a", sp ? `${mm(sp[0])}, ${mm(sp[1])}` : "n/a", null, "One side has no pixel spacing.");
  }

  const bs = browser.sliceSpacingMm;
  const ss = service.slice_spacing_mm;
  if (bs != null && ss != null) {
    add("Slice spacing (median)", mm(bs), mm(ss), close(bs, ss));
  } else {
    add("Slice spacing (median)", mm(bs), mm(ss), null, "One side could not order the slices.");
  }

  const browserCodes = new Set(browser.issues.filter((i) => i.severity === "error").map((i) => i.code as string));
  const serviceCodes = new Set(service.problems.map((p) => p.code));
  for (const [bCode, sCode] of Object.entries(COMPARABLE_CODES)) {
    const b = browserCodes.has(bCode);
    const s = serviceCodes.has(sCode);
    if (!b && !s) continue; // both silent: nothing to show
    add(`Problem: ${bCode.replaceAll("_", " ")}`, b ? "flagged" : "not flagged", s ? "flagged" : "not flagged", b === s,
      b !== s ? "The two checks use different tolerances. Look at the slices before trusting either." : undefined);
  }
  const mappedService = new Set(Object.values(COMPARABLE_CODES));
  for (const p of service.problems) {
    if (!mappedService.has(p.code)) add(`Service only: ${p.code.replaceAll("_", " ")}`, "no equivalent check", p.message || "flagged", null);
  }
  const mappedBrowser = new Set(Object.keys(COMPARABLE_CODES));
  for (const i of browser.issues) {
    if (!mappedBrowser.has(i.code)) add(`Browser only: ${i.code.replaceAll("_", " ")}`, i.severity === "error" ? "flagged (blocks)" : "noted", "no equivalent check", null);
  }

  const comparable = rows.filter((r) => r.agree !== null).length;
  const agreeing = rows.filter((r) => r.agree === true).length;
  const summary =
    comparable === 0
      ? "Nothing could be compared."
      : agreeing === comparable
        ? `The browser and the service agree on all ${comparable} comparable items.`
        : `The browser and the service disagree on ${comparable - agreeing} of ${comparable} comparable items. Both answers are shown; neither is chosen automatically.`;
  return { rows, comparable, agreeing, summary };
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function networkError(e: unknown, base: string): string {
  if (e instanceof DOMException && e.name === "AbortError") return "The imaging service did not answer in time.";
  return `Could not reach the imaging service at ${base}. Is it running, and does ANATOMYBRIDGE_CORS_ORIGINS include this site?`;
}

async function detailOf(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (j.detail && typeof j.detail === "object") return JSON.stringify(j.detail).slice(0, 300);
  } catch {
    /* body was not JSON */
  }
  return res.statusText || "no detail";
}

export async function checkHealth(
  base: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 8000,
  token?: string | null,
): Promise<ServiceResult<ServiceHealth>> {
  const authToken = serviceToken(token);
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(`${base}/health`, { method: "GET", headers, signal });
      if (!res.ok) return { ok: false, error: `Service answered ${res.status}: ${await detailOf(res)}` };
      const j = (await res.json()) as Partial<ServiceHealth>;
      if (typeof j.status !== "string" || typeof j.any_model_connected !== "boolean") return { ok: false, error: "The service answered, but not with the expected health shape." };
      return { ok: true, value: { status: j.status, service: String(j.service ?? ""), any_model_connected: j.any_model_connected } };
    });
  } catch (e) {
    return { ok: false, error: networkError(e, base) };
  }
}

export async function inspectWithService(
  base: string,
  files: { name: string; bytes: Uint8Array }[],
  fetchImpl: FetchLike = fetch,
  timeoutMs = SERVICE_TIMEOUT_MS,
  token?: string | null,
): Promise<ServiceResult<ServiceSeriesReport>> {
  if (files.length === 0) return { ok: false, error: "No files to send." };
  if (files.length > SERVICE_MAX_FILES) return { ok: false, error: `The service accepts at most ${SERVICE_MAX_FILES} files per request; this series has ${files.length}.` };
  const big = files.find((f) => f.bytes.byteLength > SERVICE_MAX_BYTES_EACH);
  if (big) return { ok: false, error: `${big.name} is larger than the service limit (${SERVICE_MAX_BYTES_EACH / 1024 / 1024} MB).` };
  const form = new FormData();
  files.forEach((f, i) => {
    // Send a neutral file name: the original path can contain a patient name.
    const copy = new Uint8Array(f.bytes.byteLength);
    copy.set(f.bytes);
    form.append("files", new Blob([copy.buffer], { type: "application/dicom" }), `slice-${String(i).padStart(4, "0")}.dcm`);
  });
  const authToken = serviceToken(token);
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(`${base}/series/inspect`, { method: "POST", headers, body: form, signal });
      if (!res.ok) return { ok: false, error: `Service answered ${res.status}: ${await detailOf(res)}` };
      const parsed = parseServiceReport(await res.json());
      if (!parsed) return { ok: false, error: "The service answered, but the report was not in the expected shape. It was not used." };
      return { ok: true, value: parsed };
    });
  } catch (e) {
    return { ok: false, error: networkError(e, base) };
  }
}
