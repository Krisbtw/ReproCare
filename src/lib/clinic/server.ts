import { createServerFn } from "@tanstack/react-start";
import { getSql, type Sql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { ENGINE_VERSION, matchChronology, sameMethodChange, type Snap, type Measure } from "../reprotrace/engine";
import { insertLabVersion } from "./lab-version";
import { applyMenarcheYear } from "./menarche";
import { ingestReport, linkReportQuote, type IngestInput, type QuoteLinkInput } from "../reports/store";
import type {
  ExportPayload,
  VersionRow,
  Workspace,
  ClinicianVerificationRow,
  RegistrationRow,
  EndometriosisRecordItem,
  OvarianCystRecordItem,
  PcosAssessmentItem,
} from "./types";
import {
  CYCLES,
  FINDINGS,
  LABS,
  MODELS,
  PATIENTS,
  REPORTS,
  SERIES,
  STUDIES,
  SYMPTOMS,
  discrepanciesFor,
  proposalsFor,
} from "./story";

function kid(userId: string, key: string): string {
  return `${userId}:${key}`;
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function audit(sql: Sql, userId: string, action: string, entityType: string, entityId: string, detail: string) {
  await sql`insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (${crypto.randomUUID()}, ${userId}, ${action}, ${entityType}, ${entityId}, ${detail})`;
}

async function roleOf(sql: Sql, userId: string): Promise<string> {
  const rows = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`;
  return rows[0]?.role ?? "patient";
}

async function seed(sql: Sql, userId: string) {
  for (const p of PATIENTS) {
    await sql`insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self, synthetic)
      values (${kid(userId, p.key)}, ${userId}, ${p.code}, ${p.name}, ${p.yob}, ${p.pathway}, ${p.synopsis}, ${p.self}, ${true})`;
  }
  for (const s of STUDIES) {
    await sql`insert into studies (id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note)
      values (${kid(userId, s.key)}, ${userId}, ${kid(userId, s.patient)}, ${s.modality}, ${s.date}, ${s.description}, ${s.accession}, ${true}, ${s.note})`;
  }
  for (const s of SERIES) {
    await sql`insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality)
      values (${kid(userId, s.key)}, ${userId}, ${kid(userId, s.study)}, ${s.n}, ${s.description}, ${s.plane}, ${s.thick}, ${s.spacing}, ${s.slices}, ${s.quality})`;
  }
  for (const r of REPORTS) {
    await sql`insert into reports (id, user_id, study_id, report_date, author_role, body, synthetic)
      values (${kid(userId, r.key)}, ${userId}, ${kid(userId, r.study)}, ${r.date}, ${"synthetic reporting clinician"}, ${r.body}, ${true})`;
  }
  for (const f of FINDINGS) {
    await sql`insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values (${kid(userId, f.key)}, ${userId}, ${kid(userId, f.patient)}, ${f.code}, ${f.structure}, ${f.organ}, ${f.pathway})`;
    for (let index = 0; index < f.versions.length; index += 1) {
      const v = f.versions[index];
      const id = kid(userId, v.key);
      const previous = index === 0 ? null : kid(userId, f.versions[index - 1].key);
      await sql`insert into finding_versions (
        id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
        centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
        report_longest_mm, change_reason
      ) values (
        ${id}, ${userId}, ${kid(userId, f.key)}, ${index + 1}, ${previous}, ${kid(userId, f.study)},
        ${(STUDIES.find((s) => s.key === f.study)?.date ?? "2025-01-01")}, ${f.location}, ${f.figo},
        ${f.centroid ? JSON.stringify(f.centroid) : null}, ${v.axes ? JSON.stringify(v.axes) : null}, ${v.longest},
        ${f.basis}, ${f.frame}, ${v.source}, ${v.modelId}, ${f.quality}, ${f.modality}, ${v.reportLongest}, ${v.reason}
      )`;
      const report = REPORTS.find((r) => r.study === f.study);
      const series = SERIES.find((s) => s.study === f.study);
      await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note)
        values (${kid(userId, `${v.key}-ev`)}, ${userId}, ${id}, ${"source"}, ${kid(userId, f.study)},
          ${series ? kid(userId, series.key) : null}, ${report ? kid(userId, report.key) : null}, ${v.quote}, ${v.slice},
          ${"Link stored with the version. Quotes are from the synthetic report, not an external model."})`;
    }
  }
  for (const s of SYMPTOMS) {
    await sql`insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, cycle_day, description, source)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, s.patient)}, ${s.date}, ${s.region}, ${s.intensity}, ${s.cycleDay}, ${s.description}, ${"patient_reported"})`;
  }
  for (const c of CYCLES) {
    await sql`insert into cycles (id, user_id, patient_id, start_date, length_days, flow, note)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, c.patient)}, ${c.start}, ${c.length}, ${c.flow}, ${c.note})`;
  }
  for (const l of LABS) {
    await sql`insert into labs (id, user_id, patient_id, observed_on, analyte, value_text, unit, reference_text, source_note)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, l.patient)}, ${l.date}, ${l.analyte}, ${l.value}, ${l.unit}, ${l.ref}, ${l.note})`;
  }
  for (const patient of PATIENTS) {
    for (const p of proposalsFor(patient.key)) {
      await sql`insert into correspondences (id, user_id, patient_id, from_version_id, to_version_id, from_study_id, to_study_id, category, score, rationale, provisional, engine_version, active)
        values (${crypto.randomUUID()}, ${userId}, ${kid(userId, patient.key)},
          ${p.fromId ? kid(userId, p.fromId) : null}, ${p.toId ? kid(userId, p.toId) : null},
          ${p.fromStudyId ? kid(userId, p.fromStudyId) : null}, ${p.toStudyId ? kid(userId, p.toStudyId) : null},
          ${p.category}, ${p.score}, ${p.rationale}, ${p.provisional}, ${ENGINE_VERSION}, ${true})`;
    }
    for (const d of discrepanciesFor(patient.key)) {
      await sql`insert into discrepancies (id, user_id, patient_id, category, summary, detail, left_ref, right_ref, engine_version, active)
        values (${crypto.randomUUID()}, ${userId}, ${kid(userId, patient.key)}, ${d.category}, ${d.summary}, ${d.detail},
          ${d.leftRef ? kid(userId, d.leftRef) : null}, ${d.rightRef ? kid(userId, d.rightRef) : null}, ${ENGINE_VERSION}, ${true})`;
    }
    await sql`insert into consents (id, user_id, patient_id, purpose, granted, note)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, patient.key)}, ${"synthetic demonstration"}, ${true},
        ${"Synthetic record only. This is not consent from a real patient."})`;
  }
  await sql`update profiles set active_patient_id = ${kid(userId, "meera")} where user_id = ${userId}`;
  await audit(sql, userId, "seed", "workspace", userId, "Synthetic clinic loaded. All people and scans are fabricated.");
}

