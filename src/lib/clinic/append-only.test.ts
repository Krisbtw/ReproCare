import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

async function makeDb() {
  const pg = new PGlite();
  for (const f of ["0002_anatomybridge.sql", "0003_append_only.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${f}`, import.meta.url), "utf8"));
  }
  await pg.exec(`
    insert into patients (id,user_id,code,display_name,pathway,synopsis) values ('p1','u1','S-1','Synthetic','fibroids','x');
    insert into studies (id,user_id,patient_id,modality,study_date,description,accession,source_note) values ('s1','u1','p1','MR','2026-01-02','d','a','n');
    insert into findings (id,user_id,patient_id,code,structure,organ,pathway) values ('f1','u1','p1','F1','fibroid','uterus','fibroids');
    insert into finding_versions (id,user_id,finding_id,version_no,study_id,observed_on,location_label,measurement_basis,frame,segmentation_source,quality,modality,change_reason)
      values ('v1','u1','f1',1,'s1','2026-01-02','FIGO 4','b','schematic','demonstration_geometry','adequate','MR','seed');
    insert into reviews (id,user_id,target_type,target_id,status,note) values ('r1','u1','finding_version','v1','verified','ok');
    insert into audit_events (id,user_id,action,entity_type,entity_id,detail) values ('a1','u1','create','finding','f1','seed');
  `);
  return pg;
}

const TABLES: Array<[string, string, string]> = [
  ["finding_versions", "v1", "change_reason"],
  ["reviews", "r1", "note"],
  ["audit_events", "a1", "detail"],
];

test("UPDATE is refused on every append-only table", async () => {
  const pg = await makeDb();
  for (const [table, id, col] of TABLES) {
    await assert.rejects(() => pg.query(`update ${table} set ${col} = 'changed' where id = $1`, [id]), /append-only/, table);
  }
});

test("direct DELETE is refused on every append-only table", async () => {
  const pg = await makeDb();
  for (const [table, id] of TABLES) {
    await assert.rejects(() => pg.query(`delete from ${table} where id = $1`, [id]), /append-only/, table);
  }
});

test("TRUNCATE is refused", async () => {
  const pg = await makeDb();
  await assert.rejects(() => pg.query("truncate finding_versions cascade"), /append-only|cannot truncate/i);
  await assert.rejects(() => pg.query("truncate audit_events"), /append-only/);
});

test("INSERT of a new version still works and history stays intact", async () => {
  const pg = await makeDb();
  await pg.exec(`insert into finding_versions (id,user_id,finding_id,version_no,previous_version_id,study_id,observed_on,location_label,measurement_basis,frame,segmentation_source,quality,modality,change_reason)
    values ('v2','u1','f1',2,'v1','s1','2026-03-02','FIGO 4','b','schematic','demonstration_geometry','adequate','MR','correction')`);
  const rows = (await pg.query("select id, change_reason from finding_versions order by version_no")).rows as Array<{ id: string; change_reason: string }>;
  assert.deepEqual(rows.map((r) => r.id), ["v1", "v2"]);
  assert.equal(rows[0].change_reason, "seed");
});

test("deleting the whole patient still cascades (erasure / reset path)", async () => {
  const pg = await makeDb();
  await pg.exec("delete from patients where id = 'p1'");
  for (const t of ["findings", "finding_versions"]) {
    assert.equal(((await pg.query(`select count(*)::int as n from ${t}`)).rows[0] as { n: number }).n, 0, t);
  }
  // audit rows are not tied to the patient and survive
  assert.equal(((await pg.query("select count(*)::int as n from audit_events")).rows[0] as { n: number }).n, 1);
});

test("migration 0003 is safe to apply twice", async () => {
  const pg = await makeDb();
  await pg.exec(readFileSync(new URL("../../../migrations/0003_append_only.sql", import.meta.url), "utf8"));
  await assert.rejects(() => pg.query("update reviews set note='x' where id='r1'"), /append-only/);
});
