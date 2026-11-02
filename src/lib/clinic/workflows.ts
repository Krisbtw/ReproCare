/**
 * Condition-Specific Reproductive Healthcare Workflows & Unified Patient History
 * (Sprint 5 Task 2A, 2B, 2C, 2D, 2E, 2F).
 *
 * Pathways supported:
 * 1. Uterine Fibroids (`fibroids`)
 * 2. Endometriosis (`endometriosis`)
 * 3. Ovarian Cysts (`cyst` / `ovarian_cyst`)
 * 4. Polycystic Ovary Syndrome (`pcos`)
 *
 * Six-Tier Evidence Provenance (`ConditionEvidenceTier`):
 * 1. `patient_reported`               - Patient-entered symptoms, menstrual dates, and self-reported history
 * 2. `imaging_observation`            - Original DICOM studies/series and clinician caliper/seeded measurements
 * 3. `report_extracted`               - Verbatim quotes and rule-extracted values from uploaded clinical reports
 * 4. `ai_experimental`                - Unconfirmed AI segmentation outputs and unreviewed AI report summaries
 * 5. `clinician_reviewed`             - Findings or extractions reviewed by an authorized verified clinician
 * 6. `clinician_confirmed_assessment` - Clinically confirmed pathway assessments signed off by an authorized clinician
 */

import type { Sql } from "../db.ts";
import { pcosContext, cycleBand } from "./pcos-context.ts";

export const CONDITION_EVIDENCE_TIERS = [
  "patient_reported",
  "imaging_observation",
  "report_extracted",
  "ai_experimental",
  "clinician_reviewed",
  "clinician_confirmed_assessment",
] as const;

export type ConditionEvidenceTier = (typeof CONDITION_EVIDENCE_TIERS)[number];

export type ClinicalReviewStatus =
  | "unreviewed"
  | "clinician_reviewed"
  | "clinician_confirmed_assessment"
  | "rejected";

export const VALID_FIGO_LEIOMYOMA_CODES = new Set([
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "2-5",
]);

export const VALID_CYST_MORPHOLOGY_CATEGORIES = new Set([
  "simple_unilocular",
  "hemorrhagic_classic",
  "endometrioma_ground_glass",
  "dermoid_mature_teratoma",
  "multilocular",
  "solid_component_or_papillary",
  "indeterminate_incomplete",
]);

export type CystMorphologyCategory =
  | "simple_unilocular"
  | "hemorrhagic_classic"
  | "endometrioma_ground_glass"
  | "dermoid_mature_teratoma"
  | "multilocular"
  | "solid_component_or_papillary"
  | "indeterminate_incomplete";

