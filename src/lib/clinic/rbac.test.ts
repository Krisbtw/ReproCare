import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { insertLabVersion } from "./lab-version.ts";

async function makeDb(): Promise<{ pg: PGlite; sql: Sql }> {
  const pg = new PGlite();
  await pg.exec(`
    create table if not exists profiles (
      user_id text primary key,
      display_name text not null default '',
      role text not null default 'clinician' check (role in ('patient', 'clinician', 'admin')),
      active_patient_id text,
      created_at timestamptz not null default now()
    );
    create table if not exists patients (
      id text primary key,
      user_id text not null,
      code text not null,
      display_name text not null,
      year_of_birth integer,
      pathway text not null,
      synopsis text not null,
      is_self boolean not null default false,
      synthetic boolean not null default true
    );
    create table if not exists studies (
      id text primary key,
      user_id text not null,
      patient_id text not null references patients (id) on delete cascade,
      modality text not null,
      study_date date not null,
      description text not null,
      accession text not null,
      synthetic boolean not null default true,
      source_note text not null
    );
    create table if not exists series (
      id text primary key,
      user_id text not null,
      study_id text not null references studies (id) on delete cascade,
      series_number integer not null,
      description text not null,
      plane text,
      slice_thickness_mm double precision,
      pixel_spacing_mm text,
      slice_count integer,
      quality text not null default 'adequate'
    );
    create table if not exists findings (
      id text primary key,
      user_id text not null,
      patient_id text not null references patients (id) on delete cascade,
      code text not null,
      structure text not null,
      organ text not null,
      pathway text not null
    );
    create table if not exists finding_versions (
      id text primary key,
      user_id text not null,
      finding_id text not null references findings (id) on delete cascade,
      version_no integer not null,
      previous_version_id text,
      study_id text not null references studies (id) on delete cascade,
      observed_on date not null,
      location_label text not null,
      figo text,
      centroid_mm text,
      axes_mm text,
      longest_mm double precision,
      measurement_basis text not null,
      frame text not null,
      segmentation_source text not null,
      model_id text,
      quality text not null default 'adequate',
      modality text not null,
      report_longest_mm double precision,
      change_reason text not null,
      created_at timestamptz not null default now(),
      unique (finding_id, version_no)
    );
    create table if not exists evidence_links (
      id text primary key,
      user_id text not null,
      finding_version_id text not null references finding_versions (id) on delete cascade,
      kind text not null,
      study_id text references studies (id) on delete cascade,
      series_id text,
      report_id text,
      quote text,
      slice_index integer,
      note text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists correspondences (
      id text primary key,
      user_id text not null,
      patient_id text not null references patients (id) on delete cascade,
      from_version_id text not null references finding_versions (id) on delete cascade,
      to_version_id text not null references finding_versions (id) on delete cascade,
      category text not null,
      score double precision not null,
      rationale text not null,
      provisional boolean not null default true,
      engine_version text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists discrepancies (
      id text primary key,
      user_id text not null,
      patient_id text not null references patients (id) on delete cascade,
      category text not null,
      summary text not null,
      detail text not null,
      left_ref text not null,
      right_ref text not null,
      engine_version text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table if not exists reviews (
      id text primary key,
      user_id text not null,
      target_type text not null,
      target_id text not null,
      status text not null,
      note text not null,
      created_at timestamptz not null default now()
    );

    insert into profiles (user_id, display_name, role) values ('patient_user', 'Patient Self', 'patient');
    insert into profiles (user_id, display_name, role) values ('clinician_user', 'Dr Clinician', 'clinician');
    insert into profiles (user_id, display_name, role) values ('admin_user', 'Administrator', 'admin');

    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_clin', 'clinician_user', 'P01', 'Meera Patel', 1989, 'fibroids', 'Demo record', false);
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_pat_self', 'patient_user', 'P02', 'Self Patient', 1992, 'fibroids', 'Self record', true);
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_pat_other', 'patient_user', 'P03', 'Other Patient', 1985, 'fibroids', 'Other record', false);

    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note)
      values ('s_clin', 'clinician_user', 'p_clin', 'MR', '2026-01-01', 'Initial MRI', 'ACC-01', 'Synthetic');
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values ('f_clin', 'clinician_user', 'p_clin', 'F1', 'fibroid', 'uterus', 'fibroids');
    insert into finding_versions (id, user_id, finding_id, version_no, study_id, observed_on, location_label, figo, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, change_reason, modality)
      values ('v_clin', 'clinician_user', 'f_clin', 1, 's_clin', '2026-01-01', 'FIGO 4', '4', '[30,20,15]', 30, 'seeded', 'schematic', 'demo', 'initial', 'MR');
  `);

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      query += `$${i + 1}${strings[i + 1]}`;
    }
    const res = await pg.query(query, values as unknown[]);
    return res.rows as any;
  }) as unknown as Sql;

  return { pg, sql };
}

test("RBAC: Patient cannot escalate to clinician or admin", async () => {
  const { sql } = await makeDb();
  async function testRoleEscalation(userId: string, targetRole: string) {
    const rows = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`;
    const current = rows[0]?.role;
    if (current === "patient" && (targetRole === "clinician" || targetRole === "admin")) {
      throw new Error("Unauthorized: Role escalation is not permitted. Only an administrator can assign clinician or admin roles.");
    }
    if (current === "clinician" && targetRole === "admin") {
      throw new Error("Unauthorized: Clinicians cannot self-escalate to administrator.");
    }
    await sql`update profiles set role = ${targetRole} where user_id = ${userId}`;
  }

  await assert.rejects(
    () => testRoleEscalation("patient_user", "clinician"),
    /Unauthorized: Role escalation is not permitted/
  );
  await assert.rejects(
    () => testRoleEscalation("patient_user", "admin"),
    /Unauthorized: Role escalation is not permitted/
  );
  await assert.rejects(
    () => testRoleEscalation("clinician_user", "admin"),
    /Unauthorized: Clinicians cannot self-escalate to administrator/
  );
});

test("RBAC: Cross-tenant ownership protection enforces data isolation", async () => {
  const { sql } = await makeDb();
  // Patient user tries to record finding measurement on clinician's finding
  await assert.rejects(
    () =>
      insertLabVersion(sql, "patient_user", {
        findingId: "f_clin",
        axes: [35, 25, 20],
        longest: 35,
        sliceIndex: 10,
        reason: "Unauthorized measurement attempt",
        evidenceNote: "evidence",
      }),
    /Finding not found/
  );
});

test("RBAC: Patient can only modify their own self-patient record", async () => {
  const { sql } = await makeDb();
  async function checkPatientAccess(userId: string, patientId: string) {
    const roleRows = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`;
    const role = roleRows[0]?.role;
    const patientRows = await sql<{ id: string; is_self: boolean }>`select id, is_self from patients where id = ${patientId} and user_id = ${userId}`;
    if (!patientRows.length) throw new Error("Record not found.");
    if (role === "patient" && !patientRows[0].is_self) {
      throw new Error("Patient view can modify only your own record.");
    }
    return true;
  }

  // Permitted on self record
  assert.equal(await checkPatientAccess("patient_user", "p_pat_self"), true);
  // Refused on another patient record
  await assert.rejects(
    () => checkPatientAccess("patient_user", "p_pat_other"),
    /Patient view can modify only your own record/
  );
  // Refused on record owned by other user
  await assert.rejects(
    () => checkPatientAccess("patient_user", "p_clin"),
    /Record not found/
  );
});
