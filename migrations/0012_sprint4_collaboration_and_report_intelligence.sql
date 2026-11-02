-- 0012: Sprint 4 Patient-Clinician Collaboration, Granular Consent & Clinical Report Intelligence.
--
-- Reversible, additive schema migration:
--   1. Creates `patient_clinician_consents` for patient-controlled, granular, time-bounded
--      record sharing with verified clinicians, preventing self-grants.
--   2. Creates `consent_access_logs` for immutable audit tracking of consent lifecycle transitions
--      and permission-checked clinical accesses.
--   3. Extends `reports` and `report_extractions` with persistent original document object references
--      (`report_object_id`), page count, extraction method (`native_pdf_text`, `ocr_pdf`,
--      `hybrid_pdf_text_and_ocr`, `docx_xml`, `plain_text`), OCR review status, and structured
--      LLM interpretation JSON.
--   4. Creates `report_extraction_revisions` and `report_finding_reviews` to preserve historical
--      report extraction versions and clinician approval/rejection/editing provenance.

create table if not exists patient_clinician_consents (
  id text primary key,
  patient_id text not null references patients (id) on delete cascade,
  patient_user_id text not null,
  clinician_user_id text not null,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  permissions_json text not null default '["view_demographics","view_reports","view_imaging","view_findings","view_longitudinal_history"]',
  scope_note text not null default '',
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  updated_at timestamptz not null default now(),
  check (patient_user_id <> clinician_user_id)
);

create index if not exists idx_pcc_patient_id on patient_clinician_consents (patient_id, status);
create index if not exists idx_pcc_clinician_user_id on patient_clinician_consents (clinician_user_id, status);
create index if not exists idx_pcc_patient_user_id on patient_clinician_consents (patient_user_id);

create table if not exists consent_access_logs (
  id text primary key,
  consent_id text references patient_clinician_consents (id) on delete set null,
  patient_id text not null,
  patient_user_id text not null,
  actor_user_id text not null,
  actor_role text not null,
  action text not null,
  permission_checked text,
  outcome text not null check (outcome in ('allowed', 'denied')),
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_cal_patient_id on consent_access_logs (patient_id, created_at);
create index if not exists idx_cal_actor_user_id on consent_access_logs (actor_user_id, created_at);

alter table reports add column if not exists patient_id text references patients (id) on delete cascade;
alter table reports add column if not exists report_object_id text;
alter table reports add column if not exists version_no integer not null default 1;
alter table reports add column if not exists previous_report_id text;
alter table reports add column if not exists extraction_method text not null default 'plain_text';
alter table reports add column if not exists page_count integer not null default 1;
alter table reports add column if not exists ocr_used boolean not null default false;
alter table reports add column if not exists review_status text not null default 'unreviewed' check (review_status in ('unreviewed', 'reviewed', 'corrected', 'rejected'));
alter table reports add column if not exists reviewed_by text;
alter table reports add column if not exists reviewed_at timestamptz;

alter table report_extractions add column if not exists report_object_id text;
alter table report_extractions add column if not exists extraction_method text not null default 'plain_text';
alter table report_extractions add column if not exists page_count integer not null default 1;
alter table report_extractions add column if not exists pages_json text not null default '[]';
alter table report_extractions add column if not exists ocr_used boolean not null default false;
alter table report_extractions add column if not exists ocr_reviewed boolean not null default false;
alter table report_extractions add column if not exists llm_interpretation_json text;
alter table report_extractions add column if not exists review_status text not null default 'unreviewed';
alter table report_extractions add column if not exists reviewed_by text;
alter table report_extractions add column if not exists reviewed_at timestamptz;
alter table report_extractions add column if not exists version_no integer not null default 1;

create table if not exists report_extraction_revisions (
  id text primary key,
  report_id text not null references reports (id) on delete cascade,
  extraction_id text not null references report_extractions (id) on delete cascade,
  revision_no integer not null,
  editor_user_id text not null,
  action text not null check (action in ('initial_extract', 'ocr_review', 'edit_fields', 'approve_finding', 'reject_finding', 'llm_interpretation')),
  previous_extraction_json text,
  updated_extraction_json text not null,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_rer_report_id on report_extraction_revisions (report_id, revision_no);

create table if not exists report_finding_reviews (
  id text primary key,
  report_id text not null references reports (id) on delete cascade,
  extraction_id text not null references report_extractions (id) on delete cascade,
  patient_id text not null references patients (id) on delete cascade,
  finding_index integer not null,
  decision text not null check (decision in ('approved', 'rejected', 'edited')),
  reviewer_user_id text not null,
  linked_finding_id text,
  linked_version_id text,
  corrected_structure text,
  corrected_location text,
  corrected_figo text,
  corrected_axes_mm text,
  corrected_longest_mm double precision,
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_rfr_report_id on report_finding_reviews (report_id, finding_index);