export interface FibroidPathwayRecord {
  id: string;
  user_id: string;
  patient_id: string;
  finding_id: string | null;
  finding_version_id: string | null;
  study_id: string | null;
  report_id: string | null;
  anatomical_location: string;
  figo_classification: string | null;
  figo_source: "not_assigned" | "report_stated" | "clinician_entered";
  axes_mm: [number, number, number] | null;
  longest_mm: number | null;
  volume_mm3: number | null;
  volume_estimation_method: string | null;
  segmentation_source: string | null;
  associated_symptoms: string[];
  longitudinal_comparison_note: string | null;
  evidence_tier: ConditionEvidenceTier;
  review_status: ClinicalReviewStatus;
  clinically_confirmed: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface EndometriosisPathwayRecord {
  id: string;
  user_id: string;
  patient_id: string;
  study_id: string | null;
  report_id: string | null;
  lesion_sites: string[];
  lesion_sites_json: string;
  imaging_status:
    | "clinician_reported_finding"
    | "normal_or_no_visible_lesion"
    | "uncertain_finding";
  normal_imaging_excludes_endometriosis: false;
  normal_imaging_limitation_note: string;
  symptom_infers_lesion_location: false;
  surgical_history: string;
  surgical_confirmation_status:
    | "not_performed"
    | "laparoscopy_confirmed"
    | "laparoscopy_negative"
    | "clinical_working_assessment";
  staging_rASRM: string | null;
  imaging_note: string;
  symptom_history: string[];
  menstrual_history_note: string | null;
  historical_comparison_note: string | null;
  evidence_tier: ConditionEvidenceTier;
  review_status: ClinicalReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface OvarianCystPathwayRecord {
  id: string;
  user_id: string;
  patient_id: string;
  study_id: string | null;
  report_id: string | null;
  laterality: "left" | "right" | "bilateral";
  anatomical_location: string;
  max_diameter_mm: number;
  axes_mm: [number, number, number] | null;
  morphology_category: CystMorphologyCategory;
  features_text: string;
  uncertainty_flag: boolean;
  uncertainty_note: string | null;
  benign_malignant_classified: false;
  historical_comparison: {
    previousRecordId: string | null;
    previousMaxDiameterMm: number | null;
    diameterDeltaMm: number | null;
    summary: string;
  } | null;
  associated_symptoms: string[];
  follow_up_months: number | null;
  clinical_note: string;
  evidence_tier: ConditionEvidenceTier;
  review_status: ClinicalReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface PcosHormoneLabs {
  totalTestosteroneNgDl?: number | null;
  freeTestosteronePgMl?: number | null;
  freeAndrogenIndex?: number | null;
  shbgNmolL?: number | null;
  amhNgMl?: number | null;
  lhIuL?: number | null;
  fshIuL?: number | null;
  tshMiuL?: number | null;
  prolactinNgMl?: number | null;
  seventeenOhProgesteroneNgDl?: number | null;
}

export interface PcosMetabolicContext {
  bmiKgM2?: number | null;
  fastingGlucoseMgDl?: number | null;
  hba1cPct?: number | null;
  bloodPressureMmHg?: string | null;
  lipidNotes?: string | null;
}

export interface PcosPathwayRecord {
  id: string;
  user_id: string;
  patient_id: string;
  study_id: string | null;
  assessment_cohort: "adult" | "adolescent_or_within_8y_menarche" | "age_unknown";
  gynecological_age_years: number | null;
  adult_criteria_allowed: boolean;
  ultrasound_used_as_supporting_only: true;
  diagnosis_from_ovarian_appearance_alone_blocked: true;
  cycle_irregularity: boolean;
  hyperandrogenism_clinical: boolean;
  hyperandrogenism_biochemical: boolean;
  ultrasound_or_amh_features: boolean;
  rotterdam_criteria_met: boolean;
  exclusion_mimickers_checked: boolean;
  hormone_labs: PcosHormoneLabs;
  metabolic_context: PcosMetabolicContext;
  guideline_headline: string;
  notes: string;
  evidence_tier: ConditionEvidenceTier;
  review_status: ClinicalReviewStatus;
  clinically_confirmed: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface UnifiedHistoryEntry {
  id: string;
  category:
    | "symptom"
    | "menstrual_cycle"
    | "laboratory"
    | "clinical_report"
    | "imaging_study"
    | "anatomical_finding"
    | "longitudinal_correspondence"
    | "pathway_fibroids"
    | "pathway_endometriosis"
    | "pathway_ovarian_cyst"
    | "pathway_pcos"
    | "clinician_review";
  pathway: "fibroids" | "endometriosis" | "cyst" | "pcos" | "general";
  observedOn: string;
  recordedAt: string;
  summary: string;
  detail: string;
  evidenceTier: ConditionEvidenceTier;
  reviewStatus: ClinicalReviewStatus;
  reviewedBy: string | null;
  sourceRefId: string;
}

export interface UnifiedPatientHistory {
  patient: {
    id: string;
    code: string;
    displayName: string;
    yearOfBirth: number | null;
    menarcheYear: number | null;
    primaryPathway: string;
    synopsis: string;
  };
  evidenceTierCounts: Record<ConditionEvidenceTier, number>;
  entries: UnifiedHistoryEntry[];
  fibroidAssessments: FibroidPathwayRecord[];
  endometriosisRecords: EndometriosisPathwayRecord[];
  ovarianCystRecords: OvarianCystPathwayRecord[];
  pcosAssessments: PcosPathwayRecord[];
}

const ENDOMETRIOSIS_NORMAL_IMAGING_LIMITATION =
  "A normal ultrasound or MRI examination does NOT exclude superficial peritoneal or deep infiltrating endometriosis. Symptoms alone do not localize lesions or establish a definitive diagnosis.";

const FORBIDDEN_ENDOMETRIOSIS_EXCLUSION_RE =
  /\b(normal (?:scan|mri|ultrasound|imaging|exam|examination) (?:excludes|rules out|disproves) endometriosis|endometriosis (?:is )?(?:excluded|ruled out) by (?:normal|negative) (?:imaging|mri|ultrasound|scan))\b/i;

const FORBIDDEN_SYMPTOM_LOCALIZATION_RE =
  /\b(pain (?:location )?(?:proves|localizes) lesion|symptom(?:s| location)? (?:identifies|localizes) lesion|diagnosed from symptoms alone)\b/i;

const FORBIDDEN_CYST_MALIGNANCY_CLAIM_RE =
  /\b(?:(?:definitive(?:ly)?|definitely) (?:benign|malignant)|malignancy confirmed|cancer confirmed|(?:risk(?: of malignancy)?|risk score)[:\s]+\d{1,3}\s*%|guaranteed benign)/i;

/**
 * Validates and normalizes an optional FIGO leiomyoma classification code.
 * Never invents a FIGO code when omitted; rejects invalid or fabricated codes.
 */
export function validateFigoClassification(
  rawFigo: string | null | undefined,
): string | null {
  if (rawFigo == null || String(rawFigo).trim() === "") {
    return null;
  }
  const cleaned = String(rawFigo)
    .trim()
    .replace(/^FIGO\s*(?:type|class)?\s*/i, "")
    .trim();
  if (!VALID_FIGO_LEIOMYOMA_CODES.has(cleaned)) {
    throw new Error(
      `Invalid or unsupported FIGO leiomyoma classification '${rawFigo}'. Valid PALM-COEIN leiomyoma types are 0, 1, 2, 3, 4, 5, 6, 7, 8, or hybrid 2-5. Do not invent FIGO classifications.`,
    );
  }
  return cleaned;
}

/**
 * Pathway 1: Uterine Fibroid Assessment Recording (Task 2A & 2F).
 * - Preserves unconfirmed status (`review_status: 'unreviewed'`) until reviewed by an authorized clinician.
 * - Distinguishes `ai_experimental` segmentation outputs from `imaging_observation` and `report_extracted`.
 * - Never invents a FIGO classification.
 */
export async function recordFibroidPathwayAssessment(
  sql: Sql,
  ownerUserId: string,
  actorUserId: string,
  input: {
    patientId: string;
    findingId?: string | null;
    findingVersionId?: string | null;
    studyId?: string | null;
    reportId?: string | null;
    anatomicalLocation: string;
    figoClassification?: string | null;
    figoSource?: "not_assigned" | "report_stated" | "clinician_entered";
    axesMm?: [number, number, number] | null;
    longestMm?: number | null;
    volumeMm3?: number | null;
    volumeEstimationMethod?: string | null;
    segmentationSource?: string | null;
    associatedSymptoms?: string[];
    longitudinalComparisonNote?: string | null;
    evidenceTier?: ConditionEvidenceTier;
    bleedingSeverity?: string | null;
    bulkSymptoms?: string[];
    clinicalNotes?: string | null;
    confirmAssessment?: boolean;
  },
): Promise<FibroidPathwayRecord> {
  const location = String(input.anatomicalLocation ?? "").trim();
  if (!location) {
    throw new Error("Anatomical location is required for a uterine fibroid pathway record.");
  }

  const normalizedFigo = validateFigoClassification(input.figoClassification);
  const figoSource: FibroidPathwayRecord["figo_source"] = normalizedFigo
    ? (input.figoSource ?? "clinician_entered")
    : "not_assigned";

  const axes = input.axesMm ?? null;
  if (axes && (axes.length !== 3 || axes.some((v) => !Number.isFinite(v) || v <= 0 || v > 350))) {
    throw new Error("Fibroid 3-axis dimensions must be three positive millimetre values (<= 350 mm).");
  }
  const longestMm =
    input.longestMm != null
      ? Number(input.longestMm)
      : axes
        ? Math.max(...axes)
        : null;
  const volumeMm3 =
    input.volumeMm3 != null
      ? Number(input.volumeMm3)
      : axes
        ? Math.round((4 / 3) * Math.PI * (axes[0] / 2) * (axes[1] / 2) * (axes[2] / 2))
        : null;
  const volumeMethod =
    input.volumeEstimationMethod ??
    (input.volumeMm3 != null
      ? "voxel_mask_integration"
      : axes
        ? "prolate_ellipsoid_pi_div_6"
        : null);

  const isAiExperimental =
    input.evidenceTier === "ai_experimental" ||
    (input.segmentationSource != null && /unet|ai|model/i.test(input.segmentationSource));

  const evidenceTier: ConditionEvidenceTier = isAiExperimental
    ? "ai_experimental"
    : (input.evidenceTier ?? (input.reportId ? "report_extracted" : "imaging_observation"));

  // Compute longitudinal comparison note against prior finding versions if findingId is supplied
  let longitudinalNote = input.longitudinalComparisonNote ?? null;
  if (!longitudinalNote && input.findingId) {
    const priorVersions = await sql<{
      version_no: number;
      observed_on: string;
      longest_mm: number | null;
    }>`
      select version_no, observed_on::text as observed_on, longest_mm
      from finding_versions
      where finding_id = ${input.findingId}
      order by observed_on desc, version_no desc
      limit 2
    `.catch(() => []);
    if (priorVersions.length > 0 && longestMm != null && priorVersions[0].longest_mm != null) {
      const prevLongest = Number(priorVersions[0].longest_mm);
      const delta = longestMm - prevLongest;
      longitudinalNote = `Compared with ${priorVersions[0].observed_on} (v${priorVersions[0].version_no}, ${prevLongest} mm): delta ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} mm.`;
    }
  }

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const symptomsList = (input.associatedSymptoms ?? []).map((s) => String(s).trim()).filter(Boolean);

  await sql`
    insert into pathway_fibroid_assessments (
      id, user_id, patient_id, finding_id, finding_version_id, study_id, report_id,
      anatomical_location, figo_classification, figo_source,
      axes_mm_json, longest_mm, volume_mm3, volume_estimation_method,
      segmentation_source, associated_symptoms_json, longitudinal_comparison_note,
      evidence_tier, review_status, created_at
    ) values (
      ${id}, ${ownerUserId}, ${input.patientId},
      ${input.findingId ?? null}, ${input.findingVersionId ?? null},
      ${input.studyId ?? null}, ${input.reportId ?? null},
      ${location}, ${normalizedFigo}, ${figoSource},
      ${axes ? JSON.stringify(axes) : null}, ${longestMm}, ${volumeMm3}, ${volumeMethod},
      ${input.segmentationSource ?? null}, ${JSON.stringify(symptomsList)}, ${longitudinalNote},
      ${evidenceTier}, 'unreviewed', ${nowIso}
    )
  `;

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()}, ${actorUserId}, 'record_fibroid_assessment', 'fibroid_assessment', ${id},
      ${`Location: ${location}; FIGO: ${normalizedFigo ?? "not assigned"} (${figoSource}); tier: ${evidenceTier}; status: unreviewed`}
    )
  `.catch(() => null);

  return {
    id,
    user_id: ownerUserId,
    patient_id: input.patientId,
    finding_id: input.findingId ?? null,
    finding_version_id: input.findingVersionId ?? null,
    study_id: input.studyId ?? null,
    report_id: input.reportId ?? null,
    anatomical_location: location,
    figo_classification: normalizedFigo,
    figo_source: figoSource,
    axes_mm: axes,
    longest_mm: longestMm,
    volume_mm3: volumeMm3,
    volume_estimation_method: volumeMethod,
    segmentation_source: input.segmentationSource ?? null,
    associated_symptoms: symptomsList,
    longitudinal_comparison_note: longitudinalNote,
    evidence_tier: evidenceTier,
    review_status: "unreviewed",
    clinically_confirmed: false,
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: nowIso,
  };
}

/**
 * Clinician review and approval of a Uterine Fibroid pathway assessment (Task 2A & 2F).
 */
export async function reviewFibroidPathwayAssessment(
  sql: Sql,
  clinicianUserId: string,
  input: {
    assessmentId: string;
    decision: "clinician_reviewed" | "clinician_confirmed_assessment" | "rejected";
    confirmedFigoClassification?: string | null;
    note: string;
  },
): Promise<FibroidPathwayRecord> {
  const note = String(input.note ?? "").trim();
  if (note.length < 4) {
    throw new Error("A clinician review note (at least 4 characters) is required.");
  }

  const rows = await sql<Record<string, unknown>>`
    select * from pathway_fibroid_assessments where id = ${input.assessmentId}
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("Fibroid pathway assessment not found.");
  }

  const updatedFigo =
    input.confirmedFigoClassification !== undefined
      ? validateFigoClassification(input.confirmedFigoClassification)
      : ((row.figo_classification as string | null) ?? null);
  const updatedFigoSource =
    input.confirmedFigoClassification !== undefined && updatedFigo
      ? "clinician_entered"
      : ((row.figo_source as FibroidPathwayRecord["figo_source"]) ?? "not_assigned");

  const newTier: ConditionEvidenceTier =
    input.decision === "clinician_confirmed_assessment"
      ? "clinician_confirmed_assessment"
      : input.decision === "clinician_reviewed"
        ? "clinician_reviewed"
        : ((row.evidence_tier as ConditionEvidenceTier) ?? "imaging_observation");

  const nowIso = new Date().toISOString();
  await sql`
    update pathway_fibroid_assessments
    set figo_classification = ${updatedFigo},
        figo_source = ${updatedFigoSource},
        evidence_tier = ${newTier},
        review_status = ${input.decision},
        reviewed_by = ${clinicianUserId},
        reviewed_at = ${nowIso},
        review_note = ${note}
    where id = ${input.assessmentId}
  `;

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()}, ${clinicianUserId}, 'review_fibroid_assessment', 'fibroid_assessment', ${input.assessmentId},
      ${`Decision: ${input.decision}; FIGO: ${updatedFigo ?? "not assigned"}; note: ${note}`}
    )
  `.catch(() => null);

  return {
    id: String(row.id),
    user_id: String(row.user_id),
    patient_id: String(row.patient_id),
    finding_id: (row.finding_id as string | null) ?? null,
    finding_version_id: (row.finding_version_id as string | null) ?? null,
    study_id: (row.study_id as string | null) ?? null,
    report_id: (row.report_id as string | null) ?? null,
    anatomical_location: String(row.anatomical_location),
    figo_classification: updatedFigo,
    figo_source: updatedFigoSource,
    axes_mm: row.axes_mm_json ? (JSON.parse(String(row.axes_mm_json)) as [number, number, number]) : null,
    longest_mm: row.longest_mm != null ? Number(row.longest_mm) : null,
    volume_mm3: row.volume_mm3 != null ? Number(row.volume_mm3) : null,
    volume_estimation_method: (row.volume_estimation_method as string | null) ?? null,
    segmentation_source: (row.segmentation_source as string | null) ?? null,
    associated_symptoms: row.associated_symptoms_json
      ? (JSON.parse(String(row.associated_symptoms_json)) as string[])
      : [],
    longitudinal_comparison_note: (row.longitudinal_comparison_note as string | null) ?? null,
    evidence_tier: newTier,
    review_status: input.decision,
    clinically_confirmed: input.decision === "clinician_confirmed_assessment",
    reviewed_by: clinicianUserId,
    reviewed_at: nowIso,
    review_note: note,
    created_at: String(row.created_at),
  };
}

export async function listFibroidPathwayAssessments(
  sql: Sql,
  patientId: string,
): Promise<FibroidPathwayRecord[]> {
  const rows = await sql<Record<string, unknown>>`
    select * from pathway_fibroid_assessments
    where patient_id = ${patientId}
    order by created_at desc
  `.catch(() => []);

  return rows.map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id),
    patient_id: String(row.patient_id),
    finding_id: (row.finding_id as string | null) ?? null,
    finding_version_id: (row.finding_version_id as string | null) ?? null,
    study_id: (row.study_id as string | null) ?? null,
    report_id: (row.report_id as string | null) ?? null,
    anatomical_location: String(row.anatomical_location),
    figo_classification: (row.figo_classification as string | null) ?? null,
    figo_source: (row.figo_source as FibroidPathwayRecord["figo_source"]) ?? "not_assigned",
    axes_mm: row.axes_mm_json ? (JSON.parse(String(row.axes_mm_json)) as [number, number, number]) : null,
    longest_mm: row.longest_mm != null ? Number(row.longest_mm) : null,
    volume_mm3: row.volume_mm3 != null ? Number(row.volume_mm3) : null,
    volume_estimation_method: (row.volume_estimation_method as string | null) ?? null,
    segmentation_source: (row.segmentation_source as string | null) ?? null,
    associated_symptoms: row.associated_symptoms_json
      ? (JSON.parse(String(row.associated_symptoms_json)) as string[])
      : [],
    longitudinal_comparison_note: (row.longitudinal_comparison_note as string | null) ?? null,
    evidence_tier: (row.evidence_tier as ConditionEvidenceTier) ?? "imaging_observation",
    review_status: (row.review_status as ClinicalReviewStatus) ?? "unreviewed",
    clinically_confirmed: row.review_status === "clinician_confirmed_assessment",
    reviewed_by: (row.reviewed_by as string | null) ?? null,
    reviewed_at: (row.reviewed_at as string | null) ?? null,
    review_note: (row.review_note as string | null) ?? null,
    created_at: String(row.created_at),
  }));
}

/**
 * Pathway 2: Endometriosis Evidence & History Recording (Task 2B & 2F).
 *
 * Clinical Safeguards Enforced:
 * 1. A normal imaging examination (`imagingStatus === "normal_or_no_visible_lesion"`) MUST NEVER
 *    be treated as excluding endometriosis. Any text claiming normal imaging excludes endometriosis is rejected.
 * 2. Patient-reported symptoms do NOT localize anatomical lesions or establish severity/staging.
 * 3. Never generates an autonomous diagnosis from symptoms or imaging alone.
 */
export async function recordEndometriosisPathwayAssessment(
  sql: Sql,
  ownerUserId: string,
  actorUserId: string,
  input: {
    patientId: string;
    studyId?: string | null;
    reportId?: string | null;
    lesionSites: string[];
    imagingStatus?:
      | "clinician_reported_finding"
      | "normal_or_no_visible_lesion"
      | "uncertain_finding";
    surgicalHistory: string;
    surgicalConfirmationStatus?:
      | "not_performed"
      | "laparoscopy_confirmed"
      | "laparoscopy_negative"
      | "clinical_working_assessment";
    stagingRASRM?: string | null;
    imagingNote: string;
    symptomHistory?: string[];
    menstrualHistoryNote?: string | null;
    historicalComparisonNote?: string | null;
    evidenceTier?: ConditionEvidenceTier;
  },
): Promise<EndometriosisPathwayRecord> {
  const combinedText = `${input.imagingNote ?? ""} ${input.surgicalHistory ?? ""} ${input.historicalComparisonNote ?? ""}`;
  if (FORBIDDEN_ENDOMETRIOSIS_EXCLUSION_RE.test(combinedText)) {
    throw new Error(
      "Clinical safety constraint violation: A normal ultrasound or MRI examination must NEVER be treated as excluding endometriosis.",
    );
  }
  if (FORBIDDEN_SYMPTOM_LOCALIZATION_RE.test(combinedText)) {
    throw new Error(
      "Clinical safety constraint violation: Patient symptom locations must not be used to infer anatomical endometriosis lesion locations or severity.",
    );
  }

  const sites = (input.lesionSites ?? []).map((s) => s.trim()).filter(Boolean);
  const imagingStatus: EndometriosisPathwayRecord["imaging_status"] =
    input.imagingStatus ??
    (sites.length === 0 ||
    /\b(no visible lesion|normal scan|normal mri|normal ultrasound|unremarkable)\b/i.test(
      input.imagingNote,
    )
      ? "normal_or_no_visible_lesion"
      : /\b(uncertain|equivocal|questionable|possible)\b/i.test(input.imagingNote)
        ? "uncertain_finding"
        : "clinician_reported_finding");

  const surgicalConfirmationStatus = input.surgicalConfirmationStatus ?? "not_performed";
  const evidenceTier: ConditionEvidenceTier = input.evidenceTier ?? "clinician_reviewed";
  const symptomHistory = (input.symptomHistory ?? []).map((s) => s.trim()).filter(Boolean);

  // Build historical comparison note if prior endometriosis records exist for this patient
  let historicalComparisonNote = input.historicalComparisonNote ?? null;
  if (!historicalComparisonNote) {
    const priorRows = await sql<{ created_at: string; lesion_sites_json: string; imaging_note: string }>`
      select created_at::text as created_at, lesion_sites_json, imaging_note
      from pathway_endometriosis_records
      where patient_id = ${input.patientId}
      order by created_at desc
      limit 1
    `.catch(() => []);
    if (priorRows[0]) {
      historicalComparisonNote = `Prior record (${priorRows[0].created_at.slice(0, 10)}): sites ${priorRows[0].lesion_sites_json}; note: ${priorRows[0].imaging_note.slice(0, 120)}`;
    }
  }

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const sitesJson = JSON.stringify(sites);

  try {
    await sql`
      insert into pathway_endometriosis_records (
        id, user_id, patient_id, study_id, report_id, lesion_sites_json,
        imaging_status, normal_imaging_limitation_note, surgical_history,
        surgical_confirmation_status, staging_rASRM, imaging_note,
        symptom_history_json, menstrual_history_note, historical_comparison_note,
        evidence_tier, review_status, created_at
      ) values (
        ${id}, ${ownerUserId}, ${input.patientId},
        ${input.studyId ?? null}, ${input.reportId ?? null}, ${sitesJson},
        ${imagingStatus}, ${ENDOMETRIOSIS_NORMAL_IMAGING_LIMITATION}, ${input.surgicalHistory},
        ${surgicalConfirmationStatus}, ${input.stagingRASRM ?? null}, ${input.imagingNote},
        ${JSON.stringify(symptomHistory)}, ${input.menstrualHistoryNote ?? null}, ${historicalComparisonNote},
        ${evidenceTier}, 'unreviewed', ${nowIso}
      )
    `;
  } catch {
    await sql`
      insert into pathway_endometriosis_records (
        id, user_id, patient_id, lesion_sites_json, surgical_history, staging_rASRM, imaging_note
      ) values (
        ${id}, ${ownerUserId}, ${input.patientId}, ${sitesJson},
        ${input.surgicalHistory}, ${input.stagingRASRM ?? null}, ${input.imagingNote}
      )
    `;
  }

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()}, ${actorUserId}, 'save_endometriosis_record', 'endometriosis_record', ${id},
      ${`Imaging status: ${imagingStatus}; Sites: ${sites.join(", ") || "none visible (normal imaging does not exclude endometriosis)"}; Staging: ${input.stagingRASRM ?? "N/A"}`}
    )
  `.catch(() => null);

  return {
    id,
    user_id: ownerUserId,
    patient_id: input.patientId,
    study_id: input.studyId ?? null,
    report_id: input.reportId ?? null,
    lesion_sites: sites,
    lesion_sites_json: sitesJson,
    imaging_status: imagingStatus,
    normal_imaging_excludes_endometriosis: false,
    normal_imaging_limitation_note: ENDOMETRIOSIS_NORMAL_IMAGING_LIMITATION,
    symptom_infers_lesion_location: false,
    surgical_history: input.surgicalHistory,
    surgical_confirmation_status: surgicalConfirmationStatus,
    staging_rASRM: input.stagingRASRM ?? null,
    imaging_note: input.imagingNote,
    symptom_history: symptomHistory,
    menstrual_history_note: input.menstrualHistoryNote ?? null,
    historical_comparison_note: historicalComparisonNote,
    evidence_tier: evidenceTier,
    review_status: "unreviewed",
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: nowIso,
  };
}