async function ensure(sql: Sql, userId: string) {
  await sql`insert into profiles (user_id, display_name, role) values (${userId}, ${""}, ${"patient"}) on conflict (user_id) do nothing`;

  // Bootstrap admin role if configured via BOOTSTRAP_ADMIN_EMAILS
  const rawAdminEmails = process.env["BOOTSTRAP_ADMIN_EMAILS"];
  if (rawAdminEmails) {
    const adminEmails = rawAdminEmails.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const userRows = await sql<{ email: string }>`select email from "user" where id = ${userId}`.catch(() => []);
    const email = userRows[0]?.email?.toLowerCase();
    if (email && adminEmails.includes(email)) {
      const current = await roleOf(sql, userId);
      if (current !== "admin") {
        await sql`update profiles set role = 'admin' where user_id = ${userId}`;
        await audit(sql, userId, "bootstrap_admin", "profile", userId, `Bootstrapped admin role for ${email}`);
      }
    }
  }

  const n = await sql<{ n: number }>`select count(*)::int as n from patients where user_id = ${userId}`;
  if (asNumber(n[0]?.n) === 0) {
    try {
      await seed(sql, userId);
    } catch (error) {
      const again = await sql<{ n: number }>`select count(*)::int as n from patients where user_id = ${userId}`;
      if (asNumber(again[0]?.n) === 0) throw error;
    }
  }
}

function parseTriple(value: unknown): [number, number, number] | null {
  if (!value) return null;
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
}

export const getWorkspace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    const userId = context.userId;
    const userProfiles = await sql<{ user_id: string; display_name: string; role: string; active_patient_id: string | null }>`select user_id, display_name, role, active_patient_id from profiles where user_id = ${userId}`;
    const profile = userProfiles[0] ?? {
      user_id: userId,
      display_name: "",
      role: "patient",
      active_patient_id: null,
    };
    const userRole = profile.role ?? "patient";
    const [patients, studies, series, reports, findings, versions, evidence, symptoms, cycles, labs, correspondences, decisions, discrepancies, reviews, consents, uploads, auditRows, extractions, verifications, registrations, endometriosisRecords, ovarianCystRecords, pcosAssessments] =
      await Promise.all([
        sql`select * from patients where user_id = ${userId} order by code`,
        sql`select * from studies where user_id = ${userId} order by study_date`,
        sql`select * from series where user_id = ${userId} order by series_number`,
        sql`select * from reports where user_id = ${userId} order by report_date`,
        sql`select * from findings where user_id = ${userId} order by code`,
        sql`select * from finding_versions where user_id = ${userId} order by observed_on, version_no`,
        sql`select * from evidence_links where user_id = ${userId}`,
        sql`select * from symptoms where user_id = ${userId} order by recorded_on`,
        sql`select * from cycles where user_id = ${userId} order by start_date`,
        sql`select * from labs where user_id = ${userId} order by observed_on, analyte`,
        sql`select * from correspondences where user_id = ${userId} and active = true order by created_at`,
        sql`select * from correspondence_decisions where user_id = ${userId} order by created_at`,
        sql`select * from discrepancies where user_id = ${userId} and active = true order by created_at`,
        sql`select * from reviews where user_id = ${userId} order by created_at`,
        sql`select * from consents where user_id = ${userId} order by created_at`,
        sql`select id, patient_id, received_at, file_name, transfer_syntax, metadata, warnings, identifiers_withheld from dicom_uploads where user_id = ${userId} order by received_at desc limit 12`,
        sql`select * from audit_events where user_id = ${userId} order by at desc limit 40`,
        sql`select id, report_id, file_name, file_kind, content_sha256, deid_method, redaction_count, redaction_kinds, extractor, extraction, warnings, created_at from report_extractions where user_id = ${userId} order by created_at desc`,
        userRole === "admin"
          ? sql<ClinicianVerificationRow>`
              select cv.*, p.display_name, p.role as current_role
              from clinician_verifications cv
              left join profiles p on cv.user_id = p.user_id
              order by cv.requested_at desc
            `.catch(() => [])
          : sql<ClinicianVerificationRow>`
              select * from clinician_verifications where user_id = ${userId} order by requested_at desc
            `.catch(() => []),
        sql<RegistrationRow>`select * from registrations where user_id = ${userId} order by created_at desc`.catch(() => []),
        sql<EndometriosisRecordItem>`select * from pathway_endometriosis_records where user_id = ${userId} order by created_at desc`.catch(() => []),
        sql<OvarianCystRecordItem>`select * from pathway_ovarian_cyst_records where user_id = ${userId} order by created_at desc`.catch(() => []),
        sql<PcosAssessmentItem>`select * from pathway_pcos_assessments where user_id = ${userId} order by created_at desc`.catch(() => []),
      ]);
    const versionsOut: VersionRow[] = (versions as Record<string, unknown>[]).map((v) => ({
      ...(v as object),
      centroid_mm: parseTriple(v.centroid_mm),
      axes_mm: parseTriple(v.axes_mm),
      longest_mm: v.longest_mm == null ? null : Number(v.longest_mm),
      report_longest_mm: v.report_longest_mm == null ? null : Number(v.report_longest_mm),
    })) as VersionRow[];
    const workspace: Workspace = {
      profile,
      patients: patients as Workspace["patients"],
      studies: studies as Workspace["studies"],
      series: series as Workspace["series"],
      reports: reports as Workspace["reports"],
      findings: findings as Workspace["findings"],
      versions: versionsOut,
      evidence: evidence as Workspace["evidence"],
      symptoms: symptoms as Workspace["symptoms"],
      cycles: cycles as Workspace["cycles"],
      labs: labs as Workspace["labs"],
      correspondences: correspondences as Workspace["correspondences"],
      decisions: decisions as Workspace["decisions"],
      discrepancies: discrepancies as Workspace["discrepancies"],
      reviews: reviews as Workspace["reviews"],
      consents: consents as Workspace["consents"],
      uploads: uploads as Workspace["uploads"],
      audit: auditRows as Workspace["audit"],
      extractions: extractions as Workspace["extractions"],
      verifications: (verifications ?? []) as Workspace["verifications"],
      registrations: (registrations ?? []) as Workspace["registrations"],
      endometriosisRecords: (endometriosisRecords ?? []) as Workspace["endometriosisRecords"],
      ovarianCystRecords: (ovarianCystRecords ?? []) as Workspace["ovarianCystRecords"],
      pcosAssessments: (pcosAssessments ?? []) as Workspace["pcosAssessments"],
      models: MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        status: model.status,
        note: model.note,
      })),
      engineVersion: ENGINE_VERSION,
    };
    return workspace;
    return workspace;
  });

