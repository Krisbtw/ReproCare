import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { insertLabVersion } from "./lab-version.ts";
import type { Sql } from "../db.ts";

async function makeDb() {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../../migrations/0002_anatomybridge.sql", import.meta.url), "utf8"));
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    return (await pg.query(text, values as unknown[])).rows;
  }) as unknown as Sql;
  (sql as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => (await pg.query(text, params)).rows;
  await pg.exec(`
    insert into patients (id,user_id,code,display_name,pathway,synopsis) values ('p1','u1','S-1','Synthetic','fibroids','x');
    insert into studies (id,user_id,patient_id,modality,study_date,description,accession,source_note) values ('s1','u1','p1','MR','2026-01-02','d','a','n');
    insert into findings (id,user_id,patient_id,code,structure,organ,pathway) values ('f1','u1','p1','F1','fibroid','uterus','fibroids');
    insert into finding_versions (id,user_id,finding_id,version_no,study_id,observed_on,location_label,figo,centroid_mm,axes_mm,longest_mm,measurement_basis,frame,segmentation_source,quality,modality,change_reason)
      values ('v1','u1','f1',1,'s1','2026-01-02','FIGO 4','4','[1,2,3]','[40,30,20]',40,'b','schematic','demonstration_geometry','adequate','MR','seed');
  `);
  return { pg, sql };
}

const input = { findingId: "f1", axes: [56, 42, 33] as [number, number, number], longest: 56, sliceIndex: 14, reason: "First measured pass", evidenceNote: "note" };

test("appends v2, keeps v1 untouched, links to previous, no centroid, unavailable frame, no model id", async () => {
  const { pg, sql } = await makeDb();
  const id = await insertLabVersion(sql, "u1", input);
  const rows = (await pg.query("select * from finding_versions order by version_no")).rows as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "v1");
  assert.equal(rows[0].axes_mm, "[40,30,20]");
  assert.equal(rows[0].change_reason, "seed");
  assert.equal(rows[1].id, id);
  assert.equal(rows[1].version_no, 2);
  assert.equal(rows[1].previous_version_id, "v1");
  assert.equal(rows[1].centroid_mm, null);
  assert.equal(rows[1].frame, "unavailable");
  assert.equal(rows[1].model_id, null);
  assert.equal(rows[1].segmentation_source, "classical_region_growing");
  const ev = (await pg.query("select * from evidence_links where finding_version_id = $1", [id])).rows as Record<string, unknown>[];
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "lab_segmentation");
  assert.equal(ev[0].slice_index, 14);
});

test("second record makes v3; other user's finding and unknown finding are refused", async () => {
  const { pg, sql } = await makeDb();
  await insertLabVersion(sql, "u1", input);
  await insertLabVersion(sql, "u1", { ...input, reason: "Second measured pass" });
  const n = (await pg.query("select count(*)::int as n from finding_versions where finding_id='f1'")).rows[0] as { n: number };
  assert.equal(n.n, 3);
  await assert.rejects(() => insertLabVersion(sql, "u2", input), /Finding not found/);
  await assert.rejects(() => insertLabVersion(sql, "u1", { ...input, findingId: "nope" }), /Finding not found/);
});
