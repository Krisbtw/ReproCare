/**
 * Store or clear the year of first period on a patient record.
 * Plain function (no framework) so it can be tested on PGlite, like lab-version.ts.
 *
 * Rules:
 *  - The record must belong to the user.
 *  - The patient lens may change only its own (is_self) record.
 *  - A year must pass checkMenarcheYear against the stored year of birth. Nothing is guessed or corrected.
 *  - patients is not append-only, so the earlier value is written to audit_events (append-only since 0003).
 */
import type { Sql } from "../db.ts";
import { checkMenarcheYear } from "./pcos-context.ts";

export type MenarcheInput = { patientId: string; menarcheYear: number | null; reason: string };
export type MenarcheResult = { changed: boolean; before: number | null; after: number | null };

export async function applyMenarcheYear(
  sql: Sql,
  userId: string,
  role: string,
  input: MenarcheInput,
  referenceYear: number,
): Promise<MenarcheResult> {
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  if (reason.length < 4) throw new Error("Say where the year came from (for example: patient-reported at visit).");
  const rows = await sql<{ id: string; is_self: boolean; year_of_birth: number | null; menarche_year: number | null }>`
    select id, is_self, year_of_birth, menarche_year from patients where id = ${input.patientId} and user_id = ${userId}`;
  const patient = rows[0];
  if (!patient) throw new Error("Record not found.");
  if (role === "patient" && !patient.is_self) throw new Error("Patient view can change only your own synthetic record.");
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
