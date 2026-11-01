import { createServerFn } from "@tanstack/react-start";
import { getSql, type Sql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { ENGINE_VERSION } from "../reprotrace/engine";
import { insertLabVersion } from "./lab-version";
import { applyMenarcheYear } from "./menarche";
import { ingestReport, linkReportQuote, type IngestInput, type QuoteLinkInput } from "../reports/store";
import type { ExportPayload, VersionRow, Workspace } from "./types";
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
    const [profiles, patients, studies, series, reports, findings, versions, evidence, symptoms, cycles, labs, correspondences, decisions, discrepancies, reviews, consents, uploads, auditRows, extractions] =
      await Promise.all([
        sql<{ user_id: string; display_name: string; role: string; active_patient_id: string | null }>`select user_id, display_name, role, active_patient_id from profiles where user_id = ${userId}`,
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
      ]);
    const versionsOut: VersionRow[] = (versions as Record<string, unknown>[]).map((v) => ({
      ...(v as object),
      centroid_mm: parseTriple(v.centroid_mm),
      axes_mm: parseTriple(v.axes_mm),
      longest_mm: v.longest_mm == null ? null : Number(v.longest_mm),
      report_longest_mm: v.report_longest_mm == null ? null : Number(v.report_longest_mm),
    })) as VersionRow[];
    const workspace: Workspace = {
      profile: profiles[0] ?? {
        user_id: userId,
        display_name: "",
        role: "clinician",
        active_patient_id: null,
      },
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
      models: MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        status: model.status,
        note: model.note,
      })),
      engineVersion: ENGINE_VERSION,
    };
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
    if (role === "patient") throw new Error("Verification is a clinician action.");
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
    if (role === "patient") throw new Error("Edits are a clinician action.");
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
    if (role === "patient") throw new Error("Recording a measurement is a clinician action.");
    const id = await insertLabVersion(sql, context.userId, data);
    await audit(sql, context.userId, "new_version", "finding_version", id, "Volume lab measurement recorded as a new version. Prior versions were not overwritten.");
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
    if (role === "patient") throw new Error("Correspondence decisions are a clinician action.");
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
    if (role === "patient") throw new Error("Discrepancy resolution is a clinician action.");
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
    if ((await roleOf(sql, context.userId)) === "patient") throw new Error("Report upload is a clinician action in this prototype.");
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
    if ((await roleOf(sql, context.userId)) === "patient") throw new Error("Linking evidence is a clinician action.");
    const id = await linkReportQuote(sql, context.userId, data);
    await audit(sql, context.userId, "link_evidence", "finding_version", data.findingVersionId, `Report quote [${data.start}, ${data.end}) linked. The version itself was not changed.`);
    return { ok: true, id };
  });