export const setRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((role: string) => {
    if (role !== "patient" && role !== "clinician" && role !== "admin") throw new Error("Unknown role");
    return role;
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    const current = await roleOf(sql, context.userId);
    if (current === "patient" && (data === "clinician" || data === "admin")) {
      throw new Error("Unauthorized: Role escalation is not permitted. Only an administrator can assign clinician or admin roles.");
    }
    if (current === "clinician" && data === "admin") {
      throw new Error("Unauthorized: Clinicians cannot self-escalate to administrator.");
    }
    await sql`update profiles set role = ${data} where user_id = ${context.userId}`;
    await audit(sql, context.userId, "set_role", "profile", context.userId, `Role set to ${data}.`);
    return { ok: true };
  });

export const promoteUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { targetUserId: string; newRole: string }) => {
    if (!input || typeof input !== "object") throw new Error("Expected an input object.");
    if (typeof input.targetUserId !== "string" || !input.targetUserId.trim()) {
      throw new Error("Target user ID is required.");
    }
    if (input.newRole !== "patient" && input.newRole !== "clinician" && input.newRole !== "admin") {
      throw new Error("Invalid target role: must be patient, clinician, or admin.");
    }
    return { targetUserId: input.targetUserId.trim(), newRole: input.newRole };
  })
  .handler(async ({ context, data: { targetUserId, newRole } }) => {
    const sql = await getSql();
    const callerRole = await roleOf(sql, context.userId);
    if (callerRole !== "admin") {
      throw new Error("Unauthorized: Only administrators can assign roles to other users.");
    }
    const targetRows = await sql`select role from profiles where user_id = ${targetUserId}`;
    if (!targetRows.length) {
      throw new Error("Target user profile not found.");
    }
    await sql`update profiles set role = ${newRole} where user_id = ${targetUserId}`;
    await audit(sql, context.userId, "promote_user", "profile", targetUserId, `Role set to ${newRole} by administrator.`);
    return { ok: true, targetUserId, newRole };
  });

export const setActivePatient = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const rows = await sql`select id from patients where id = ${data} and user_id = ${context.userId}`;
    if (!rows.length) throw new Error("That record is not in your workspace.");
    await sql`update profiles set active_patient_id = ${data} where user_id = ${context.userId}`;
    return { ok: true };
  });

export const setMenarcheYear = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; menarcheYear: number | null; reason: string }) => {
    if (typeof input.patientId !== "string" || !input.patientId) throw new Error("Record not found.");
    if (input.menarcheYear !== null && (!Number.isInteger(input.menarcheYear) || input.menarcheYear < 1900 || input.menarcheYear > 2200)) {
      throw new Error("Enter the year of the first period as a whole year, or clear it.");
    }
    const reason = String(input.reason ?? "").trim().slice(0, 300);
    if (reason.length < 4) throw new Error("Say where the year came from (for example: patient-reported at visit).");
    return { ...input, reason };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    // Ownership, lens, plausibility and the audit line (with the earlier value) live in menarche.ts.
    const result = await applyMenarcheYear(sql, context.userId, role, data, new Date().getFullYear());
    return { ok: true, changed: result.changed };
  });

const REGIONS = [
  "Lower abdomen — midline",
  "Right lower quadrant",
  "Left lower quadrant",
  "Low back",
  "Deep pelvis",
];

export const addSymptom = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; region: string; intensity: number; cycleDay: number | null; description: string; recordedOn: string }) => {
    if (!REGIONS.includes(input.region)) throw new Error("Choose a listed body region.");
    if (input.intensity < 0 || input.intensity > 10) throw new Error("Intensity is 0 to 10.");
    if (!input.description.trim()) throw new Error("Add a short description.");
    return { ...input, description: input.description.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    const patient = await sql<{ id: string; is_self: boolean }>`select id, is_self from patients where id = ${data.patientId} and user_id = ${context.userId}`;
    if (!patient[0]) throw new Error("Record not found.");
    if (role === "patient" && !patient[0].is_self) throw new Error("Patient view can add symptoms only on your own synthetic record.");
    const id = crypto.randomUUID();
    await sql`insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, cycle_day, description, source)
      values (${id}, ${context.userId}, ${data.patientId}, ${data.recordedOn}, ${data.region}, ${data.intensity}, ${data.cycleDay}, ${data.description}, ${"patient_reported"})`;
    await audit(sql, context.userId, "add_symptom", "symptom", id, "Patient-reported symptom appended. Not a clinical finding.");
    return { ok: true };
  });

