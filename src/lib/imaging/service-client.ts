/**
 * Client for the optional Python imaging service (imaging-service/, FastAPI).
 *
 * Scope: a SECOND, independent geometry check of the same DICOM series. The browser
 * check (series.ts, via dicom-parser) and the service check (pydicom + numpy) were
 * written separately. Where they disagree, both answers are shown. Nothing here picks
 * a winner, repairs a series, or changes what the Volume lab does.
 *
 * The web app keeps working when the service is absent: every function returns a
 * typed failure instead of throwing, and the UI hides the send button unless an
 * operator configured VITE_IMAGING_SERVICE_URL.
 */
import type { SeriesReport } from "./series.ts";

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

/** Configured bearer token or API key for authenticating with the imaging service.
 *
 * @deprecated Direct browser-to-service calls with a token are superseded by the server-side
 * proxy at /api/imaging-proxy/*. This function is kept so that existing callers that pass an
 * explicit `token` argument (e.g. tests or the /health check from an operator admin page) still
 * work, but it NO LONGER reads VITE_IMAGING_SERVICE_TOKEN from the environment — that variable
 * should be removed from deployments. The proxy reads ANATOMYBRIDGE_SERVICE_API_KEY from
 * server-side process.env, which is never inlined into the browser bundle.
 */
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
    const message = (p as Record<string, unknown>).message;
    if (typeof code !== "string") return null;
    problems.push({ code, message: typeof message === "string" ? message : "" });
  }
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
  };
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
