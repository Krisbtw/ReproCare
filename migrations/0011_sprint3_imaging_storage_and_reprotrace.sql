-- 0011: Sprint 3 Persistent Medical Imaging Storage & ReproTrace Longitudinal Provenance.
--
-- Reversible, additive schema migration:
--   1. Extends imaging_objects with study_id, finding_version_id, source_object_id,
--      sop_instance_uid, instance_number, mime_type, metadata_json, status, updated_at, and purged_at.
--   2. Extends evidence_links with imaging_object_id and mask_object_id so historical finding
--      versions can directly retrieve their source DICOM series/instances and segmentation masks.
--   3. Extends correspondences and discrepancies with longitudinal change attribution,
--      physical uncertainty (mm3 / mm), spatial distance (mm), elapsed days, and growth rate.

alter table imaging_objects add column if not exists study_id text references studies (id) on delete set null;
alter table imaging_objects add column if not exists finding_version_id text references finding_versions (id) on delete set null;
alter table imaging_objects add column if not exists source_object_id text;
alter table imaging_objects add column if not exists sop_instance_uid text;
alter table imaging_objects add column if not exists instance_number integer;
alter table imaging_objects add column if not exists mime_type text not null default 'application/octet-stream';
alter table imaging_objects add column if not exists original_filename text not null default '';
alter table imaging_objects add column if not exists metadata_json text not null default '{}';
alter table imaging_objects add column if not exists status text not null default 'active' check (status in ('active', 'archived', 'purged', 'corrupted', 'missing'));
alter table imaging_objects add column if not exists updated_at timestamptz not null default now();
alter table imaging_objects add column if not exists purged_at timestamptz;

create index if not exists idx_imaging_objects_study_id on imaging_objects (study_id);
create index if not exists idx_imaging_objects_finding_version_id on imaging_objects (finding_version_id);
create index if not exists idx_imaging_objects_sha256 on imaging_objects (sha256);

alter table evidence_links add column if not exists imaging_object_id text;
alter table evidence_links add column if not exists mask_object_id text;

alter table correspondences add column if not exists outcome_classification text;
alter table correspondences add column if not exists change_attribution text;
alter table correspondences add column if not exists attribution_category text;
alter table correspondences add column if not exists spatial_distance_mm double precision;
alter table correspondences add column if not exists distance_mm double precision;
alter table correspondences add column if not exists uncertainty_mm double precision;
alter table correspondences add column if not exists combined_uncertainty_mm3 double precision;
alter table correspondences add column if not exists volume_delta_pct double precision;
alter table correspondences add column if not exists days_between double precision;
alter table correspondences add column if not exists elapsed_days double precision;
alter table correspondences add column if not exists growth_rate_mm3_per_month double precision;

alter table discrepancies add column if not exists attribution_category text;
alter table discrepancies add column if not exists combined_uncertainty_mm3 double precision;
alter table discrepancies add column if not exists uncertainty_mm3 double precision;
alter table discrepancies add column if not exists volume_delta_pct double precision;
alter table discrepancies add column if not exists elapsed_days double precision;
alter table discrepancies add column if not exists growth_rate_mm3_per_month double precision;
