-- AnatomyBridge clinical record. Synthetic rows are inserted per signed-in user.
-- Imaging pixels are never stored here — only metadata and evidence references.

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
create index if not exists patients_user_idx on patients (user_id);

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
create index if not exists studies_patient_idx on studies (patient_id);

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

create table if not exists reports (
  id text primary key,
  user_id text not null,
  study_id text not null references studies (id) on delete cascade,
  report_date date not null,
  author_role text not null,
  body text not null,
  synthetic boolean not null default true
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
create index if not exists findings_patient_idx on findings (patient_id);

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
create index if not exists finding_versions_finding_idx on finding_versions (finding_id);

create table if not exists evidence_links (
  id text primary key,
  user_id text not null,
  finding_version_id text not null references finding_versions (id) on delete cascade,
  kind text not null,
  study_id text,
  series_id text,
  report_id text,
  quote text,
  slice_index integer,
  note text not null
);
create index if not exists evidence_version_idx on evidence_links (finding_version_id);

create table if not exists symptoms (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  recorded_on date not null,
  region text not null,
  intensity integer not null check (intensity between 0 and 10),
  cycle_day integer,
  description text not null,
  source text not null default 'patient_reported'
);

create table if not exists cycles (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  start_date date not null,
  length_days integer,
  flow text,
  note text not null
);

create table if not exists labs (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  observed_on date not null,
  analyte text not null,
  value_text text not null,
  unit text not null,
  reference_text text,
  source_note text not null
);

create table if not exists correspondences (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  from_version_id text references finding_versions (id) on delete cascade,
  to_version_id text references finding_versions (id) on delete cascade,
  from_study_id text,
  to_study_id text,
  category text not null,
  score double precision,
  rationale text not null,
  provisional boolean not null default true,
  engine_version text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists correspondences_patient_idx on correspondences (patient_id);

create table if not exists correspondence_decisions (
  id text primary key,
  user_id text not null,
  correspondence_id text not null references correspondences (id) on delete cascade,
  decision text not null check (decision in ('accept', 'reject', 'defer')),
  note text not null,
  created_at timestamptz not null default now()
);

create table if not exists discrepancies (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  category text not null,
  summary text not null,
  detail text not null,
  left_ref text,
  right_ref text,
  engine_version text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists reviews (
  id text primary key,
  user_id text not null,
  target_type text not null,
  target_id text not null,
  status text not null check (status in ('verified', 'rejected', 'needs_more_information')),
  note text not null,
  created_at timestamptz not null default now()
);
create index if not exists reviews_target_idx on reviews (target_type, target_id);

create table if not exists audit_events (
  id text primary key,
  user_id text not null,
  at timestamptz not null default now(),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  detail text not null
);
create index if not exists audit_user_idx on audit_events (user_id, at);

create table if not exists consents (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  purpose text not null,
  granted boolean not null,
  note text not null,
  created_at timestamptz not null default now()
);

create table if not exists dicom_uploads (
  id text primary key,
  user_id text not null,
  patient_id text references patients (id) on delete set null,
  received_at timestamptz not null default now(),
  file_name text not null,
  transfer_syntax text,
  metadata text not null,
  warnings text not null,
  identifiers_withheld boolean not null default true
);
