-- 0009: Persistent medical imaging, finding provenance, volume registration, and pathway records.

-- A. Extended DICOM metadata on studies and series
alter table studies add column if not exists study_instance_uid text;
alter table studies add column if not exists accession_number text;
alter table studies add column if not exists patient_position text;

alter table series add column if not exists series_instance_uid text;
alter table series add column if not exists frame_of_reference_uid text;
alter table series add column if not exists image_orientation_patient text;
alter table series add column if not exists image_position_first text;
alter table series add column if not exists image_position_last text;
alter table series add column if not exists geometry_json text;
alter table series add column if not exists volume_sha256 text;

-- B. Provenance and physical volume attributes on finding versions
alter table finding_versions add column if not exists series_id text;
alter table finding_versions add column if not exists volume_mm3 double precision;
alter table finding_versions add column if not exists volume_method text;
alter table finding_versions add column if not exists segmentation_run_id text;
alter table finding_versions add column if not exists uncertainty_mm3 double precision;

-- C. Persistent imaging objects (DICOM, segmentation masks, meshes)
create table if not exists imaging_objects (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  series_id text,
  kind text not null check (kind in ('dicom', 'mask', 'mesh', 'volume')),
  storage_uri text not null,
  sha256 text not null,
  bytes integer not null,
  version integer not null default 1,
  created_by text not null,
  retention_until timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists imaging_objects_patient_idx on imaging_objects (patient_id);
create index if not exists imaging_objects_series_idx on imaging_objects (series_id);

-- D. Provenance-tracked segmentation runs
create table if not exists segmentation_runs (
  id text primary key,
  user_id text not null,
  series_id text,
  model_id text not null,
  weights_sha256 text,
  params_json text not null default '{}',
  mask_object_id text,
  label_counts text not null default '{}',
  volume_mm3 double precision,
  status text not null default 'completed' check (status in ('pending', 'running', 'completed', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists segmentation_runs_series_idx on segmentation_runs (series_id);

-- E. Volume registrations across longitudinal studies
create table if not exists registrations (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  fixed_series_id text not null,
  moving_series_id text not null,
  ncc_score double precision not null,
  residual_mm double precision not null,
  transform_matrix_json text not null,
  status text not null check (status in ('verified', 'unverified', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists registrations_patient_idx on registrations (patient_id);

-- F. Structured clinical records for reproductive pathways
create table if not exists pathway_endometriosis_records (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  lesion_sites_json text not null default '[]',
  surgical_history text not null default '',
  staging_rASRM text,
  imaging_note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pathway_endo_patient_idx on pathway_endometriosis_records (patient_id);

create table if not exists pathway_ovarian_cyst_records (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  laterality text not null check (laterality in ('left', 'right', 'bilateral')),
  max_diameter_mm double precision not null,
  features_text text not null default '',
  follow_up_months integer,
  clinical_note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pathway_cyst_patient_idx on pathway_ovarian_cyst_records (patient_id);

create table if not exists pathway_pcos_assessments (
  id text primary key,
  user_id text not null,
  patient_id text not null references patients (id) on delete cascade,
  cycle_irregularity boolean not null default false,
  hyperandrogenism_clinical boolean not null default false,
  hyperandrogenism_biochemical boolean not null default false,
  ultrasound_or_amh_features boolean not null default false,
  rotterdam_criteria_met boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pathway_pcos_patient_idx on pathway_pcos_assessments (patient_id);

-- G. Extend append-only protection triggers to segmentation_runs and registrations
create or replace function ab_block_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'append-only: % cannot be updated (row %). Insert a new row instead.', tg_table_name, old.id
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'append-only: % rows cannot be deleted directly (row %).', tg_table_name, old.id
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  return null;
end;
$$;

create or replace function ab_block_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'append-only: % cannot be truncated.', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['segmentation_runs', 'registrations']
  loop
    execute format('drop trigger if exists %I on %I', t || '_append_only', t);
    execute format(
      'create trigger %I before update or delete on %I for each row execute function ab_block_mutation()',
      t || '_append_only', t);
    execute format('drop trigger if exists %I on %I', t || '_no_truncate', t);
    execute format(
      'create trigger %I before truncate on %I for each statement execute function ab_block_truncate()',
      t || '_no_truncate', t);
  end loop;
end $$;
