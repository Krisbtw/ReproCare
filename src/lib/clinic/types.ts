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
  category: string;
  score: number | null;
  rationale: string;
  provisional: boolean;
  engine_version: string;
  active: boolean;
  created_at: string;
};

export type DecisionRow = {
  id: string;
  user_id: string;
  correspondence_id: string;
  decision: string;
  note: string;
  created_at: string;
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
};

export type ReviewRow = {
  id: string;
  user_id: string;
  target_type: string;
  target_id: string;
  status: string;
  note: string;
  created_at: string;
};

export type ConsentRow = {
  id: string;
  user_id: string;
  patient_id: string;
  purpose: string;
  granted: boolean;
  note: string;
  created_at: string;
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

export type ModelRow = { id: string; name: string; status: string; note: string };

export type Workspace = {
  profile: { user_id: string; display_name: string; role: string; active_patient_id: string | null };
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
  models: ModelRow[];
  engineVersion: string;
};

export type ExportPayload = {
  warning: string;
  patient: PatientRow;
  studies: StudyRow[];
  findings: FindingRow[];
  versions: VersionRow[];
};
