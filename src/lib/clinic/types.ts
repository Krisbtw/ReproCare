export type PatientRow = {
  id: string;
  user_id: string;
  code: string;
  display_name: string;
  year_of_birth: number | null;
  /** Year of first period (migration 0004). Year only; null when not recorded. */
  menarche_year: number | null;
  pathway: string;
  synopsis: string;
  is_self: boolean;
  synthetic: boolean;
};

export type StudyRow = {
  id: string;
  user_id: string;
  patient_id: string;
  modality: string;
  study_date: string;
  description: string;
  accession: string;
  synthetic: boolean;
  source_note: string;
  quote_start?: number | null;
  quote_end?: number | null;
};

export type SeriesRow = {
  id: string;
  user_id: string;
  study_id: string;
  series_number: number;
  description: string;
  plane: string | null;
  slice_thickness_mm: number | null;
  pixel_spacing_mm: string | null;
  slice_count: number | null;
  quality: string;
};

export type ReportRow = {
  id: string;
  user_id: string;
  study_id: string;
  report_date: string;
  author_role: string;
  body: string;
  synthetic: boolean;
  source_kind?: string;
};

export type FindingRow = {
  id: string;
  user_id: string;
  patient_id: string;
  code: string;
  structure: string;
  organ: string;
  pathway: string;
};

export type VersionRow = {
  id: string;
  user_id: string;
  finding_id: string;
  version_no: number;
  previous_version_id: string | null;
  study_id: string;
  series_id?: string | null;
  observed_on: string;
  location_label: string;
  figo: string | null;
  centroid_mm: number[] | string | null;
  axes_mm: number[] | string | null;
  longest_mm: number | null;
  measurement_basis: string;
  frame: string;
  segmentation_source: string;
  model_id: string | null;
  quality: string;
  modality: string;
  report_longest_mm: number | null;
  change_reason: string;
  created_at: string;
};

export type EvidenceRow = {
  id: string;
  user_id: string;
  finding_version_id: string;
  kind: string;
  study_id: string | null;
  series_id: string | null;
  report_id: string | null;
  quote: string | null;
  slice_index: number | null;
  note: string;
};

export type SymptomRow = {
  id: string;
  user_id: string;
  patient_id: string;
  recorded_on: string;
  region: string;
  intensity: number;
  cycle_day: number | null;
  description: string;
  source: string;
};

export type CycleRow = {
  id: string;
  user_id: string;
  patient_id: string;
  start_date: string;
  length_days: number | null;
  flow: string | null;
  note: string;
};

export type LabRow = {
  id: string;
  user_id: string;
  patient_id: string;
  observed_on: string;
  analyte: string;
  value_text: string;
  unit: string;
  reference_text: string | null;
  source_note: string;
};

