/**
 * End-to-end SYNTHETIC ReproTrace workflow (Requirements 1 + 2) on an embedded database:
 * report upload -> extraction -> candidate -> clinician link -> spatial anchor -> live recompute ->
 * registration -> recompute -> clinician decision -> history. Synthetic data only; no clinical accuracy claim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import {
  executeDecideCorrespondence,
  executeRecomputeReproTrace,
  executeRegisterReproTraceDemo,
  executeResolveReportObservation,
  executeSeedReproTraceDemo,
  executeUploadReport,
} from "./server.backend.ts";
import { DEMO_REPORTS } from "./reprotrace-demo.ts";
import { buildEvidenceChain } from "../reports/provenance.ts";

const FILES = [
  "0002_anatomybridge.sql",
  "0003_append_only.sql",
  "0004_menarche_year.sql",
  "0005_report_ingestion.sql",
  "0007_fix_profile_default.sql",
  "0008_clinician_verification.sql",
  "0009_imaging_and_provenance.sql",
  "0010_sprint1_auth_and_registration.sql",
  "0011_sprint3_imaging_storage_and_reprotrace.sql",
  "0012_sprint4_collaboration_and_report_intelligence.sql",
  "0013_sprint5_dicom_and_condition_workflows.sql",
  "0014_supabase_storage_integration.sql",
  "0015_reprotrace_evidence_and_correspondence_runs.sql",
];
const SQL_ALL = FILES.map((f) => readFileSync(new URL(`../../../migrations/${f}`, import.meta.url), "utf8")).join("\n");

const pg = new PGlite();
const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  let q = strings[0];
  for (let i = 0; i < values.length; i += 1) q += `$${i + 1}${strings[i + 1]}`;
  return (await pg.query(q, values as unknown[])).rows;
}) as unknown as Sql;
const rows = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await pg.query(q, p)).rows as T[];

const DR = "dr_demo";
const ready = (async () => {
  await pg.exec(SQL_ALL);
  await pg.exec(`
    insert into profiles (user_id, display_name, role) values ('${DR}', 'Dr Demo', 'clinician'), ('pat_demo', 'Pat', 'patient');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_at)
      values ('cv_d', '${DR}', 'SYN-1', 'SYN-REG', 'synthetic', 'verified', now());
  `);
  await executeSeedReproTraceDemo(sql, DR);
})();

const PID = `${DR}:rtdemo`;
const EX1 = `${DR}:rtdemo-ex1`;
const EX2 = `${DR}:rtdemo-ex2`;
const V1 = `${DR}:rtdemo-f1-v1`;
const V2 = `${DR}:rtdemo-f2-v1`;

async function upload(studyId: string, lines: string[]) {
  const text = lines.join("\n");
  return executeUploadReport(sql, DR, {
    patientId: PID,
    studyId,
    newStudy: null,
    fileName: "synthetic-demo-report.txt",
    fileKind: "txt",
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
    warnings: [],
  });
}

test("demo seed is idempotent, synthetic, spatially anchored, and seeds no correspondence", async () => {
  await ready;
  const again = await executeSeedReproTraceDemo(sql, DR);
  assert.equal(again.created, false);
  const p = (await rows<{ synthetic: boolean }>("select synthetic from patients where id = $1", [PID]))[0];
  assert.equal(p.synthetic, true);
  const v = (await rows<{ frame: string; centroid_mm: string; series_id: string }>("select frame, centroid_mm, series_id from finding_versions where id = $1", [V1]))[0];
  assert.equal(v.frame, "dicom_lps");
  assert.deepEqual(JSON.parse(v.centroid_mm), [6, -4, 0]);
  const c = await rows("select id from correspondences where patient_id = $1", [PID]);
  assert.equal(c.length, 0, "no seeded proposals for the demo patient");
});

test("Req 1: report upload -> strong candidate -> clinician link with full quote provenance", async () => {
  await ready;
  const up = await upload(EX1, DEMO_REPORTS["rtdemo-ex1"]);
  const idx = up.extraction.findings.findIndex((f) => f.structure === "fibroid" && !f.negated);
  assert.ok(idx >= 0);
  const f = up.extraction.findings[idx];
  assert.equal(f.pageNumber, 2, "page provenance from [Page N] marker");

  // Incompatible / unknown target is refused.
  await assert.rejects(
    () => executeResolveReportObservation(sql, DR, { reportId: up.reportId, observationIndex: idx, decision: "link_existing", targetVersionId: "nope", note: "try wrong" }),
    /candidate/,
  );

  const res = await executeResolveReportObservation(sql, DR, {
    reportId: up.reportId,
    observationIndex: idx,
    decision: "link_existing",
    targetVersionId: V1,
    note: "Same anterior FIGO 4 fibroid as segmented on exam 1.",
  });
  assert.equal(res.assessment.state, "strong");
  assert.equal(res.assessment.autoSelected, null);
  assert.equal(res.linkStatus, "spatially_anchored");

  const ev = (await rows<Record<string, unknown>>("select * from evidence_links where id = $1", [res.evidenceLinkId]))[0];
  const body = String((await rows<{ body: string }>("select body from reports where id = $1", [up.reportId]))[0].body);
  assert.equal(body.slice(Number(ev.quote_start), Number(ev.quote_end)), ev.quote);
  assert.equal(ev.page_number, 2);
  assert.equal(ev.review_status, "clinician_verified");
  assert.equal(ev.extraction_id, up.extractionId);

  const decisions = await rows("select * from report_observation_links where report_id = $1", [up.reportId]);
  assert.equal(decisions.length, 1);
  await assert.rejects(() => pg.query("update report_observation_links set note = 'x'"), /append-only/);
});

test("Req 1: leave unlinked and provisional finding are recorded; provisional has no invented coordinates", async () => {
  await ready;
  const up = await upload(EX2, DEMO_REPORTS["rtdemo-ex2"]);
  const idx = up.extraction.findings.findIndex((f) => f.structure === "fibroid");
  const left = await executeResolveReportObservation(sql, DR, { reportId: up.reportId, observationIndex: idx, decision: "leave_unlinked", note: "Defer until imaging reviewed." });
  assert.equal(left.evidenceLinkId, null);
  const prov = await executeResolveReportObservation(sql, DR, { reportId: up.reportId, observationIndex: idx, decision: "create_provisional", note: "Record report-only finding." });
  assert.equal(prov.linkStatus, "report_only");
  const v = (await rows<{ centroid_mm: string | null; frame: string }>("select centroid_mm, frame from finding_versions where id = $1", [prov.findingVersionId]))[0];
  assert.equal(v.centroid_mm, null);
  assert.equal(v.frame, "unavailable");
});

test("Req 1: evidence chain reaches report -> quote -> version -> study -> series -> SOP/slice -> LPS", async () => {
  await ready;
  const ws = {
    reports: await rows("select * from reports"),
    extractions: await rows("select * from report_extractions"),
    evidence: await rows("select * from evidence_links"),
    versions: await rows("select * from finding_versions"),
    findings: await rows("select * from findings"),
    studies: await rows("select * from studies"),
    series: await rows("select * from series"),
    registrations: await rows("select * from registrations"),
  };
  const chain = buildEvidenceChain(ws as never, V1);
  assert.equal(chain.spatialStatus, "spatially_anchored");
  assert.ok(chain.reportLinks.length >= 1);
  assert.equal(chain.imageAnchor?.sopInstanceUid?.endsWith(".1010"), true);
  assert.deepEqual(chain.imageAnchor?.centroidLps, [6, -4, 0]);
});

test("Req 2: live recompute without registration stays uncertain and provisional; never merges", async () => {
  await ready;
  const findingsBefore = (await rows("select id from findings where patient_id = $1", [PID])).length;
  const run = await executeRecomputeReproTrace(sql, DR, PID);
  assert.ok(run.runId);
  const pair = (await rows<Record<string, unknown>>("select * from correspondences where patient_id = $1 and active and from_version_id = $2 and to_version_id = $3", [PID, V1, V2]))[0];
  assert.ok(pair, "exam1 -> exam2 fibroid proposal exists");
  assert.notEqual(pair.category, "likely_same");
  assert.equal(pair.provisional, true);
  assert.equal(pair.registration_status, "missing");
  assert.equal(pair.origin, "live_recompute");
  assert.equal(pair.run_id, run.runId);
  assert.equal(pair.distance_mm, null, "unregistered distance is not presented as valid");
  const runRow = (await rows<Record<string, unknown>>("select * from reprotrace_runs where id = $1", [run.runId]))[0];
  assert.equal(runRow.origin, "live_recompute");
  assert.equal((await rows("select id from findings where patient_id = $1", [PID])).length, findingsBefore);
});

test("Req 2: real registration -> likely same; decisions keep context; recompute is deterministic and non-duplicating", async () => {
  await ready;
  const reg = await executeRegisterReproTraceDemo(sql, DR, PID);
  assert.ok(reg.ncc > 0.5, `ncc ${reg.ncc}`);
  const pair = (await rows<Record<string, unknown>>("select * from correspondences where patient_id = $1 and active and from_version_id = $2 and to_version_id = $3", [PID, V1, V2]))[0];
  assert.equal(pair.category, "likely_same");
  assert.ok(Number(pair.distance_mm) < 12, `registered distance (moment-based prototype; biased by lesion growth) ${pair.distance_mm}`);

  await executeRecomputeReproTrace(sql, DR, PID);
  const a = await rows<{ category: string; score: number }>("select category, score from correspondences where patient_id = $1 and active order by category, score", [PID]);
  await executeRecomputeReproTrace(sql, DR, PID);
  const b = await rows<{ category: string; score: number }>("select category, score from correspondences where patient_id = $1 and active order by category, score", [PID]);
  assert.deepEqual(a, b, "deterministic");

  const cur = (await rows<{ id: string }>("select id from correspondences where patient_id = $1 and active and from_version_id = $2 and to_version_id = $3", [PID, V1, V2]))[0];
  await executeDecideCorrespondence(sql, DR, { correspondenceId: cur.id, decision: "defer", note: "Await second read." });
  await executeDecideCorrespondence(sql, DR, { correspondenceId: cur.id, decision: "accept", note: "Same fibroid." });
  const d = await rows<Record<string, unknown>>("select * from correspondence_decisions where correspondence_id = $1 order by created_at", [cur.id]);
  assert.equal(d.length, 2);
  assert.equal(d[1].engine_version, "reprotrace-rules-1");
  assert.equal(d[1].from_version_id, V1);
  assert.equal(d[1].to_version_id, V2);

  await executeRecomputeReproTrace(sql, DR, PID);
  const same = await rows("select id from correspondences where patient_id = $1 and active and from_version_id = $2 and to_version_id = $3", [PID, V1, V2]);
  assert.equal(same.length, 1, "decided pair is not duplicated");
  const vs = await rows("select id from finding_versions where id in ($1, $2)", [V1, V2]);
  assert.equal(vs.length, 2, "both version histories preserved");
});

test("RBAC: patient cannot recompute or resolve observations", async () => {
  await ready;
  await assert.rejects(() => executeRecomputeReproTrace(sql, "pat_demo", PID), /Unauthorized/);
  await assert.rejects(
    () => executeResolveReportObservation(sql, "pat_demo", { reportId: "x", observationIndex: 0, decision: "leave_unlinked", note: "nope" }),
    /Unauthorized/,
  );
});
