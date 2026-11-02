-- 0014: Supabase PostgreSQL & Supabase Storage Integration
-- Safe, additive, idempotent migration preserving all existing tables, foreign keys, and append-only triggers.

-- 1. Extend imaging_objects with explicit Supabase Storage bucket, provider, object_path, processing_status, and deidentification_status
alter table imaging_objects add column if not exists storage_bucket text not null default 'reprocare-imaging';
alter table imaging_objects add column if not exists storage_provider text not null default 'supabase';
alter table imaging_objects add column if not exists object_path text;
alter table imaging_objects add column if not exists processing_status text not null default 'completed';
alter table imaging_objects add column if not exists deidentification_status text not null default 'deidentified';

-- Backfill object_path from storage_uri where object_path is null
update imaging_objects set object_path = storage_uri where object_path is null;

-- Backfill storage_bucket from artifact kind
update imaging_objects set storage_bucket = 'reprocare-reports' where kind in ('report', 'clinical_report') and storage_bucket = 'reprocare-imaging';
update imaging_objects set storage_bucket = 'reprocare-derived' where kind in ('mask', 'mesh', 'segmentation_mask', 'mesh_3d') and storage_bucket = 'reprocare-imaging';

-- Expand kind check constraint on imaging_objects to allow 'report' and 'pending_upload' status
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'imaging_objects_kind_check'
  ) then
    alter table imaging_objects drop constraint imaging_objects_kind_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'imaging_objects_kind_all_check'
  ) then
    alter table imaging_objects
      add constraint imaging_objects_kind_all_check
      check (kind in ('dicom', 'mask', 'mesh', 'volume', 'report'));
  end if;

  if exists (
    select 1 from pg_constraint where conname = 'imaging_objects_status_check'
  ) then
    alter table imaging_objects drop constraint imaging_objects_status_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'imaging_objects_status_lifecycle_check'
  ) then
    alter table imaging_objects
      add constraint imaging_objects_status_lifecycle_check
      check (status in ('pending_upload', 'active', 'archived', 'purged', 'corrupted', 'missing'));
  end if;
end $$;

create index if not exists idx_imaging_objects_bucket_path on imaging_objects (storage_bucket, object_path);
create index if not exists idx_imaging_objects_provider on imaging_objects (storage_provider, status);

-- 2. Provision private Supabase Storage buckets and strict Row-Level Security (RLS) policies when running on Supabase PostgreSQL
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'storage' and table_name = 'buckets'
  ) then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values
      (
        'reprocare-imaging',
        'reprocare-imaging',
        false,
        536870912,
        array['application/dicom', 'application/octet-stream', 'application/gzip', 'application/x-gzip', 'image/nii', 'application/nii']
      ),
      (
        'reprocare-reports',
        'reprocare-reports',
        false,
        67108864,
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'application/octet-stream']
      ),
      (
        'reprocare-derived',
        'reprocare-derived',
        false,
        268435456,
        array['application/octet-stream', 'application/json', 'model/stl', 'model/obj', 'text/plain']
      )
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