export type CorrespondenceRow = {
  id: string;
  user_id: string;
  patient_id: string;
  from_version_id: string | null;
  to_version_id: string | null;
  from_study_id: string | null;
  to_study_id: string | null;
  from_series_id?: string | null;
  to_series_id?: string | null;
  registration_id?: string | null;
  registration_status?: string | null;
  registration_ncc?: number | null;
  registration_residual_mm?: number | null;
  category: string;
  score: number | null;
  rationale: string;
  provisional: boolean;
  engine_version: string;
  active: boolean;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type DecisionRow = {
  id: string;
  user_id: string;
  correspondence_id: string;
  decision: string;
  note: string;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type DiscrepancyRow = {
  id: string;
  user_id: string;
  patient_id: string;
  category: string;
  summary: string;
  detail: string;
  left_ref: string | null;
  right_ref: string | null;
  engine_version: string;
  active: boolean;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type ReviewRow = {
  id: string;
  user_id: string;
  target_type: string;
  target_id: string;
  status: string;
  note: string;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type ConsentRow = {
  id: string;
  user_id: string;
  patient_id: string;
  purpose: string;
  granted: boolean;
  note: string;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type UploadRow = {
  id: string;
  patient_id: string | null;
  received_at: string;
  file_name: string;
  transfer_syntax: string | null;
  metadata: string;
  warnings: string;
  identifiers_withheld: boolean;
};

export type AuditRow = {
  id: string;
  user_id: string;
  at: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: string;
};

export type ExtractionRow = {
  id: string;
  report_id: string;
  file_name: string;
  file_kind: string;
  content_sha256: string;
  deid_method: string;
  redaction_count: number;
  redaction_kinds: string;
  extractor: string;
  /** JSON of reports/extract.ts Extraction. */
  extraction: string;
  warnings: string;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type ModelRow = { id: string; name: string; status: string; note: string };

export type ClinicianVerificationStatus =
  | "pending"
  | "verified"
  | "approved"
  | "rejected"
  | "suspended"
  | "revoked";

export type ClinicianVerificationRow = {
  id: string;
  user_id: string;
  licence_no: string;
  registry: string;
  evidence_note: string;
  status: ClinicianVerificationStatus;
  decided_by: string | null;
  decided_at: string | null;
  reason: string;
  requested_at: string;
  display_name?: string;
  current_role?: string;
};

export type RegistrationRow = {
  id: string;
  user_id: string;
  patient_id: string;
  fixed_study_id?: string | null;
  moving_study_id?: string | null;
  fixed_series_id: string;
  moving_series_id: string;
  ncc_score: number;
  residual_mm: number;
  transform_matrix_json: string;
  status: "verified" | "unverified" | "failed";
  quality_note?: string;
  matrix_valid?: boolean;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type FibroidAssessmentItem = {
  id: string;
  user_id?: string;
  patient_id?: string;
  finding_id: string | null;
  finding_version_id: string | null;
  study_id: string | null;
  report_id: string | null;
  anatomical_location: string;
  figo_classification: string | null;
  figo_source: string;
  axes_mm_json: string | null;
  longest_mm: number | null;
  volume_mm3: number | null;
  volume_estimation_method: string | null;
  segmentation_source: string | null;
  associated_symptoms_json: string;
  longitudinal_comparison_note: string | null;
  evidence_tier: string;
  review_status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};

export type EndometriosisRecordItem = {
  id: string;
  patient_id?: string;
  lesion_sites_json: string;
  surgical_history: string;
  staging_rASRM: string | null;
  imaging_note: string;
  created_at: string;
};

export type OvarianCystRecordItem = {
  id: string;
  patient_id?: string;
  laterality: "left" | "right" | "bilateral";
  max_diameter_mm: number;
  features_text: string;
  follow_up_months: number | null;
  clinical_note: string;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type PcosAssessmentItem = {
  id: string;
  patient_id?: string;
  cycle_irregularity: boolean;
  hyperandrogenism_clinical: boolean;
  hyperandrogenism_biochemical: boolean;
  ultrasound_or_amh_features: boolean;
  rotterdam_criteria_met: boolean;
  notes: string;
  created_at: string;
  review_status?: string;
  extraction_method?: string;
  version_no?: number;
  report_object_id?: string | null;
};

export type Workspace = {
  profile: {
    user_id: string;
    display_name: string;
    role: string;
    stored_role?: string;
    verification_status?: string;
    is_verified_clinician?: boolean;
    active_patient_id: string | null;
  };
  patients: PatientRow[];
  studies: StudyRow[];
  series: SeriesRow[];
  reports: ReportRow[];
  findings: FindingRow[];
  versions: VersionRow[];
  evidence: EvidenceRow[];
  symptoms: SymptomRow[];
  cycles: CycleRow[];
  labs: LabRow[];
  correspondences: CorrespondenceRow[];
  decisions: DecisionRow[];
  discrepancies: DiscrepancyRow[];
  reviews: ReviewRow[];
  consents: ConsentRow[];
  uploads: UploadRow[];
  audit: AuditRow[];
  extractions: ExtractionRow[];
  models: ModelRow[];
  verifications?: ClinicianVerificationRow[];
  registrations?: RegistrationRow[];
  fibroidAssessments?: FibroidAssessmentItem[];
  endometriosisRecords?: EndometriosisRecordItem[];
  ovarianCystRecords?: OvarianCystRecordItem[];
  pcosAssessments?: PcosAssessmentItem[];
  clinicianConsents?: Array<{
    id: string;
    patient_id: string;
    patient_user_id: string;
    clinician_user_id: string;
    clinician_display_name?: string | null;
    clinician_licence_no?: string | null;
    clinician_registry?: string | null;
    clinician_verification_status?: string | null;
    patient_display_name?: string | null;
    patient_code?: string | null;
    status: "active" | "revoked" | "expired";
    permissions: string[];
    permissions_json: string;
    scope_note: string;
    granted_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    revoked_reason: string | null;
    updated_at: string;
  }>;
  availableClinicians?: Array<{
    user_id: string;
    display_name: string;
    licence_no: string;
    registry: string;
    status: string;
  }>;
  consentAccessLogs?: Array<{
    id: string;
    consent_id: string | null;
    patient_id: string;
    patient_user_id: string;
    actor_user_id: string;
    actor_role: string;
    action: string;
    permission_checked: string | null;
    outcome: "allowed" | "denied";
    detail: string;
    created_at: string;
  }>;
  engineVersion: string;
  /** ReproTrace computation runs (live recomputes), newest first. */
  reprotraceRuns?: Array<Record<string, string | number | boolean | null>>;
  /** Clinician decisions on extracted report observations (append-only). */
  observationLinks?: Array<Record<string, string | number | boolean | null>>;
  /** Discrepancy reviews joined to the compared pair (left_ref/right_ref), across recomputes. */
  discrepancyReviewHistory?: Array<Record<string, string | number | boolean | null>>;
  /** Present when the connected database is missing columns/tables the code expects (unapplied migrations). */
  schemaWarnings?: string[];
};

export type ExportPayload = {
  warning: string;
  patient: PatientRow;
  studies: StudyRow[];
  findings: FindingRow[];
  versions: VersionRow[];
};

export const ALL_CLINICIAN_PERMISSIONS = [
  "view_demographics",
  "view_reports",
  "view_imaging",
  "view_findings",
  "view_longitudinal_history",
  "add_annotations",
  "review_ai_findings",
  "approve_or_reject_findings",
] as const;

export type ClinicianPermission = (typeof ALL_CLINICIAN_PERMISSIONS)[number];

export const DEFAULT_CLINICIAN_PERMISSIONS: readonly ClinicianPermission[] = [
  "view_demographics",
  "view_reports",
  "view_imaging",
  "view_findings",
  "view_longitudinal_history",
] as const;
