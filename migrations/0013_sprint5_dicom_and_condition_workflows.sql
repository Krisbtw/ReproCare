-- Sprint 5: DICOM Interoperability Metadata & Condition-Specific Healthcare Workflows
-- Safe, additive, reversible migration preserving all existing records and append-only audit tables.

-- 1. Extend dicom_uploads and series with transfer syntax, multi-frame, patient position, and geometry validation metadata
alter table dicom_uploads add column if not exists number_of_frames integer default 1;
alter table dicom_uploads add column if not exists patient_position text;
alter table dicom_uploads add column if not exists geometry_valid boolean default true;
alter table dicom_uploads add column if not exists compression_kind text default 'uncompressed';

alter table series add column if not exists transfer_syntax_uid text;
alter table series add column if not exists number_of_frames integer default 1;
alter table series add column if not exists patient_position text;
alter table series add column if not exists origin_lps_json text;
alter table series add column if not exists direction_cosines_json text;
alter table series add column if not exists series_consistency_json text;

-- 2. ExtendUterine Fibroid pathway assessments (clinician-reviewed FIGO, source image & report links, 6-tier provenance)
create table if not exists pathway_fibroid_assessments (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  finding_id text references findings (id) on delete set null,
  finding_version_id text references finding_versions (id) on delete set null,
  study_id text references studies (id) on delete set null,
  report_id text references reports (id) on delete set null,
  anatomical_location text not null,
  figo_classification text,
  figo_source text not null default 'not_assigned',
  axes_mm_json text,
  longest_mm double precision,
  volume_mm3 double precision,
  volume_estimation_method text,
  segmentation_source text,
  associated_symptoms_json text not null default '[]',
  longitudinal_comparison_note text,
  evidence_tier text not null default 'imaging_observation'
    check (evidence_tier in (
      'patient_reported',
      'imaging_observation',
      'report_extracted',
      'ai_experimental',
      'clinician_reviewed',
      'clinician_confirmed_assessment'
    )),
  review_status text not null default 'unreviewed'
    check (review_status in ('unreviewed', 'clinician_reviewed', 'clinician_confirmed_assessment', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pathway_fibroid_patient on pathway_fibroid_assessments (patient_id, created_at desc);

-- 3. Extend pathway_endometriosis_records with imaging exam link, normal-imaging safeguard, surgical status, and 6-tier review provenance
alter table pathway_endometriosis_records add column if not exists study_id text;
alter table pathway_endometriosis_records add column if not exists report_id text;
alter table pathway_endometriosis_records add column if not exists imaging_status text default 'clinician_reported_finding';
alter table pathway_endometriosis_records add column if not exists normal_imaging_limitation_note text;
alter table pathway_endometriosis_records add column if not exists surgical_confirmation_status text default 'not_performed';
alter table pathway_endometriosis_records add column if not exists symptom_history_json text default '[]';
alter table pathway_endometriosis_records add column if not exists menstrual_history_note text;
alter table pathway_endometriosis_records add column if not exists historical_comparison_note text;
alter table pathway_endometriosis_records add column if not exists evidence_tier text default 'clinician_reviewed';
alter table pathway_endometriosis_records add column if not exists review_status text default 'unreviewed';
alter table pathway_endometriosis_records add column if not exists reviewed_by text;
alter table pathway_endometriosis_records add column if not exists reviewed_at timestamptz;
alter table pathway_endometriosis_records add column if not exists review_note text;

-- 4. Extend pathway_ovarian_cyst_records with anatomical location, 3-axis dimensions, morphology category, uncertainty flags, and review provenance
alter table pathway_ovarian_cyst_records add column if not exists study_id text;
alter table pathway_ovarian_cyst_records add column if not exists report_id text;
alter table pathway_ovarian_cyst_records add column if not exists anatomical_location text default 'ovary';
alter table pathway_ovarian_cyst_records add column if not exists axes_mm_json text;
alter table pathway_ovarian_cyst_records add column if not exists morphology_category text default 'simple_unilocular';
alter table pathway_ovarian_cyst_records add column if not exists uncertainty_flag boolean default false;
alter table pathway_ovarian_cyst_records add column if not exists uncertainty_note text;
alter table pathway_ovarian_cyst_records add column if not exists historical_comparison_json text;
alter table pathway_ovarian_cyst_records add column if not exists associated_symptoms_json text default '[]';
alter table pathway_ovarian_cyst_records add column if not exists evidence_tier text default 'imaging_observation';
alter table pathway_ovarian_cyst_records add column if not exists review_status text default 'unreviewed';
alter table pathway_ovarian_cyst_records add column if not exists reviewed_by text;
alter table pathway_ovarian_cyst_records add column if not exists reviewed_at timestamptz;
alter table pathway_ovarian_cyst_records add column if not exists review_note text;

-- 5. Extend pathway_pcos_assessments with adult vs adolescent cohort, hormone & exclusion labs, metabolic context, and clinician review provenance
alter table pathway_pcos_assessments add column if not exists assessment_cohort text default 'adult';
alter table pathway_pcos_assessments add column if not exists gynecological_age_years integer;
alter table pathway_pcos_assessments add column if not exists adult_criteria_allowed boolean default true;
alter table pathway_pcos_assessments add column if not exists ultrasound_used_as_supporting_only boolean default true;
alter table pathway_pcos_assessments add column if not exists hormone_labs_json text default '{}';
alter table pathway_pcos_assessments add column if not exists metabolic_context_json text default '{}';
alter table pathway_pcos_assessments add column if not exists exclusion_mimickers_checked boolean default false;
alter table pathway_pcos_assessments add column if not exists study_id text;
alter table pathway_pcos_assessments add column if not exists evidence_tier text default 'clinician_reviewed';
alter table pathway_pcos_assessments add column if not exists review_status text default 'unreviewed';
alter table pathway_pcos_assessments add column if not exists reviewed_by text;
alter table pathway_pcos_assessments add column if not exists reviewed_at timestamptz;
alter table pathway_pcos_assessments add column if not exists review_note text;