/**
 * Pathway 3: Ovarian Cyst Assessment Recording (Task 2C & 2F).
 *
 * Clinical Safeguards Enforced:
 * 1. Never classifies cysts as definitively benign or malignant or invents risk scores/percentages.
 * 2. Explicitly records uncertainty when morphology or imaging characterization is incomplete.
 * 3. Computes longitudinal diameter comparison against prior ipsilateral cyst observations.
 */
export async function recordOvarianCystPathwayAssessment(
  sql: Sql,
  ownerUserId: string,
  actorUserId: string,
  input: {
    patientId: string;
    studyId?: string | null;
    reportId?: string | null;
    laterality: "left" | "right" | "bilateral";
    anatomicalLocation?: string;
    maxDiameterMm: number;
    axesMm?: [number, number, number] | null;
    morphologyCategory?: CystMorphologyCategory;
    featuresText: string;
    uncertaintyFlag?: boolean;
    uncertaintyNote?: string | null;
    associatedSymptoms?: string[];
    followUpMonths?: number | null;
    clinicalNote: string;
    evidenceTier?: ConditionEvidenceTier;
  },
): Promise<OvarianCystPathwayRecord> {
  if (!["left", "right", "bilateral"].includes(input.laterality)) {
    throw new Error("Cyst laterality must be 'left', 'right', or 'bilateral'.");
  }
  if (!Number.isFinite(input.maxDiameterMm) || input.maxDiameterMm <= 0 || input.maxDiameterMm > 350) {
    throw new Error("Cyst maximum diameter must be a positive number between 1 and 350 mm.");
  }

  const combinedText = `${input.featuresText ?? ""} ${input.clinicalNote ?? ""}`;
  if (FORBIDDEN_CYST_MALIGNANCY_CLAIM_RE.test(combinedText)) {
    throw new Error(
      "Clinical safety constraint violation: Do not classify ovarian cysts as definitively benign or malignant or invent unvalidated malignancy risk scores.",
    );
  }

  const morphologyCategory: CystMorphologyCategory =
    input.morphologyCategory ??
    (/\b(indeterminate|incomplete|uncertain|suboptimal)\b/i.test(combinedText)
      ? "indeterminate_incomplete"
      : /\b(hemorrhagic)\b/i.test(combinedText)
        ? "hemorrhagic_classic"
        : /\b(endometrioma|ground[\s-]*glass)\b/i.test(combinedText)
          ? "endometrioma_ground_glass"
          : /\b(dermoid|teratoma)\b/i.test(combinedText)
            ? "dermoid_mature_teratoma"
            : /\b(multilocular|septated)\b/i.test(combinedText)
              ? "multilocular"
              : "simple_unilocular");

  if (!VALID_CYST_MORPHOLOGY_CATEGORIES.has(morphologyCategory)) {
    throw new Error(`Unsupported cyst morphology category '${morphologyCategory}'.`);
  }

  const isUncertain =
    Boolean(input.uncertaintyFlag) ||
    morphologyCategory === "indeterminate_incomplete" ||
    /\b(uncertain|indeterminate|incomplete|limited)\b/i.test(combinedText);

  const uncertaintyNote = isUncertain
    ? (input.uncertaintyNote ??
      "Morphology or imaging characterization is incomplete/uncertain; requires dedicated sonographic/MRI follow-up and clinical correlation.")
    : null;

  // Historical measurement comparison against previous cyst record on the same side
  const priorRows = await sql<{
    id: string;
    max_diameter_mm: number;
    created_at: string;
  }>`
    select id, max_diameter_mm, created_at::text as created_at
    from pathway_ovarian_cyst_records
    where patient_id = ${input.patientId} and laterality = ${input.laterality}
    order by created_at desc
    limit 1
  `.catch(() => []);

  const historicalComparison: OvarianCystPathwayRecord["historical_comparison"] = priorRows[0]
    ? {
        previousRecordId: priorRows[0].id,
        previousMaxDiameterMm: Number(priorRows[0].max_diameter_mm),
        diameterDeltaMm: Number((input.maxDiameterMm - Number(priorRows[0].max_diameter_mm)).toFixed(1)),
        summary: `Previous ${input.laterality} cyst (${priorRows[0].created_at.slice(0, 10)}): ${priorRows[0].max_diameter_mm} mm -> current ${input.maxDiameterMm} mm (${input.maxDiameterMm - Number(priorRows[0].max_diameter_mm) >= 0 ? "+" : ""}${(input.maxDiameterMm - Number(priorRows[0].max_diameter_mm)).toFixed(1)} mm).`,
      }
    : null;

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const anatomicalLocation = (input.anatomicalLocation ?? `${input.laterality} ovary`).trim();
  const associatedSymptoms = (input.associatedSymptoms ?? []).map((s) => s.trim()).filter(Boolean);
  const evidenceTier: ConditionEvidenceTier = input.evidenceTier ?? "imaging_observation";

  try {
    await sql`
      insert into pathway_ovarian_cyst_records (
        id, user_id, patient_id, study_id, report_id, laterality, anatomical_location,
        max_diameter_mm, axes_mm_json, morphology_category, features_text,
        uncertainty_flag, uncertainty_note, historical_comparison_json,
        associated_symptoms_json, follow_up_months, clinical_note,
        evidence_tier, review_status, created_at
      ) values (
        ${id}, ${ownerUserId}, ${input.patientId},
        ${input.studyId ?? null}, ${input.reportId ?? null}, ${input.laterality}, ${anatomicalLocation},
        ${input.maxDiameterMm}, ${input.axesMm ? JSON.stringify(input.axesMm) : null},
        ${morphologyCategory}, ${input.featuresText},
        ${isUncertain}, ${uncertaintyNote}, ${historicalComparison ? JSON.stringify(historicalComparison) : null},
        ${JSON.stringify(associatedSymptoms)}, ${input.followUpMonths ?? null}, ${input.clinicalNote},
        ${evidenceTier}, 'unreviewed', ${nowIso}
      )
    `;
  } catch {
    await sql`
      insert into pathway_ovarian_cyst_records (
        id, user_id, patient_id, laterality, max_diameter_mm, features_text, follow_up_months, clinical_note
      ) values (
        ${id}, ${ownerUserId}, ${input.patientId}, ${input.laterality},
        ${input.maxDiameterMm}, ${input.featuresText}, ${input.followUpMonths ?? null}, ${input.clinicalNote}
      )
    `;
  }

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()}, ${actorUserId}, 'save_ovarian_cyst_record', 'ovarian_cyst_record', ${id},
      ${`${input.laterality} cyst (${anatomicalLocation}), diameter: ${input.maxDiameterMm}mm, morphology: ${morphologyCategory}, uncertain: ${isUncertain}`}
    )
  `.catch(() => null);

  return {
    id,
    user_id: ownerUserId,
    patient_id: input.patientId,
    study_id: input.studyId ?? null,
    report_id: input.reportId ?? null,
    laterality: input.laterality,
    anatomical_location: anatomicalLocation,
    max_diameter_mm: input.maxDiameterMm,
    axes_mm: input.axesMm ?? null,
    morphology_category: morphologyCategory,
    features_text: input.featuresText,
    uncertainty_flag: isUncertain,
    uncertainty_note: uncertaintyNote,
    benign_malignant_classified: false,
    historical_comparison: historicalComparison,
    associated_symptoms: associatedSymptoms,
    follow_up_months: input.followUpMonths ?? null,
    clinical_note: input.clinicalNote,
    evidence_tier: evidenceTier,
    review_status: "unreviewed",
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: nowIso,
  };
}

/**
 * Pathway 4: PCOS Clinical, Hormonal & Metabolic Assessment (Task 2D & 2F).
 *
 * Clinical Safeguards Enforced:
 * 1. Separate clinical & hormonal pathway — NEVER treated as an ovarian segmentation problem.
 * 2. Adult vs Adolescent separation:
 *    - When gynecological age < 8 years post-menarche or chronological age < 20 (`level !== "adult-default"`):
 *      - `adult_criteria_allowed = false`
 *      - Does NOT apply adult Rotterdam 2-of-3 criteria (`rotterdam_criteria_met = false`)
 *      - Blocks using ultrasound polycystic ovarian morphology (PCOM) as a diagnostic criterion.
 * 3. Never diagnoses PCOS from ovarian appearance alone: if only `ultrasoundOrAmhFeatures` is true
 *    without ovulatory dysfunction or hyperandrogenism, `rotterdam_criteria_met` is always `false`.
 * 4. Requires clinician review before any assessment is marked clinically confirmed.
 */
export async function recordPcosPathwayAssessment(
  sql: Sql,
  ownerUserId: string,
  actorUserId: string,
  input: {
    patientId: string;
    studyId?: string | null;
    cycleIrregularity: boolean;
    hyperandrogenismClinical: boolean;
    hyperandrogenismBiochemical: boolean;
    ultrasoundOrAmhFeatures: boolean;
    exclusionMimickersChecked?: boolean;
    hormoneLabs?: PcosHormoneLabs;
    metabolicContext?: PcosMetabolicContext;
    notes: string;
    referenceYear?: number;
  },
): Promise<PcosPathwayRecord> {
  const pRows = await sql<{
    id: string;
    year_of_birth: number | null;
    menarche_year: number | null;
  }>`
    select id, year_of_birth, menarche_year from patients where id = ${input.patientId}
  `;
  const patient = pRows[0];
  if (!patient) {
    throw new Error("Patient record not found.");
  }

  const refYear = input.referenceYear ?? new Date().getFullYear();
  const yob = patient.year_of_birth != null ? Number(patient.year_of_birth) : null;
  const menarche = patient.menarche_year != null ? Number(patient.menarche_year) : null;
  const ctx = pcosContext(yob, refYear, menarche);

  const assessmentCohort: PcosPathwayRecord["assessment_cohort"] =
    ctx.level === "adult-default" || ctx.level === "menarche-8-plus"
      ? "adult"
      : ctx.level === "adolescent-possible" ||
          ctx.level === "menarche-under-8" ||
          ctx.level === "menarche-boundary-8"
        ? "adolescent_or_within_8y_menarche"
        : "age_unknown";
  const gynAgeYears = ctx.gynAge ? ctx.gynAge.years : null;

  const adultCriteriaAllowed = assessmentCohort === "adult";
  const hyperandrogenism = input.hyperandrogenismClinical || input.hyperandrogenismBiochemical;

  // In adolescents or when age/gynecological age < 8y post-menarche:
  // Ultrasound PCOM is NEVER counted as a criterion, and adult Rotterdam 2-of-3 criteria are NOT applied.
  // Furthermore, ovarian appearance alone NEVER diagnoses PCOS in any cohort.
  const effectiveUltrasoundCriterion = adultCriteriaAllowed ? input.ultrasoundOrAmhFeatures : false;
  const criteriaCount = [
    input.cycleIrregularity,
    hyperandrogenism,
    effectiveUltrasoundCriterion,
  ].filter(Boolean).length;

  const rotterdamMet = adultCriteriaAllowed && criteriaCount >= 2;
  const exclusionChecked = Boolean(input.exclusionMimickersChecked);
  const hormoneLabs: PcosHormoneLabs = input.hormoneLabs ?? {};
  const metabolicContext: PcosMetabolicContext = input.metabolicContext ?? {};

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  try {
    await sql`
      insert into pathway_pcos_assessments (
        id, user_id, patient_id, study_id, assessment_cohort, gynecological_age_years,
        adult_criteria_allowed, ultrasound_used_as_supporting_only,
        cycle_irregularity, hyperandrogenism_clinical, hyperandrogenism_biochemical,
        ultrasound_or_amh_features, rotterdam_criteria_met, exclusion_mimickers_checked,
        hormone_labs_json, metabolic_context_json, notes,
        evidence_tier, review_status, created_at
      ) values (
        ${id}, ${ownerUserId}, ${input.patientId}, ${input.studyId ?? null},
        ${assessmentCohort}, ${gynAgeYears},
        ${adultCriteriaAllowed}, ${true},
        ${input.cycleIrregularity}, ${input.hyperandrogenismClinical},
        ${input.hyperandrogenismBiochemical}, ${input.ultrasoundOrAmhFeatures},
        ${rotterdamMet}, ${exclusionChecked},
        ${JSON.stringify(hormoneLabs)}, ${JSON.stringify(metabolicContext)}, ${input.notes},
        'clinician_reviewed', 'unreviewed', ${nowIso}
      )
    `;
  } catch {
    await sql`
      insert into pathway_pcos_assessments (
        id, user_id, patient_id, cycle_irregularity, hyperandrogenism_clinical, hyperandrogenism_biochemical,
        ultrasound_or_amh_features, rotterdam_criteria_met, notes
      ) values (
        ${id}, ${ownerUserId}, ${input.patientId}, ${input.cycleIrregularity}, ${input.hyperandrogenismClinical},
        ${input.hyperandrogenismBiochemical}, ${input.ultrasoundOrAmhFeatures}, ${rotterdamMet}, ${input.notes}
      )
    `;
  }

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()}, ${actorUserId}, 'save_pcos_assessment', 'pcos_assessment', ${id},
      ${`Cohort: ${assessmentCohort} (gynAge: ${gynAgeYears ?? "unknown"}); adult criteria allowed: ${adultCriteriaAllowed}; Rotterdam met: ${rotterdamMet}`}
    )
  `.catch(() => null);

  return {
    id,
    user_id: ownerUserId,
    patient_id: input.patientId,
    study_id: input.studyId ?? null,
    assessment_cohort: assessmentCohort,
    gynecological_age_years: gynAgeYears,
    adult_criteria_allowed: adultCriteriaAllowed,
    ultrasound_used_as_supporting_only: true,
    diagnosis_from_ovarian_appearance_alone_blocked: true,
    cycle_irregularity: input.cycleIrregularity,
    hyperandrogenism_clinical: input.hyperandrogenismClinical,
    hyperandrogenism_biochemical: input.hyperandrogenismBiochemical,
    ultrasound_or_amh_features: input.ultrasoundOrAmhFeatures,
    rotterdam_criteria_met: rotterdamMet,
    exclusion_mimickers_checked: exclusionChecked,
    hormone_labs: hormoneLabs,
    metabolic_context: metabolicContext,
    guideline_headline: ctx.headline,
    notes: input.notes,
    evidence_tier: "clinician_reviewed",
    review_status: "unreviewed",
    clinically_confirmed: false,
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: nowIso,
  };
}

