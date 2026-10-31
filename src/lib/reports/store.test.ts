import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { ingestReport, linkReportQuote, validateIngest, type IngestInput } from "./store.ts";
import { SAMPLE_REPORT_LINES } from "./fixtures.ts";
import type { Sql } from "../db.ts";

const mig = (n: string) => readFileSync(new URL(`../../../migrations/${n}`, import.meta.url), "utf8");

// One embedded database for the whole file: PGlite start-up is the slow part in small sandboxes.
const pg = new PGlite();
const ready = (async () => {
  await pg.exec(mig("0002_anatomybridge.sql"));
  await pg.exec(mig("0005_report_ingestion.sql"));
  await pg.exec(`
    insert into patients (id,user_id,code,display_name,pathway,synopsis) values ('p1','u1','S-1','Synthetic','fibroids','x'), ('p2','u1','S-2','Other','pcos','y'), ('px','u2','S-9','Not mine','pcos','z');
    insert into studies (id,user_id,patient_id,modality,study_date,description,accession,source_note) values ('s1','u1','p1','MR','2025-01-02','d','a','n');
    insert into findings (id,user_id,patient_id,code,structure,organ,pathway) values ('f1','u1','p1','F1','fibroid','uterus','fibroids'), ('f2','u1','p2','F2','follicles','ovary','pcos');
    insert into finding_versions (id,user_id,finding_id,version_no,study_id,observed_on,location_label,longest_mm,measurement_basis,frame,segmentation_source,quality,modality,change_reason)
      values ('v1','u1','f1',1,'s1','2025-01-02','anterior wall',50,'b','schematic','demonstration_geometry','adequate','MR','seed'),
             ('v2','u1','f2',1,'s1','2025-01-02','left ovary',null,'b','schematic','demonstration_geometry','adequate','US','seed');
  `);
})();
const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
  return (await pg.query(text, values as unknown[])).rows;
}) as unknown as Sql;

const base: IngestInput = {
  patientId: "p1",
  studyId: null,
  newStudy: { modality: "MR", date: "2026-03-14", description: "Follow-up MRI (uploaded report)" },
  fileName: "follow-up.pdf",
  fileKind: "pdf",
  sha256: "a".repeat(64),
  // Deliberately NOT de-identified, to prove the server pass removes identifiers itself.
  text: SAMPLE_REPORT_LINES.join("\n"),
  warnings: [],
};

test("ingest: creates study + report, server de-identifies, stores extraction with provenance", async () => {
  await ready;
  const res = await ingestReport(sql, "u1", base);
  const rep = (await pg.query("select * from reports where id = $1", [res.reportId])).rows[0] as Record<string, unknown>;
  const body = String(rep.body);
  assert.equal(body.includes("Synthetic Example"), false);
  assert.equal(body.includes("SYN-000123"), false);
  assert.equal(body.includes("A. Example"), false);
  assert.match(body, /5\.6 x 4\.2 x 3\.3 cm, FIGO 4/);
  assert.equal(rep.source_kind, "uploaded");
  assert.equal(rep.synthetic, false);
  assert.equal(String(rep.report_date).slice(0, 10) === "2026-03-14" || rep.report_date instanceof Date, true);
  const ex = (await pg.query("select * from report_extractions where id = $1", [res.extractionId])).rows[0] as Record<string, unknown>;
  assert.equal(ex.extractor, "anatomybridge-report-rules-1");
  assert.equal(ex.deid_method, "anatomybridge-deid-rules-1");
  assert.ok(Number(ex.redaction_count) >= 3);
  assert.equal(String(ex.redaction_kinds).includes("Synthetic Example"), false);
  const parsed = JSON.parse(String(ex.extraction));
  assert.equal(parsed.examDate, "2026-03-14");
  assert.equal(parsed.measurements[0].text, "5.6 x 4.2 x 3.3 cm");
  assert.equal(body.slice(parsed.measurements[0].start, parsed.measurements[0].end), "5.6 x 4.2 x 3.3 cm");
  const st = (await pg.query("select * from studies where id = $1", [res.studyId])).rows[0] as Record<string, unknown>;
  assert.equal(st.patient_id, "p1");
  assert.equal(st.synthetic, false);
});

test("ingest: refuses other users' records, foreign studies, bad hashes, both/neither study choice", async () => {
  await ready;
  await assert.rejects(() => ingestReport(sql, "u1", { ...base, patientId: "px" }), /Record not found/);
  await assert.rejects(() => ingestReport(sql, "u1", { ...base, patientId: "p2", studyId: "s1", newStudy: null }), /not part of this record/);
  assert.throws(() => validateIngest({ ...base, sha256: "xyz" }), /fingerprint/);
  assert.throws(() => validateIngest({ ...base, studyId: "s1" }), /one existing study/);
  assert.throws(() => validateIngest({ ...base, newStudy: null }), /one existing study/);
  assert.throws(() => validateIngest({ ...base, newStudy: { modality: "MR", date: "2026-02-30", description: "" } }), /real date/);
  assert.throws(() => validateIngest({ ...base, text: "short" }), /too short/);
});

test("link: verified quote is appended as evidence; version row untouched", async () => {
  await ready;
  const res = await ingestReport(sql, "u1", base);
  const body = String(((await pg.query("select body from reports where id = $1", [res.reportId])).rows[0] as { body: string }).body);
  const quote = "5.6 x 4.2 x 3.3 cm, FIGO 4";
  const start = body.indexOf(quote);
  const id = await linkReportQuote(sql, "u1", { findingVersionId: "v1", reportId: res.reportId, start, end: start + quote.length, quote, note: "" });
  const ev = (await pg.query("select * from evidence_links where id = $1", [id])).rows[0] as Record<string, unknown>;
  assert.equal(ev.kind, "report_quote");
  assert.equal(ev.quote, quote);
  assert.equal(ev.quote_start, start);
  assert.equal(ev.study_id, res.studyId);
  const v = (await pg.query("select longest_mm, change_reason from finding_versions where id = 'v1'")).rows[0] as Record<string, unknown>;
  assert.equal(Number(v.longest_mm), 50);
  assert.equal(v.change_reason, "seed");
});

test("link: mismatched offsets, cross-patient and cross-user are refused", async () => {
  await ready;
  const res = await ingestReport(sql, "u1", base);
  const body = String(((await pg.query("select body from reports where id = $1", [res.reportId])).rows[0] as { body: string }).body);
  const quote = "FIGO 4";
  const start = body.indexOf(quote);
  await assert.rejects(() => linkReportQuote(sql, "u1", { findingVersionId: "v1", reportId: res.reportId, start: start + 1, end: start + 1 + quote.length, quote, note: "" }), /does not match/);
  await assert.rejects(() => linkReportQuote(sql, "u1", { findingVersionId: "v2", reportId: res.reportId, start, end: start + quote.length, quote, note: "" }), /different records/);
  await assert.rejects(() => linkReportQuote(sql, "u2", { findingVersionId: "v1", reportId: res.reportId, start, end: start + quote.length, quote, note: "" }), /not found/);
  await assert.rejects(
    () => pg.query("insert into evidence_links (id,user_id,finding_version_id,kind,note,quote_start,quote_end) values ('bad','u1','v1','report_quote','n',5,2)"),
    /evidence_links_quote_range/,
  );
});