export const addCycle = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; startDate: string; lengthDays: number; flow: string; note: string }) => {
    if (!Number.isFinite(input.lengthDays) || input.lengthDays < 1 || input.lengthDays > 120) throw new Error("Cycle length looks invalid.");
    return { ...input, note: input.note.trim().slice(0, 400), flow: input.flow.slice(0, 40) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    const owned = await sql<{ id: string; is_self: boolean }>`select id, is_self from patients where id = ${data.patientId} and user_id = ${context.userId}`;
    if (!owned.length) throw new Error("Record not found.");
    if (role === "patient" && !owned[0].is_self) throw new Error("Patient view can add cycles only on your own record.");
    const id = crypto.randomUUID();
    await sql`insert into cycles (id, user_id, patient_id, start_date, length_days, flow, note)
      values (${id}, ${context.userId}, ${data.patientId}, ${data.startDate}, ${data.lengthDays}, ${data.flow}, ${data.note})`;
    await audit(sql, context.userId, "add_cycle", "cycle", id, "Menstrual interval appended.");
    return { ok: true };
  });

export const addLab = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; observedOn: string; analyte: string; valueText: string; unit: string; referenceText: string }) => {
    if (!input.analyte.trim() || !input.valueText.trim()) throw new Error("Analyte and value are required.");
    return {
      ...input,
      analyte: input.analyte.trim().slice(0, 80),
      valueText: input.valueText.trim().slice(0, 40),
      unit: input.unit.trim().slice(0, 24),
      referenceText: input.referenceText.trim().slice(0, 80),
    };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    const owned = await sql<{ id: string; is_self: boolean }>`select id, is_self from patients where id = ${data.patientId} and user_id = ${context.userId}`;
    if (!owned.length) throw new Error("Record not found.");
    if (role === "patient" && !owned[0].is_self) throw new Error("Patient view can add lab records only on your own record.");
    const id = crypto.randomUUID();
    await sql`insert into labs (id, user_id, patient_id, observed_on, analyte, value_text, unit, reference_text, source_note)
      values (${id}, ${context.userId}, ${data.patientId}, ${data.observedOn}, ${data.analyte}, ${data.valueText}, ${data.unit}, ${data.referenceText}, ${"Entered in the workspace. Not interpreted."})`;
    await audit(sql, context.userId, "add_lab", "lab", id, `${data.analyte} appended without interpretation.`);
    return { ok: true };
  });

export const addReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { targetType: string; targetId: string; status: string; note: string }) => {
    if (!["verified", "rejected", "needs_more_information"].includes(input.status)) throw new Error("Unknown review status.");
    if (!["finding_version", "correspondence", "discrepancy"].includes(input.targetType)) throw new Error("Unknown review target.");
    return { ...input, note: input.note.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Verification is a clinician action.");
    if (data.targetType === "finding_version") {
      const v = await sql`select id from finding_versions where id = ${data.targetId} and user_id = ${context.userId}`;
      if (!v.length) throw new Error("Finding version not found or not owned.");
    } else if (data.targetType === "correspondence") {
      const c = await sql`select id from correspondences where id = ${data.targetId} and user_id = ${context.userId}`;
      if (!c.length) throw new Error("Correspondence proposal not found or not owned.");
    } else if (data.targetType === "discrepancy") {
      const d = await sql`select id from discrepancies where id = ${data.targetId} and user_id = ${context.userId}`;
      if (!d.length) throw new Error("Discrepancy not found or not owned.");
    }
    const id = crypto.randomUUID();
    await sql`insert into reviews (id, user_id, target_type, target_id, status, note)
      values (${id}, ${context.userId}, ${data.targetType}, ${data.targetId}, ${data.status}, ${data.note || "Reviewed."})`;
    await audit(sql, context.userId, "review", data.targetType, data.targetId, `${data.status}. Prior versions were not overwritten.`);
    return { ok: true };
  });