/**
 * Clinician review and sign-off for any condition-specific pathway record (Fibroids, Endometriosis, Ovarian Cyst, or PCOS).
 */
export async function reviewConditionPathwayRecord(
  sql: Sql,
  clinicianUserId: string,
  input: {
    pathway: "fibroids" | "endometriosis" | "ovarian_cyst" | "pcos";
    recordId: string;
    decision: "clinician_reviewed" | "clinician_confirmed_assessment" | "rejected";
    note: string;
  },
): Promise<{
  ok: true;
  pathway: string;
  recordId: string;
  reviewStatus: ClinicalReviewStatus;
  evidenceTier: ConditionEvidenceTier;
  reviewedBy: string;
  reviewedAt: string;
}> {
  const note = String(input.note ?? "").trim();
  if (note.length < 4) {
    throw new Error("A clinician review note (at least 4 characters) is required.");
  }
  const nowIso = new Date().toISOString();
  const newTier: ConditionEvidenceTier =
    input.decision === "clinician_confirmed_assessment"
      ? "clinician_confirmed_assessment"
      : "clinician_reviewed";

  if (input.pathway === "fibroids") {
    await reviewFibroidPathwayAssessment(sql, clinicianUserId, {
      assessmentId: input.recordId,
      decision: input.decision,
      note,
    });
  } else if (input.pathway === "endometriosis") {
    const r = await sql<{ id: string }>`select id from pathway_endometriosis_records where id = ${input.recordId}`;
    if (!r[0]) throw new Error("Endometriosis pathway record not found.");
    await sql`
      update pathway_endometriosis_records
      set evidence_tier = ${newTier},
          review_status = ${input.decision},
          reviewed_by = ${clinicianUserId},
          reviewed_at = ${nowIso},
          review_note = ${note}
      where id = ${input.recordId}
    `;
  } else if (input.pathway === "ovarian_cyst") {
    const r = await sql<{ id: string }>`select id from pathway_ovarian_cyst_records where id = ${input.recordId}`;
    if (!r[0]) throw new Error("Ovarian cyst pathway record not found.");
    await sql`
      update pathway_ovarian_cyst_records
      set evidence_tier = ${newTier},
          review_status = ${input.decision},
          reviewed_by = ${clinicianUserId},
          reviewed_at = ${nowIso},
          review_note = ${note}
      where id = ${input.recordId}
    `;
  } else if (input.pathway === "pcos") {
    const r = await sql<{
      id: string;
      assessment_cohort?: string;
      exclusion_mimickers_checked?: boolean;
    }>`
      select id, assessment_cohort, exclusion_mimickers_checked
      from pathway_pcos_assessments
      where id = ${input.recordId}
    `;
    if (!r[0]) throw new Error("PCOS pathway assessment not found.");
    if (
      input.decision === "clinician_confirmed_assessment" &&
      r[0].assessment_cohort === "adolescent_or_within_8y_menarche"
    ) {
      throw new Error(
        "Clinical guideline safeguard: Adult diagnostic PCOS confirmation cannot be signed off for an adolescent (<8 years post-menarche); use 'clinician_reviewed' for longitudinal adolescent surveillance.",
      );
    }
    await sql`
      update pathway_pcos_assessments
      set evidence_tier = ${newTier},
          review_status = ${input.decision},
          reviewed_by = ${clinicianUserId},
          reviewed_at = ${nowIso},
          review_note = ${note}
      where id = ${input.recordId}
    `;
  } else {
    throw new Error(`Unknown condition pathway '${input.pathway}'.`);
  }

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()}, ${clinicianUserId}, 'review_pathway_record', ${input.pathway}, ${input.recordId},
      ${`Decision: ${input.decision} (${newTier}): ${note}`}
    )
  `.catch(() => null);

  return {
    ok: true,
    pathway: input.pathway,
    recordId: input.recordId,
    reviewStatus: input.decision,
    evidenceTier: newTier,
    reviewedBy: clinicianUserId,
    reviewedAt: nowIso,
  };
}

/**
 * Task 2E & 2F: Unified Patient History across all 4 reproductive healthcare workflows
 * and all 6 evidence provenance tiers (`patient_reported`, `imaging_observation`,
 * `report_extracted`, `ai_experimental`, `clinician_reviewed`, `clinician_confirmed_assessment`).
 *
 * Preserves the exact source, timestamp, and pathway of every observation without merging
 * separate conditions or findings.
 */
export async function getUnifiedPatientHistory(
  sql: Sql,
  patientId: string,
): Promise<UnifiedPatientHistory> {
  const pRows = await sql<{
    id: string;
    code: string;
    display_name: string;
    year_of_birth: number | null;
    menarche_year: number | null;
    pathway: string;
    synopsis: string;
  }>`
    select id, code, display_name, year_of_birth, menarche_year, pathway, synopsis
    from patients
    where id = ${patientId}
  `;
  const patient = pRows[0];
  if (!patient) {
    throw new Error("Patient record not found.");
  }

  const [
    symptoms,
    cycles,
    labs,
    studies,
    reports,
    findings,
    versions,
    reviews,
    fibroidAssessments,
    endoRows,
    cystRows,
    pcosRows,
  ] = await Promise.all([
    sql<Record<string, unknown>>`select * from symptoms where patient_id = ${patientId} order by recorded_on desc`,
    sql<Record<string, unknown>>`select * from cycles where patient_id = ${patientId} order by start_date desc`,
    sql<Record<string, unknown>>`select * from labs where patient_id = ${patientId} order by observed_on desc`,
    sql<Record<string, unknown>>`select * from studies where patient_id = ${patientId} order by study_date desc`,
    sql<Record<string, unknown>>`
      select r.*, s.study_date
      from reports r
      join studies s on s.id = r.study_id
      where s.patient_id = ${patientId}
      order by r.report_date desc
    `,
    sql<Record<string, unknown>>`select * from findings where patient_id = ${patientId}`,
    sql<Record<string, unknown>>`
      select fv.*, f.code as finding_code, f.structure, f.pathway as finding_pathway
      from finding_versions fv
      join findings f on f.id = fv.finding_id
      where f.patient_id = ${patientId}
      order by fv.observed_on desc, fv.version_no desc
    `,
    sql<Record<string, unknown>>`select * from reviews order by created_at desc`.catch(() => []),
    listFibroidPathwayAssessments(sql, patientId),
    sql<Record<string, unknown>>`select * from pathway_endometriosis_records where patient_id = ${patientId} order by created_at desc`.catch(() => []),
    sql<Record<string, unknown>>`select * from pathway_ovarian_cyst_records where patient_id = ${patientId} order by created_at desc`.catch(() => []),
    sql<Record<string, unknown>>`select * from pathway_pcos_assessments where patient_id = ${patientId} order by created_at desc`.catch(() => []),
  ]);

  const entries: UnifiedHistoryEntry[] = [];
  const primaryPathway = (patient.pathway as UnifiedHistoryEntry["pathway"]) || "general";

  // 1. Symptoms (patient_reported)
  for (const s of symptoms) {
    entries.push({
      id: `sym:${String(s.id)}`,
      category: "symptom",
      pathway: primaryPathway,
      observedOn: String(s.recorded_on).slice(0, 10),
      recordedAt: String(s.recorded_on),
      summary: `Patient-reported symptom: ${String(s.region)} (${String(s.intensity)}/10)`,
      detail: `${String(s.description)} [Patient-reported; does not localize anatomical lesions or establish a diagnosis]`,
      evidenceTier: "patient_reported",
      reviewStatus: "unreviewed",
      reviewedBy: null,
      sourceRefId: String(s.id),
    });
  }

  // 2. Menstrual Cycles (patient_reported)
  const band =
    patient.year_of_birth != null
      ? cycleBand(
          pcosContext(
            Number(patient.year_of_birth),
            new Date().getFullYear(),
            patient.menarche_year != null ? Number(patient.menarche_year) : null,
          ).gynAge,
        )
      : null;
  for (const c of cycles) {
    entries.push({
      id: `cyc:${String(c.id)}`,
      category: "menstrual_cycle",
      pathway: primaryPathway === "pcos" || primaryPathway === "endometriosis" ? primaryPathway : "general",
      observedOn: String(c.start_date).slice(0, 10),
      recordedAt: String(c.start_date),
      summary: `Menstrual cycle: ${String(c.length_days)} days (${String(c.flow)})`,
      detail: `${String(c.note || "")}${band && band.status === "band" ? ` [Guideline reference band: ${band.label}]` : ""}`,
      evidenceTier: "patient_reported",
      reviewStatus: "unreviewed",
      reviewedBy: null,
      sourceRefId: String(c.id),
    });
  }

  // 3. Laboratory Results
  for (const l of labs) {
    entries.push({
      id: `lab:${String(l.id)}`,
      category: "laboratory",
      pathway: primaryPathway === "pcos" ? "pcos" : "general",
      observedOn: String(l.observed_on).slice(0, 10),
      recordedAt: String(l.observed_on),
      summary: `Lab: ${String(l.analyte)} = ${String(l.value_text)} ${String(l.unit)}`,
      detail: `Reference: ${String(l.reference_text || "not stated")}. ${String(l.source_note || "")}`,
      evidenceTier: "clinician_reviewed",
      reviewStatus: "clinician_reviewed",
      reviewedBy: null,
      sourceRefId: String(l.id),
    });
  }

  // 4. Imaging Studies (imaging_observation)
  for (const st of studies) {
    entries.push({
      id: `study:${String(st.id)}`,
      category: "imaging_study",
      pathway: primaryPathway,
      observedOn: String(st.study_date).slice(0, 10),
      recordedAt: String(st.study_date),
      summary: `Imaging study (${String(st.modality)}): ${String(st.description)}`,
      detail: String(st.source_note || ""),
      evidenceTier: "imaging_observation",
      reviewStatus: "clinician_reviewed",
      reviewedBy: null,
      sourceRefId: String(st.id),
    });
  }

  // 5. Clinical Reports (report_extracted / clinician_reviewed)
  for (const rp of reports) {
    const revStatus = (rp.review_status as string) || "unreviewed";
    const isReviewed = revStatus === "reviewed" || revStatus === "corrected";
    entries.push({
      id: `report:${String(rp.id)}`,
      category: "clinical_report",
      pathway: primaryPathway,
      observedOn: String(rp.report_date).slice(0, 10),
      recordedAt: String(rp.report_date),
      summary: `Clinical report (${String(rp.author_role)})`,
      detail: String(rp.body).slice(0, 240),
      evidenceTier: isReviewed ? "clinician_reviewed" : "report_extracted",
      reviewStatus: isReviewed ? "clinician_reviewed" : "unreviewed",
      reviewedBy: (rp.reviewed_by as string | null) ?? null,
      sourceRefId: String(rp.id),
    });
  }

  // 6. Anatomical Finding Versions (distinguishing ai_experimental vs imaging_observation vs clinician_reviewed)
  const verifiedVersionIds = new Set(
    reviews
      .filter((r) => r.target_type === "finding_version" && r.status === "verified")
      .map((r) => String(r.target_id)),
  );
  for (const fv of versions) {
    const vid = String(fv.id);
    const segSource = String(fv.segmentation_source ?? "");
    const isVerified = verifiedVersionIds.has(vid) || segSource === "clinician_edit";
    const isAi = /unet|ai|model/i.test(segSource) && !isVerified;
    const tier: ConditionEvidenceTier = isVerified
      ? "clinician_reviewed"
      : isAi
        ? "ai_experimental"
        : "imaging_observation";

    entries.push({
      id: `fv:${vid}`,
      category: "anatomical_finding",
      pathway: (fv.finding_pathway as UnifiedHistoryEntry["pathway"]) || primaryPathway,
      observedOn: String(fv.observed_on).slice(0, 10),
      recordedAt: String(fv.observed_on),
      summary: `Finding ${String(fv.finding_code)} v${String(fv.version_no)}: ${String(fv.structure)} (${String(fv.location_label)})`,
      detail: `Longest: ${fv.longest_mm ?? "—"} mm; FIGO: ${fv.figo ?? "not stated"}; source: ${segSource}`,
      evidenceTier: tier,
      reviewStatus: isVerified ? "clinician_reviewed" : "unreviewed",
      reviewedBy: null,
      sourceRefId: vid,
    });
  }

  // 7. Condition-Specific Pathway Records (Fibroids, Endometriosis, Ovarian Cyst, PCOS)
  for (const fa of fibroidAssessments) {
    entries.push({
      id: `fib:${fa.id}`,
      category: "pathway_fibroids",
      pathway: "fibroids",
      observedOn: fa.created_at.slice(0, 10),
      recordedAt: fa.created_at,
      summary: `Fibroid pathway: ${fa.anatomical_location}${fa.figo_classification ? ` (FIGO ${fa.figo_classification})` : " (FIGO not assigned)"}`,
      detail: `Longest: ${fa.longest_mm ?? "—"} mm; Volume: ${fa.volume_mm3 ?? "—"} mm³; Status: ${fa.review_status}`,
      evidenceTier: fa.evidence_tier,
      reviewStatus: fa.review_status,
      reviewedBy: fa.reviewed_by,
      sourceRefId: fa.id,
    });
  }

  const endometriosisRecords: EndometriosisPathwayRecord[] = endoRows.map((r) => {
    const sites = r.lesion_sites_json ? (JSON.parse(String(r.lesion_sites_json)) as string[]) : [];
    const tier = ((r.evidence_tier as ConditionEvidenceTier) ?? "clinician_reviewed");
    const revStatus = ((r.review_status as ClinicalReviewStatus) ?? "unreviewed");
    const mapped: EndometriosisPathwayRecord = {
      id: String(r.id),
      user_id: String(r.user_id),
      patient_id: String(r.patient_id),
      study_id: (r.study_id as string | null) ?? null,
      report_id: (r.report_id as string | null) ?? null,
      lesion_sites: sites,
      lesion_sites_json: String(r.lesion_sites_json ?? "[]"),
      imaging_status:
        (r.imaging_status as EndometriosisPathwayRecord["imaging_status"]) ??
        "clinician_reported_finding",
      normal_imaging_excludes_endometriosis: false,
      normal_imaging_limitation_note:
        (r.normal_imaging_limitation_note as string) || ENDOMETRIOSIS_NORMAL_IMAGING_LIMITATION,
      symptom_infers_lesion_location: false,
      surgical_history: String(r.surgical_history ?? ""),
      surgical_confirmation_status:
        (r.surgical_confirmation_status as EndometriosisPathwayRecord["surgical_confirmation_status"]) ??
        "not_performed",
      staging_rASRM: (r.staging_rASRM as string | null) ?? null,
      imaging_note: String(r.imaging_note ?? ""),
      symptom_history: r.symptom_history_json
        ? (JSON.parse(String(r.symptom_history_json)) as string[])
        : [],
      menstrual_history_note: (r.menstrual_history_note as string | null) ?? null,
      historical_comparison_note: (r.historical_comparison_note as string | null) ?? null,
      evidence_tier: tier,
      review_status: revStatus,
      reviewed_by: (r.reviewed_by as string | null) ?? null,
      reviewed_at: (r.reviewed_at as string | null) ?? null,
      review_note: (r.review_note as string | null) ?? null,
      created_at: String(r.created_at),
    };
    entries.push({
      id: `endo:${mapped.id}`,
      category: "pathway_endometriosis",
      pathway: "endometriosis",
      observedOn: mapped.created_at.slice(0, 10),
      recordedAt: mapped.created_at,
      summary: `Endometriosis pathway (${mapped.imaging_status}): ${sites.join(", ") || "no visible lesion on imaging"}`,
      detail: `${mapped.imaging_note} [${mapped.normal_imaging_limitation_note}]`,
      evidenceTier: mapped.evidence_tier,
      reviewStatus: mapped.review_status,
      reviewedBy: mapped.reviewed_by,
      sourceRefId: mapped.id,
    });
    return mapped;
  });

  const ovarianCystRecords: OvarianCystPathwayRecord[] = cystRows.map((r) => {
    const tier = ((r.evidence_tier as ConditionEvidenceTier) ?? "imaging_observation");
    const revStatus = ((r.review_status as ClinicalReviewStatus) ?? "unreviewed");
    const mapped: OvarianCystPathwayRecord = {
      id: String(r.id),
      user_id: String(r.user_id),
      patient_id: String(r.patient_id),
      study_id: (r.study_id as string | null) ?? null,
      report_id: (r.report_id as string | null) ?? null,
      laterality: (r.laterality as "left" | "right" | "bilateral") ?? "left",
      anatomical_location: String(r.anatomical_location ?? `${String(r.laterality)} ovary`),
      max_diameter_mm: Number(r.max_diameter_mm),
      axes_mm: r.axes_mm_json ? (JSON.parse(String(r.axes_mm_json)) as [number, number, number]) : null,
      morphology_category:
        (r.morphology_category as CystMorphologyCategory) ?? "simple_unilocular",
      features_text: String(r.features_text ?? ""),
      uncertainty_flag: Boolean(r.uncertainty_flag),
      uncertainty_note: (r.uncertainty_note as string | null) ?? null,
      benign_malignant_classified: false,
      historical_comparison: r.historical_comparison_json
        ? (JSON.parse(String(r.historical_comparison_json)) as OvarianCystPathwayRecord["historical_comparison"])
        : null,
      associated_symptoms: r.associated_symptoms_json
        ? (JSON.parse(String(r.associated_symptoms_json)) as string[])
        : [],
      follow_up_months: r.follow_up_months != null ? Number(r.follow_up_months) : null,
      clinical_note: String(r.clinical_note ?? ""),
      evidence_tier: tier,
      review_status: revStatus,
      reviewed_by: (r.reviewed_by as string | null) ?? null,
      reviewed_at: (r.reviewed_at as string | null) ?? null,
      review_note: (r.review_note as string | null) ?? null,
      created_at: String(r.created_at),
    };
    entries.push({
      id: `cyst:${mapped.id}`,
      category: "pathway_ovarian_cyst",
      pathway: "cyst",
      observedOn: mapped.created_at.slice(0, 10),
      recordedAt: mapped.created_at,
      summary: `Ovarian cyst pathway (${mapped.laterality}, ${mapped.max_diameter_mm} mm): ${mapped.morphology_category}`,
      detail: `${mapped.features_text}${mapped.uncertainty_flag ? ` [Uncertain: ${mapped.uncertainty_note}]` : ""}`,
      evidenceTier: mapped.evidence_tier,
      reviewStatus: mapped.review_status,
      reviewedBy: mapped.reviewed_by,
      sourceRefId: mapped.id,
    });
    return mapped;
  });

  const pcosAssessments: PcosPathwayRecord[] = pcosRows.map((r) => {
    const tier = ((r.evidence_tier as ConditionEvidenceTier) ?? "clinician_reviewed");
    const revStatus = ((r.review_status as ClinicalReviewStatus) ?? "unreviewed");
    const cohort =
      (r.assessment_cohort as PcosPathwayRecord["assessment_cohort"]) ?? "adult";
    const mapped: PcosPathwayRecord = {
      id: String(r.id),
      user_id: String(r.user_id),
      patient_id: String(r.patient_id),
      study_id: (r.study_id as string | null) ?? null,
      assessment_cohort: cohort,
      gynecological_age_years:
        r.gynecological_age_years != null ? Number(r.gynecological_age_years) : null,
      adult_criteria_allowed:
        r.adult_criteria_allowed !== undefined ? Boolean(r.adult_criteria_allowed) : cohort === "adult",
      ultrasound_used_as_supporting_only: true,
      diagnosis_from_ovarian_appearance_alone_blocked: true,
      cycle_irregularity: Boolean(r.cycle_irregularity),
      hyperandrogenism_clinical: Boolean(r.hyperandrogenism_clinical),
      hyperandrogenism_biochemical: Boolean(r.hyperandrogenism_biochemical),
      ultrasound_or_amh_features: Boolean(r.ultrasound_or_amh_features),
      rotterdam_criteria_met: Boolean(r.rotterdam_criteria_met),
      exclusion_mimickers_checked: Boolean(r.exclusion_mimickers_checked),
      hormone_labs: r.hormone_labs_json
        ? (JSON.parse(String(r.hormone_labs_json)) as PcosHormoneLabs)
        : {},
      metabolic_context: r.metabolic_context_json
        ? (JSON.parse(String(r.metabolic_context_json)) as PcosMetabolicContext)
        : {},
      guideline_headline:
        cohort === "adult"
          ? "Adult Rotterdam 2003 / 2023 international guideline context"
          : "Adolescent / <8y post-menarche guideline safeguard: adult Rotterdam & ultrasound PCOM criteria not applied",
      notes: String(r.notes ?? ""),
      evidence_tier: tier,
      review_status: revStatus,
      clinically_confirmed: revStatus === "clinician_confirmed_assessment",
      reviewed_by: (r.reviewed_by as string | null) ?? null,
      reviewed_at: (r.reviewed_at as string | null) ?? null,
      review_note: (r.review_note as string | null) ?? null,
      created_at: String(r.created_at),
    };
    entries.push({
      id: `pcos:${mapped.id}`,
      category: "pathway_pcos",
      pathway: "pcos",
      observedOn: mapped.created_at.slice(0, 10),
      recordedAt: mapped.created_at,
      summary: `PCOS pathway (${mapped.assessment_cohort}): Rotterdam ${mapped.rotterdam_criteria_met ? "Met" : "Not Met"}`,
      detail: `${mapped.guideline_headline}. ${mapped.notes}`,
      evidenceTier: mapped.evidence_tier,
      reviewStatus: mapped.review_status,
      reviewedBy: mapped.reviewed_by,
      sourceRefId: mapped.id,
    });
    return mapped;
  });

  // Sort unified timeline descending by observedOn
  entries.sort((a, b) => b.observedOn.localeCompare(a.observedOn));

  const evidenceTierCounts: Record<ConditionEvidenceTier, number> = {
    patient_reported: 0,
    imaging_observation: 0,
    report_extracted: 0,
    ai_experimental: 0,
    clinician_reviewed: 0,
    clinician_confirmed_assessment: 0,
  };
  for (const e of entries) {
    evidenceTierCounts[e.evidenceTier] = (evidenceTierCounts[e.evidenceTier] ?? 0) + 1;
  }

  void findings;

  return {
    patient: {
      id: patient.id,
      code: patient.code,
      displayName: patient.display_name,
      yearOfBirth: patient.year_of_birth != null ? Number(patient.year_of_birth) : null,
      menarcheYear: patient.menarche_year != null ? Number(patient.menarche_year) : null,
      primaryPathway: patient.pathway,
      synopsis: patient.synopsis,
    },
    evidenceTierCounts,
    entries,
    fibroidAssessments,
    endometriosisRecords,
    ovarianCystRecords,
    pcosAssessments,
  };
}
