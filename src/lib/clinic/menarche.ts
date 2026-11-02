/**
 * Store or clear the year of first period on a patient record.
 * Plain function (no framework) so it can be tested on PGlite, like lab-version.ts.
 *
 * Rules:
 *  - The record must belong to the user.
 *  - The patient lens (or an unverified clinician) may change only its own (is_self) record.
 *  - A year must pass checkMenarcheYear against the stored year of birth. Nothing is guessed or corrected.
 *  - patients is not append-only, so the earlier value is written to audit_events (append-only since 0003).
 */
import type { Sql } from "../db.ts";
import { checkMenarcheYear } from "./pcos-context.ts";

export type MenarcheInput = { patientId: string; menarcheYear: number | null; reason: string };
export type MenarcheResult = { changed: boolean; before: number | null; after: number | null };

async function resolveEffectiveRole(sql: Sql, userId: string, passedRole: string): Promise<string> {
  const profileRows = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`;
  if (profileRows.length === 0) {
    const anyProfiles = await sql<{ n: number }>`select 1 as n from profiles limit 1`;
    if (anyProfiles.length > 0) {
      throw new Error("Unauthorized: User profile not found; access denied.");
    }
    return passedRole;
  }
  const dbRole = profileRows[0].role;
  if (dbRole === "admin" && passedRole === "admin") return "admin";
  if ((dbRole === "clinician" || dbRole === "admin") && (passedRole === "clinician" || passedRole === "admin")) {
    if (dbRole === "admin") return "admin";
    const verifRows = await sql<{ status: string; licence_no: string; registry: string }>`
      select status, licence_no, registry
      from clinician_verifications
      where user_id = ${userId}
      order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc
      limit 1
    `.catch(() => []);
    const v = verifRows[0];
    const approved =
      Boolean(v) &&
      (v.status === "verified" || v.status === "approved") &&
      String(v.licence_no ?? "").trim().length > 0 &&
      String(v.registry ?? "").trim().length > 0;
    return approved ? "clinician" : "patient";
  }
  return "patient";
}

export async function applyMenarcheYear(
  sql: Sql,
  userId: string,
  role: string,
  input: MenarcheInput,
  referenceYear: number,
): Promise<MenarcheResult> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  if (reason.length < 4) throw new Error("Say where the year came from (for example: patient-reported at visit).");
  const rows = await sql<{ id: string; is_self: boolean; year_of_birth: number | null; menarche_year: number | null }>`
    select id, is_self, year_of_birth, menarche_year from patients where id = ${input.patientId} and user_id = ${userId}`;
  const patient = rows[0];
  if (!patient) throw new Error("Record not found.");
  const effectiveRole = await resolveEffectiveRole(sql, userId, role);
  if (effectiveRole === "patient" && !patient.is_self) {
    throw new Error("Unauthorized: Patient view can change only your own synthetic record.");
  }
  if (input.menarcheYear !== null) {
    const yob = patient.year_of_birth == null ? null : Number(patient.year_of_birth);
    const check = checkMenarcheYear(input.menarcheYear, yob, referenceYear);
    if (!check.ok) throw new Error(check.problem);
  }
  const before = patient.menarche_year == null ? null : Number(patient.menarche_year);
  const after = input.menarcheYear;
  if (before === after) return { changed: false, before, after };
  await sql`update patients set menarche_year = ${after} where id = ${input.patientId} and user_id = ${userId}`;
  const show = (v: number | null) => (v == null ? "not recorded" : String(v));
  await sql`insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (${crypto.randomUUID()}, ${userId}, ${"set_menarche_year"}, ${"patient"}, ${input.patientId},
      ${`First-period year ${show(before)} -> ${show(after)}. Source: ${reason}`})`;
  return { changed: true, before, after };
}

export async function updateMenarcheYear(
  sql: Sql,
  userId: string,
  input: MenarcheInput,
  referenceYear = new Date().getFullYear(),
): Promise<MenarcheResult> {
  return applyMenarcheYear(sql, userId, "patient", input, referenceYear);
}