export const correctVersion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { versionId: string; axes: [number, number, number]; reason: string }) => {
    if (!Array.isArray(input.axes) || input.axes.length !== 3 || input.axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) {
      throw new Error("Axes must be three positive millimetre values.");
    }
    if (input.reason.trim().length < 8) throw new Error("Say why the measurement changed.");
    return { ...input, reason: input.reason.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Edits are a clinician action.");
    const rows = await sql<Record<string, unknown>>`select * from finding_versions where id = ${data.versionId} and user_id = ${context.userId}`;
    const current = rows[0];
    if (!current) throw new Error("Version not found.");
    const latest = await sql<{ version_no: number }>`select version_no from finding_versions where finding_id = ${current.finding_id as string} and user_id = ${context.userId} order by version_no desc limit 1`;
    const id = crypto.randomUUID();
    const longest = Math.max(...data.axes);
    await sql`insert into finding_versions (
      id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
      centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
      report_longest_mm, change_reason
    ) values (
      ${id}, ${context.userId}, ${current.finding_id as string}, ${asNumber(latest[0]?.version_no) + 1}, ${current.id as string},
      ${current.study_id as string}, ${current.observed_on as string}, ${current.location_label as string}, ${current.figo as string | null},
      ${current.centroid_mm as string | null}, ${JSON.stringify(data.axes)}, ${longest}, ${current.measurement_basis as string},
      ${current.frame as string}, ${"clinician_edit"}, ${null}, ${current.quality as string}, ${current.modality as string},
      ${current.report_longest_mm as number | null}, ${data.reason}
    )`;
    await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note)
      select ${crypto.randomUUID()}, user_id, ${id}, kind, study_id, series_id, report_id, quote, slice_index, ${"Copied forward when a clinician edited the measurement. The previous version remains."}
      from evidence_links where finding_version_id = ${data.versionId} and user_id = ${context.userId} limit 1`;
    await audit(sql, context.userId, "new_version", "finding_version", id, data.reason);
    return { ok: true, id };
  });

export const saveLabMeasurement = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      findingId: string;
      axes: [number, number, number];
      longest: number;
      sliceIndex: number;
      reason: string;
      evidenceNote: string;
      studyId?: string | null;
      seriesId?: string | null;
      centroidMm?: [number, number, number] | null;
      frame?: string | null;
      modelId?: string | null;
      segmentationSource?: string | null;
      segmentationRunId?: string | null;
      volumeMm3?: number | null;
      uncertaintyMm3?: number | null;
      newStudy?: {
        patientId: string;
        modality?: string;
        studyDate?: string;
        description?: string;
        accession?: string;
        sourceNote?: string;
      };
      newSeries?: {
        seriesNumber?: number;
        description?: string;
        plane?: string;
        sliceCount?: number;
        pixelSpacingMm?: string;
        sliceThicknessMm?: number;
      };
    }) => {
      if (!Array.isArray(input.axes) || input.axes.length !== 3 || input.axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) {
        throw new Error("Axes must be three positive millimetre values.");
      }
      if (!Number.isFinite(input.longest) || input.longest <= 0 || input.longest > 300) throw new Error("Longest extent must be 0 to 300 mm.");
      if (!Number.isInteger(input.sliceIndex) || input.sliceIndex < 0 || input.sliceIndex > 5000) throw new Error("Slice index is not valid.");
      if (input.reason.trim().length < 8) throw new Error("Say why the measurement was recorded.");
      return {
        ...input,
        reason: input.reason.trim().slice(0, 500),
        evidenceNote: input.evidenceNote.trim().slice(0, 1500),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Recording a measurement is a clinician action.");
    const id = await insertLabVersion(sql, context.userId, data);
    await audit(sql, context.userId, "new_version", "finding_version", id, "Volume lab measurement recorded as a new version. Prior versions were not overwritten.");
    // Recompute ReproTrace correspondences & discrepancies live for this patient
    const patientRow = await sql<{ patient_id: string }>`select patient_id from findings where id = ${data.findingId} and user_id = ${context.userId}`;
    if (patientRow[0]?.patient_id) {
      await recomputeReproTrace(sql, context.userId, patientRow[0].patient_id).catch(() => null);
    }
    return { ok: true, id };
  });

export const decideCorrespondence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { correspondenceId: string; decision: string; note: string }) => {
    if (!["accept", "reject", "defer"].includes(input.decision)) throw new Error("Unknown decision.");
    return { ...input, note: input.note.trim().slice(0, 400) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Correspondence decisions are a clinician action.");
    const rows = await sql`select id from correspondences where id = ${data.correspondenceId} and user_id = ${context.userId}`;
    if (!rows.length) throw new Error("Proposal not found.");
    const id = crypto.randomUUID();
    await sql`insert into correspondence_decisions (id, user_id, correspondence_id, decision, note)
      values (${id}, ${context.userId}, ${data.correspondenceId}, ${data.decision}, ${data.note || "Decision recorded. Findings were not merged."})`;
    await audit(sql, context.userId, "correspondence_decision", "correspondence", data.correspondenceId, `${data.decision}. Records were not merged.`);
    return { ok: true };
  });

export const resolveDiscrepancy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { discrepancyId: string; resolution: string; note: string }) => {
    if (!["acknowledged", "resolved", "dismissed"].includes(input.resolution)) throw new Error("Unknown resolution.");
    return { ...input, note: input.note.trim().slice(0, 400) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Discrepancy resolution is a clinician action.");
    const rows = await sql`select id from discrepancies where id = ${data.discrepancyId} and user_id = ${context.userId}`;
    if (!rows.length) throw new Error("Discrepancy not found or not owned.");
    await sql`update discrepancies set active = false where id = ${data.discrepancyId} and user_id = ${context.userId}`;
    await audit(sql, context.userId, "resolve_discrepancy", "discrepancy", data.discrepancyId, `${data.resolution}: ${data.note}`);
    return { ok: true };
  });

export const saveDicomMeta = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string | null; fileName: string; transferSyntax: string; metadata: Record<string, string>; warnings: string[] }) => {
    const fileName = input.fileName.slice(0, 180);
    const metadata = Object.fromEntries(Object.entries(input.metadata).slice(0, 40).map(([k, v]) => [k.slice(0, 80), String(v).slice(0, 240)]));
    return { ...input, fileName, metadata, warnings: input.warnings.slice(0, 12).map((w) => w.slice(0, 240)) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    if (data.patientId) {
      const owned = await sql`select id from patients where id = ${data.patientId} and user_id = ${context.userId}`;
      if (!owned.length) throw new Error("Record not found.");
    }
    const id = crypto.randomUUID();
    await sql`insert into dicom_uploads (id, user_id, patient_id, file_name, transfer_syntax, metadata, warnings, identifiers_withheld)
      values (${id}, ${context.userId}, ${data.patientId}, ${data.fileName}, ${data.transferSyntax}, ${JSON.stringify(data.metadata)}, ${JSON.stringify(data.warnings)}, ${true})`;
    await audit(sql, context.userId, "dicom_metadata", "dicom_upload", id, "Header stored. Pixel data and patient identifiers were not stored.");
    return { ok: true };
  });

export const exportRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    const patient = await sql<{ id: string; is_self: boolean }>`select * from patients where id = ${data} and user_id = ${context.userId}`;
    if (!patient[0]) throw new Error("Record not found.");
    if (role === "patient" && !patient[0].is_self) throw new Error("Patient view can export only your own record.");
    const studies = await sql`select * from studies where patient_id = ${data} and user_id = ${context.userId}`;
    const findings = await sql`select * from findings where patient_id = ${data} and user_id = ${context.userId}`;
    const findingIds = (findings as { id: string }[]).map((f) => f.id);
    const versions = [];
    for (const findingId of findingIds) {
      const rows = await sql`select * from finding_versions where user_id = ${context.userId} and finding_id = ${findingId}`;
      versions.push(...rows);
    }
    await audit(sql, context.userId, "export", "patient", data, "JSON export of the synthetic record.");
    const payload: ExportPayload = {
      warning: "Synthetic demonstration export. Not a medical record and not for clinical use.",
      patient: patient[0] as ExportPayload["patient"],
      studies: studies as ExportPayload["studies"],
      findings: findings as ExportPayload["findings"],
      versions: versions as ExportPayload["versions"],
    };
    return payload;
  });

export const resetWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    if ((await roleOf(sql, context.userId)) !== "admin") throw new Error("Only the admin lens can reset the synthetic workspace.");
    await sql`delete from patients where user_id = ${context.userId}`;
    await sql`delete from dicom_uploads where user_id = ${context.userId}`;
    // Audit rows are append-only (migration 0003), so a reset keeps the earlier trail and adds its own line.
    await seed(sql, context.userId);
    await audit(sql, context.userId, "reset", "workspace", context.userId, "Synthetic workspace reset. Earlier audit events were kept.");
    return { ok: true };
  });

export const uploadReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: IngestInput) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Report upload is a clinician action in this prototype.");
    // validateIngest, ownership checks, a second de-identification pass and extraction live in reports/store.ts.
    const res = await ingestReport(sql, context.userId, data);
    await audit(
      sql,
      context.userId,
      "upload_report",
      "report",
      res.reportId,
      `De-identified ${data.fileKind.toUpperCase()} text stored (sha256 ${data.sha256.slice(0, 12)}…). Original file not stored. ${res.extraction.measurements.length} measurement(s), ${res.extraction.findings.length} finding sentence(s) extracted by rules.`,
    );
    return { ok: true, reportId: res.reportId, studyId: res.studyId };
  });

export const linkReportEvidence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: QuoteLinkInput) => {
    if (!Number.isInteger(input.start) || !Number.isInteger(input.end)) throw new Error("Quote offsets are not valid.");
    if (typeof input.quote !== "string" || input.quote.length < 1 || input.quote.length > 1200) throw new Error("Quote length is not valid.");
    return input;
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Linking evidence is a clinician action.");
    const id = await linkReportQuote(sql, context.userId, data);
    await audit(sql, context.userId, "link_evidence", "finding_version", data.findingVersionId, `Report quote [${data.start}, ${data.end}) linked. The version itself was not changed.`);
    return { ok: true, id };
  });


/** Recomputes longitudinal ReproTrace correspondences and discrepancies from live database records. */
export async function recomputeReproTrace(
  sql: Sql,
  userId: string,
  patientId: string,
): Promise<{ proposalsCount: number; discrepanciesCount: number }> {
  const studies = await sql<{ id: string; study_date: string }>`
    select id, study_date::text from studies where patient_id = ${patientId} and user_id = ${userId} order by study_date
  `;
  if (studies.length === 0) return { proposalsCount: 0, discrepanciesCount: 0 };

  const findings = await sql<{ id: string; code: string; organ: string; structure: string; pathway: string }>`
    select id, code, organ, structure, pathway from findings where patient_id = ${patientId} and user_id = ${userId}
  `;
  const versions = await sql<{
    id: string; finding_id: string; study_id: string; observed_on: string; location_label: string;
    centroid_mm: string | null; axes_mm: string | null; longest_mm: number | null;
    frame: string; quality: string; modality: string; basis: string; report_longest_mm: number | null;
  }>`
    select id, finding_id, study_id, observed_on::text, location_label,
           centroid_mm, axes_mm, longest_mm, frame, quality, modality, measurement_basis as basis,
           report_longest_mm
    from finding_versions
    where user_id = ${userId} and finding_id in (select id from findings where patient_id = ${patientId} and user_id = ${userId})
    order by observed_on, version_no
  `;

  const regRows = await sql<{
    fixed_series_id: string; moving_series_id: string; ncc_score: number;
    residual_mm: number; transform_matrix_json: string; status: string;
  }>`
    select fixed_series_id, moving_series_id, ncc_score, residual_mm, transform_matrix_json, status
    from registrations
    where patient_id = ${patientId} and user_id = ${userId}
  `.catch(() => []);

  const regMap = new Map<string, { supported: boolean; transform?: any }>();
  for (const r of regRows) {
    try {
      const matrix = JSON.parse(r.transform_matrix_json);
      regMap.set(`${r.fixed_series_id}:${r.moving_series_id}`, {
        supported: r.status === "verified" || r.ncc_score > 0.5,
        transform: matrix,
      });
    } catch {
      // ignore JSON parse error
    }
  }

  const studyGroups = studies.map((s) => {
    const studyVersions = versions.filter((v) => v.study_id === s.id);
    const snaps: Snap[] = studyVersions.map((v) => {
      const f = findings.find((x) => x.id === v.finding_id);
      return {
        id: v.id,
        findingId: v.finding_id,
        studyId: v.study_id,
        date: v.observed_on,
        organ: f?.organ ?? "uterus",
        structure: f?.structure ?? "fibroid",
        locationLabel: v.location_label,
        modality: v.modality,
        frame: (v.frame as any) ?? "unavailable",
        centroidMm: parseTriple(v.centroid_mm),
        axesMm: parseTriple(v.axes_mm),
        longestMm: v.longest_mm == null ? null : Number(v.longest_mm),
        quality: (v.quality as any) ?? "adequate",
      };
    });
    return { studyId: s.id, date: s.study_date, snaps };
  });

  const proposals = matchChronology(studyGroups, regMap);

  await sql`update correspondences set active = false where patient_id = ${patientId} and user_id = ${userId} and provisional = true`;
  await sql`update discrepancies set active = false where patient_id = ${patientId} and user_id = ${userId}`;

  for (const p of proposals) {
    await sql`
      insert into correspondences (
        id, user_id, patient_id, from_version_id, to_version_id, from_study_id, to_study_id,
        category, score, rationale, provisional, engine_version, active
      ) values (
        ${crypto.randomUUID()}, ${userId}, ${patientId},
        ${p.fromId}, ${p.toId}, ${p.fromStudyId}, ${p.toStudyId},
        ${p.category}, ${p.score}, ${p.rationale}, ${p.provisional}, ${ENGINE_VERSION}, true
      )
    `;
  }

  let discrepanciesCount = 0;
  for (const p of proposals) {
    if (!p.fromId || !p.toId) continue;
    if (p.category !== "likely_same" && p.category !== "uncertain") continue;
    const v1 = versions.find((v) => v.id === p.fromId);
    const v2 = versions.find((v) => v.id === p.toId);
    if (!v1 || !v2) continue;
    const m1: Measure = {
      id: v1.id,
      findingId: v1.finding_id,
      date: v1.observed_on,
      modality: v1.modality,
      basis: v1.basis,
      locationLabel: v1.location_label,
      longestMm: v1.longest_mm,
      axesMm: parseTriple(v1.axes_mm),
      source: "record",
      reportLongestMm: v1.report_longest_mm,
      quality: v1.quality,
    };
    const m2: Measure = {
      id: v2.id,
      findingId: v2.finding_id,
      date: v2.observed_on,
      modality: v2.modality,
      basis: v2.basis,
      locationLabel: v2.location_label,
      longestMm: v2.longest_mm,
      axesMm: parseTriple(v2.axes_mm),
      source: "record",
      reportLongestMm: v2.report_longest_mm,
      quality: v2.quality,
    };
    const disc = sameMethodChange(m1, m2);
    if (disc) {
      await sql`
        insert into discrepancies (
          id, user_id, patient_id, category, summary, detail, left_ref, right_ref, engine_version, active
        ) values (
          ${crypto.randomUUID()}, ${userId}, ${patientId},
          ${disc.category}, ${disc.summary}, ${disc.detail},
          ${v1.id}, ${v2.id}, ${ENGINE_VERSION}, true
        )
      `;
      discrepanciesCount++;
    }
  }

  await audit(sql, userId, "recompute_reprotrace", "patient", patientId, `ReproTrace updated: ${proposals.length} proposal(s), ${discrepanciesCount} discrepancy(ies).`);
  return { proposalsCount: proposals.length, discrepanciesCount };
}

/** Request clinician verification for an authenticated patient. */
export const requestClinicianVerification = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { licenceNo: string; registry: string; evidenceNote: string }) => {
    if (!input || typeof input !== "object") throw new Error("Expected an input object.");
    const licenceNo = String(input.licenceNo ?? "").trim().slice(0, 100);
    const registry = String(input.registry ?? "").trim().slice(0, 100);
    const evidenceNote = String(input.evidenceNote ?? "").trim().slice(0, 1000);
    if (!licenceNo || !registry) throw new Error("Licence number and medical registry are required.");
    return { licenceNo, registry, evidenceNote };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    const id = crypto.randomUUID();
    await sql`
      insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status)
      values (${id}, ${context.userId}, ${data.licenceNo}, ${data.registry}, ${data.evidenceNote}, 'pending')
    `;
    await audit(sql, context.userId, "request_clinician_verification", "clinician_verification", id, `Submitted licence ${data.licenceNo} (${data.registry}) for verification.`);
    return { ok: true, id, status: "pending" };
  });

/** Approve or revoke clinician verification. Admin only. */
export const verifyClinician = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { verificationId: string; decision: "verified" | "revoked"; reason: string }) => {
    if (input.decision !== "verified" && input.decision !== "revoked") {
      throw new Error("Decision must be verified or revoked.");
    }
    const reason = String(input.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new Error("A reason for the decision is required for auditing.");
    return { verificationId: input.verificationId, decision: input.decision, reason };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const callerRole = await roleOf(sql, context.userId);
    if (callerRole !== "admin") {
      throw new Error("Unauthorized: Only administrators can approve or revoke clinician verifications.");
    }
    const vRows = await sql<{ id: string; user_id: string }>`
      select id, user_id from clinician_verifications where id = ${data.verificationId}
    `;
    if (!vRows.length) throw new Error("Verification request not found.");
    const targetUserId = vRows[0].user_id;

    if (data.decision === "revoked") {
      const targetRole = await roleOf(sql, targetUserId);
      if (targetRole === "admin") {
        const adminCount = await sql<{ count: number }>`select count(*)::int as count from profiles where role = 'admin'`;
        if (asNumber(adminCount[0]?.count) <= 1) {
          throw new Error("Action rejected: Cannot revoke or demote the last remaining administrator.");
        }
      }
    }

    const newRole = data.decision === "verified" ? "clinician" : "patient";
    await sql`
      update clinician_verifications
      set status = ${data.decision}, decided_by = ${context.userId}, decided_at = now(), reason = ${data.reason}
      where id = ${data.verificationId}
    `;
    await sql`update profiles set role = ${newRole} where user_id = ${targetUserId}`;
    await audit(
      sql,
      context.userId,
      data.decision === "verified" ? "verify_clinician" : "revoke_clinician",
      "clinician_verification",
      data.verificationId,
      `User ${targetUserId} ${data.decision} (role -> ${newRole}): ${data.reason}`,
    );
    return { ok: true, status: data.decision, targetUserId, newRole };
  });


export type VerificationViewItem = {
  id: string;
  user_id: string;
  licence_no: string;
  registry: string;
  evidence_note: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string;
  requested_at: string;
  display_name: string | null;
  current_role: string | null;
};

export type VerificationStatusItem = {
  id: string;
  licence_no: string;
  registry: string;
  evidence_note: string;
  status: string;
  decided_at: string | null;
  reason: string;
  requested_at: string;
};

/** List all pending and historical clinician verifications. Admin only. */
export const listPendingClinicians = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const callerRole = await roleOf(sql, context.userId);
    if (callerRole !== "admin") {
      throw new Error("Unauthorized: Only administrators can view clinician verifications.");
    }
    return sql<VerificationViewItem>`
      select
        v.id, v.user_id, v.licence_no, v.registry, v.evidence_note, v.status,
        v.decided_by, v.decided_at, v.reason, v.requested_at,
        p.display_name, p.role as current_role
      from clinician_verifications v
      left join profiles p on p.user_id = v.user_id
      order by v.requested_at desc
    `;
  });

/** Get verification status for the current user. */
export const getVerificationStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<VerificationStatusItem>`
      select id, licence_no, registry, evidence_note, status, decided_at, reason, requested_at
      from clinician_verifications
      where user_id = ${context.userId}
      order by requested_at desc limit 1
    `;
    return rows[0] ?? null;
  });

/** Save a 3D volume registration result across studies. Clinician only. */
export const saveVolumeRegistration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    patientId: string;
    fixedSeriesId: string;
    movingSeriesId: string;
    nccScore: number;
    residualMm: number;
    transformMatrix: number[];
    status?: "verified" | "unverified" | "failed";
  }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Saving registration is a clinician action.");
    const id = crypto.randomUUID();
    await sql`
      insert into registrations (
        id, user_id, patient_id, fixed_series_id, moving_series_id, ncc_score, residual_mm, transform_matrix_json, status
      ) values (
        ${id}, ${context.userId}, ${data.patientId}, ${data.fixedSeriesId}, ${data.movingSeriesId},
        ${data.nccScore}, ${data.residualMm}, ${JSON.stringify(data.transformMatrix)}, ${data.status ?? "unverified"}
      )
    `;
    await audit(sql, context.userId, "save_registration", "registration", id, `Rigid volume registration stored. NCC: ${data.nccScore.toFixed(3)}, Residual: ${data.residualMm.toFixed(2)} mm`);
    await recomputeReproTrace(sql, context.userId, data.patientId).catch(() => null);
    return { ok: true, id };
  });

/** Save structured Endometriosis clinical record. */
export const saveEndometriosisRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; lesionSites: string[]; surgicalHistory: string; stagingRASRM?: string; imagingNote: string }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Entering endometriosis clinical records is a clinician action.");
    const id = crypto.randomUUID();
    await sql`
      insert into pathway_endometriosis_records (
        id, user_id, patient_id, lesion_sites_json, surgical_history, staging_rASRM, imaging_note
      ) values (
        ${id}, ${context.userId}, ${data.patientId}, ${JSON.stringify(data.lesionSites)},
        ${data.surgicalHistory}, ${data.stagingRASRM ?? null}, ${data.imagingNote}
      )
    `;
    await audit(sql, context.userId, "save_endometriosis_record", "endometriosis_record", id, `Sites: ${data.lesionSites.join(", ")}; Staging: ${data.stagingRASRM ?? "N/A"}`);
    return { ok: true, id };
  });

/** Get structured Endometriosis clinical records for a patient. */
export const getEndometriosisRecords = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const sql = await getSql();
    return sql<EndometriosisRecordItem>`
      select id, lesion_sites_json, surgical_history, staging_rASRM, imaging_note, created_at
      from pathway_endometriosis_records
      where patient_id = ${patientId} and user_id = ${context.userId}
      order by created_at desc
    `;
  });

/** Save structured Ovarian Cyst clinical record. */
export const saveOvarianCystRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; laterality: "left" | "right" | "bilateral"; maxDiameterMm: number; featuresText: string; followUpMonths?: number; clinicalNote: string }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Entering ovarian cyst clinical records is a clinician action.");
    const id = crypto.randomUUID();
    await sql`
      insert into pathway_ovarian_cyst_records (
        id, user_id, patient_id, laterality, max_diameter_mm, features_text, follow_up_months, clinical_note
      ) values (
        ${id}, ${context.userId}, ${data.patientId}, ${data.laterality},
        ${data.maxDiameterMm}, ${data.featuresText}, ${data.followUpMonths ?? null}, ${data.clinicalNote}
      )
    `;
    await audit(sql, context.userId, "save_ovarian_cyst_record", "ovarian_cyst_record", id, `${data.laterality} cyst, diameter: ${data.maxDiameterMm}mm`);
    return { ok: true, id };
  });

/** Get structured Ovarian Cyst clinical records for a patient. */
export const getOvarianCystRecords = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const sql = await getSql();
    return sql<OvarianCystRecordItem>`
      select id, laterality, max_diameter_mm, features_text, follow_up_months, clinical_note, created_at
      from pathway_ovarian_cyst_records
      where patient_id = ${patientId} and user_id = ${context.userId}
      order by created_at desc
    `;
  });

/** Save structured PCOS clinical assessment (Rotterdam Criteria). */
export const savePcosAssessment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    patientId: string;
    cycleIrregularity: boolean;
    hyperandrogenismClinical: boolean;
    hyperandrogenismBiochemical: boolean;
    ultrasoundOrAmhFeatures: boolean;
    notes: string;
  }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const role = await roleOf(sql, context.userId);
    if (role !== "clinician" && role !== "admin") throw new Error("Entering PCOS assessments is a clinician action.");
    const hyperandrogenism = data.hyperandrogenismClinical || data.hyperandrogenismBiochemical;
    const criteriaCount = [data.cycleIrregularity, hyperandrogenism, data.ultrasoundOrAmhFeatures].filter(Boolean).length;
    const rotterdamMet = criteriaCount >= 2;

    const id = crypto.randomUUID();
    await sql`
      insert into pathway_pcos_assessments (
        id, user_id, patient_id, cycle_irregularity, hyperandrogenism_clinical, hyperandrogenism_biochemical,
        ultrasound_or_amh_features, rotterdam_criteria_met, notes
      ) values (
        ${id}, ${context.userId}, ${data.patientId}, ${data.cycleIrregularity}, ${data.hyperandrogenismClinical},
        ${data.hyperandrogenismBiochemical}, ${data.ultrasoundOrAmhFeatures}, ${rotterdamMet}, ${data.notes}
      )
    `;
    await audit(sql, context.userId, "save_pcos_assessment", "pcos_assessment", id, `Rotterdam criteria met: ${rotterdamMet} (${criteriaCount}/3 features)`);
    return { ok: true, id, rotterdamCriteriaMet: rotterdamMet };
  });

/** Get structured PCOS clinical assessments for a patient. */
export const getPcosAssessments = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const sql = await getSql();
    return sql<PcosAssessmentItem>`
      select id, cycle_irregularity, hyperandrogenism_clinical, hyperandrogenism_biochemical,
             ultrasound_or_amh_features, rotterdam_criteria_met, notes, created_at
      from pathway_pcos_assessments
      where patient_id = ${patientId} and user_id = ${context.userId}
      order by created_at desc
    `;
  });
