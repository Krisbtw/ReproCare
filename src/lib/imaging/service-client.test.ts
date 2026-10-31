import test from "node:test";
import assert from "node:assert/strict";
import {
  checkHealth,
  compareReports,
  inspectWithService,
  parseServiceReport,
  serviceUrl,
  SERVICE_MAX_FILES,
  type ServiceSeriesReport,
} from "./service-client.ts";
import type { SeriesReport } from "./series.ts";

const browser = (over: Partial<SeriesReport> = {}): SeriesReport => ({
  orderedIds: Array.from({ length: 12 }, (_, i) => `s${i}`),
  spatiallyOrdered: true,
  normal: [0, 0, 1],
  sliceSpacingMm: 3,
  pixelSpacingMm: [1, 1],
  rows: 32,
  cols: 32,
  issues: [],
  volumeReady: true,
  ...over,
});

const service = (over: Partial<ServiceSeriesReport> = {}): ServiceSeriesReport => ({
  n_files: 12,
  n_readable: 12,
  n_unreadable: 0,
  series_uids: 1,
  slice_count: 12,
  rows: 32,
  columns: 32,
  pixel_spacing_mm: [1, 1],
  slice_spacing_mm: 3,
  problems: [],
  safe_metadata: { Modality: "MR" },
  volume_ready: true,
  ...over,
});

test("serviceUrl accepts http(s) only, strips trailing slash, refuses credentials", () => {
  assert.equal(serviceUrl("http://localhost:8100/"), "http://localhost:8100");
  assert.equal(serviceUrl(" https://img.example.org/api// "), "https://img.example.org/api");
  for (const bad of ["", "   ", null, undefined, "ftp://x", "javascript:alert(1)", "not a url", "http://u:p@host"]) {
    assert.equal(serviceUrl(bad as string | null), null, String(bad));
  }
});

test("parseServiceReport rejects malformed bodies instead of trusting them", () => {
  assert.equal(parseServiceReport(null), null);
  assert.equal(parseServiceReport({}), null);
  assert.equal(parseServiceReport({ volume_ready: "yes", slice_count: 3, problems: [] }), null);
  assert.equal(parseServiceReport({ volume_ready: true, slice_count: 3, problems: [{ message: "no code" }] }), null);
  const ok = parseServiceReport({ volume_ready: true, slice_count: 3, problems: [], pixel_spacing_mm: [0.7, "x"] });
  assert.ok(ok);
  assert.equal(ok?.pixel_spacing_mm, null);
});

test("identical answers: every comparable row agrees", () => {
  const c = compareReports(browser(), 12, service());
  assert.equal(c.comparable, c.agreeing);
  assert.ok(c.comparable >= 5);
  assert.match(c.summary, /agree on all/);
});

test("tiny float noise in spacing still agrees; a real difference does not", () => {
  assert.equal(compareReports(browser(), 12, service({ slice_spacing_mm: 3.0004 })).agreeing, compareReports(browser(), 12, service()).agreeing);
  const off = compareReports(browser(), 12, service({ slice_spacing_mm: 3.5 }));
  const row = off.rows.find((r) => r.item.startsWith("Slice spacing"));
  assert.equal(row?.agree, false);
  assert.match(off.summary, /disagree on 1 of/);
});

test("gap flagged by both maps browser missing_slices to service slice_gap and agrees", () => {
  const b = browser({ volumeReady: false, issues: [{ code: "missing_slices", severity: "error", message: "gap", sliceIds: ["s5"] }] });
  const s = service({ volume_ready: false, slice_count: 11, problems: [{ code: "slice_gap", message: "gap" }] });
  const c = compareReports(b, 11, s);
  const row = c.rows.find((r) => r.item === "Problem: missing slices");
  assert.equal(row?.agree, true);
  assert.equal(c.rows.find((r) => r.item === "Volume ready")?.agree, true);
});

test("one-sided flag is shown as a disagreement with a note, never resolved", () => {
  const b = browser({ volumeReady: false, issues: [{ code: "duplicate_position", severity: "error", message: "dup", sliceIds: [] }] });
  const c = compareReports(b, 12, service());
  const row = c.rows.find((r) => r.item === "Problem: duplicate position");
  assert.equal(row?.agree, false);
  assert.ok(row?.note);
  assert.match(c.summary, /neither is chosen/);
});

test("checks without an equivalent are listed as not comparable", () => {
  const b = browser({ issues: [{ code: "thickness_spacing_mismatch", severity: "warning", message: "w", sliceIds: [] }] });
  const s = service({ volume_ready: false, problems: [{ code: "unreadable_files", message: "2 file(s)" }] });
  const c = compareReports(b, 12, s);
  assert.equal(c.rows.find((r) => r.item.startsWith("Browser only"))?.agree, null);
  assert.equal(c.rows.find((r) => r.item.startsWith("Service only"))?.agree, null);
});

test("different slice counts are flagged with an honest reason", () => {
  const c = compareReports(browser(), 10, service());
  const row = c.rows.find((r) => r.item.startsWith("Slices"));
  assert.equal(row?.agree, false);
  assert.match(row?.note ?? "", /compressed/);
});

const fakeResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("inspectWithService: sends neutral file names, parses the report", async () => {
  let seenNames: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    assert.equal(url, "http://svc/series/inspect");
    const form = init?.body as FormData;
    seenNames = form.getAll("files").map((f) => (f as File).name);
    return fakeResponse(200, service());
  };
  const r = await inspectWithService("http://svc", [{ name: "DOE_JANE/IM0001", bytes: new Uint8Array([1, 2]) }, { name: "DOE_JANE/IM0002", bytes: new Uint8Array([3]) }], fetchImpl);
  assert.ok(r.ok);
  assert.deepEqual(seenNames, ["slice-0000.dcm", "slice-0001.dcm"]);
  assert.ok(!seenNames.join("").includes("DOE"));
});

test("inspectWithService: refuses over-limit batches before any network call", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeResponse(200, service());
  };
  const many = Array.from({ length: SERVICE_MAX_FILES + 1 }, (_, i) => ({ name: String(i), bytes: new Uint8Array(1) }));
  const r = await inspectWithService("http://svc", many, fetchImpl);
  assert.equal(r.ok, false);
  assert.equal(called, false);
  assert.equal((await inspectWithService("http://svc", [], fetchImpl)).ok, false);
});

test("inspectWithService: HTTP error, bad shape, network failure and timeout all return typed errors", async () => {
  const one = [{ name: "a", bytes: new Uint8Array(1) }];
  const e1 = await inspectWithService("http://svc", one, async () => fakeResponse(413, { detail: "A file exceeds the size limit." }));
  assert.ok(!e1.ok && /413/.test(e1.error) && /size limit/.test(e1.error));
  const e2 = await inspectWithService("http://svc", one, async () => fakeResponse(200, { hello: 1 }));
  assert.ok(!e2.ok && /expected shape/.test(e2.error));
  const e3 = await inspectWithService("http://svc", one, async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.ok(!e3.ok && /CORS_ORIGINS/.test(e3.error));
  const e4 = await inspectWithService(
    "http://svc",
    one,
    (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    20,
  );
  assert.ok(!e4.ok && /in time/.test(e4.error));
});

test("checkHealth validates the shape", async () => {
  const ok = await checkHealth("http://svc", async () => fakeResponse(200, { status: "ok", service: "anatomybridge-imaging", any_model_connected: false }));
  assert.ok(ok.ok && ok.value.any_model_connected === false);
  const bad = await checkHealth("http://svc", async () => fakeResponse(200, { status: "ok" }));
  assert.equal(bad.ok, false);
});
