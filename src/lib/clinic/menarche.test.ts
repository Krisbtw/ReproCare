import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { applyMenarcheYear } from "./menarche.ts";
import type { Sql } from "../db.ts";

async function makeDb() {
  const pg = new PGlite();
  for (const f of ["0002_anatomybridge.sql", "0003_append_only.sql", "0004_menarche_year.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${f}`, import.meta.url), "utf8"));
  }
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    return (await pg.query(text, values as unknown[])).rows;
  }) as unknown as Sql;
  (sql as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => (await pg.query(text, params)).rows;
  await pg.exec(`
    insert into patients (id,user_id,code,display_name,year_of_birth,pathway,synopsis,is_self) values
      ('p1','u1','S-1','Synthetic A',2000,'pcos','x',false),
      ('p2','u1','S-2','Synthetic self',2002,'pcos','x',true);
  `);
  return { pg, sql };
}

const audit = async (pg: PGlite) =>
  (await pg.query("select action, entity_id, detail from audit_events order by at, id")).rows as Array<{ action: string; entity_id: string; detail: string }>;

test("0004 adds a nullable column; existing rows stay null (nothing back-filled)", async () => {
  const { pg } = await makeDb();
  const rows = (await pg.query("select id, menarche_year from patients order by id")).rows as Array<{ menarche_year: number | null }>;
  assert.deepEqual(rows.map((r) => r.menarche_year), [null, null]);
});

test("0004 is safe to apply twice and its check constraint refuses absurd years", async () => {
  const { pg } = await makeDb();
  await pg.exec(readFileSync(new URL("../../../migrations/0004_menarche_year.sql", import.meta.url), "utf8"));
  await assert.rejects(() => pg.query("update patients set menarche_year = 42 where id = 'p1'"), /menarche_year_range/);
});

test("clinician stores a year; earlier value goes to the audit log; clearing is audited too", async () => {
  const { pg, sql } = await makeDb();
  const r1 = await applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: 2012, reason: "patient-reported at visit" }, 2026);
  assert.deepEqual(r1, { changed: true, before: null, after: 2012 });
  const r2 = await applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: 2013, reason: "corrected from referral letter" }, 2026);
  assert.deepEqual(r2, { changed: true, before: 2012, after: 2013 });
  await applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: null, reason: "patient unsure" }, 2026);
  const a = await audit(pg);
  assert.equal(a.length, 3);
  assert.match(a[0].detail, /not recorded -> 2012/);
  assert.match(a[1].detail, /2012 -> 2013.*referral/);
  assert.match(a[2].detail, /2013 -> not recorded/);
  const stored = (await pg.query("select menarche_year from patients where id='p1'")).rows[0] as { menarche_year: number | null };
  assert.equal(stored.menarche_year, null);
});

test("same value is a no-op and writes no audit line", async () => {
  const { pg, sql } = await makeDb();
  await applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: 2012, reason: "visit" }, 2026);
  const again = await applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: 2012, reason: "visit" }, 2026);
  assert.equal(again.changed, false);
  assert.equal((await audit(pg)).length, 1);
});

test("implausible year (age 4 by birth year) is refused and nothing is written", async () => {
  const { pg, sql } = await makeDb();
  await assert.rejects(() => applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: 2004, reason: "visit" }, 2026), /age 4/);
  assert.equal((await audit(pg)).length, 0);
});

test("patient lens: own record allowed, someone else's refused; other user and missing reason refused", async () => {
  const { sql } = await makeDb();
  const ok = await applyMenarcheYear(sql, "u1", "patient", { patientId: "p2", menarcheYear: 2014, reason: "self-reported" }, 2026);
  assert.equal(ok.changed, true);
  await assert.rejects(() => applyMenarcheYear(sql, "u1", "patient", { patientId: "p1", menarcheYear: 2012, reason: "self-reported" }, 2026), /only your own/);
  await assert.rejects(() => applyMenarcheYear(sql, "u2", "clinician", { patientId: "p1", menarcheYear: 2012, reason: "visit" }, 2026), /Record not found/);
  await assert.rejects(() => applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: 2012, reason: " " }, 2026), /where the year came from/);
});

test("the audit line about the change cannot itself be edited (0003 still holds)", async () => {
  const { pg, sql } = await makeDb();
  await applyMenarcheYear(sql, "u1", "clinician", { patientId: "p1", menarcheYear: 2012, reason: "visit" }, 2026);
  await assert.rejects(() => pg.query("update audit_events set detail = 'x'"), /append-only/);
});
